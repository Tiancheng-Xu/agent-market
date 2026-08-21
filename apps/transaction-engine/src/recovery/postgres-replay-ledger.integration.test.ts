import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresReplayLedger } from "./postgres-replay-ledger";
import { hashCanonicalJson, type ReplayClaimInput } from "./replay";

const adminUrl = process.env.T7_POSTGRES_ADMIN_URL;
const postgresDescribe = adminUrl === undefined ? describe.skip : describe;

postgresDescribe("PostgreSQL replay ledger integration", () => {
  const databaseName = `agent_market_t7_${randomUUID().replaceAll("-", "")}`;
  const ownershipMarker = randomUUID();
  let admin: Sql | undefined;
  let database: Sql | undefined;
  let databaseCreated = false;

  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) {
      throw new Error("T7_POSTGRES_ADMIN_URL must target a local PostgreSQL server");
    }
    admin = postgres(parsed.toString(), { max: 1, prepare: false });
    await admin`SELECT pg_advisory_lock(hashtext('agent-market-t7-replay-integration'))`;
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;

    parsed.pathname = `/${databaseName}`;
    const migrationDatabase = postgres(parsed.toString(), { max: 1, prepare: false });
    await migrationDatabase`
      CREATE TABLE public.t7_test_database_ownership (
        marker uuid PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await migrationDatabase`INSERT INTO public.t7_test_database_ownership (marker) VALUES (${ownershipMarker})`;
    const migration = readFileSync(
      new URL("../../../../database/migrations/0006_t7_recovery.sql", import.meta.url),
      "utf8",
    );
    await migrationDatabase.unsafe(migration);
    await migrationDatabase.end({ timeout: 5 });
    database = postgres(parsed.toString(), { max: 5, prepare: false });
  });

  afterAll(async () => {
    let cleanupError: Error | undefined;
    if (database !== undefined) {
      const rows = await database<{ marker: string }[]>`
        SELECT marker FROM public.t7_test_database_ownership
      `;
      if (rows.length !== 1 || rows[0]?.marker !== ownershipMarker) {
        cleanupError = new Error("Refusing cleanup: T7 database ownership marker mismatch");
        databaseCreated = false;
      }
      await database.end({ timeout: 5 });
    }
    if (admin !== undefined) {
      if (databaseCreated) {
        await admin`
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = ${databaseName} AND pid <> pg_backend_pid()
        `;
        await admin.unsafe(`DROP DATABASE "${databaseName}"`);
      }
      await admin`SELECT pg_advisory_unlock(hashtext('agent-market-t7-replay-integration'))`;
      await admin.end({ timeout: 5 });
    }
    if (cleanupError !== undefined) throw cleanupError;
  });

  it("applies the migration and rejects outbox bodies without bound identities", async () => {
    const columns = await database!<{ column_name: string }[]>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'agent_market'
        AND table_name = 'recovery_replay_outbox'
    `;
    expect(columns.map((row) => row.column_name)).toEqual(expect.arrayContaining([
      "attempt", "next_attempt_at", "lease_token", "lease_until",
    ]));

    const originalEventId = randomUUID();
    const requestId = randomUUID();
    await expect(database!.begin(async (transaction) => {
      await transaction`
        INSERT INTO agent_market.recovery_replays (
          original_event_id, original_request_id, replay_id,
          operator_idempotency_key, publisher_idempotency_key, original_body_hash
        ) VALUES (
          ${originalEventId}, ${requestId}, ${randomUUID()},
          'operator', ${`dlq-replay-v1:${originalEventId}`}, ${"a".repeat(64)}
        )
      `;
      await transaction`
        INSERT INTO agent_market.recovery_replay_outbox (
          original_event_id, original_request_id, event_body, publisher_idempotency_key
        ) VALUES (
          ${originalEventId}, ${requestId},
          ${transaction.json({ value: "missing identity" })},
          ${`dlq-replay-v1:${originalEventId}`}
        )
      `;
    })).rejects.toThrow();
  });

  it("serializes concurrent claims and reclaims an expired publishing lease", async () => {
    const ledger = new PostgresReplayLedger(database!);
    const originalEventId = randomUUID();
    const requestId = randomUUID();
    const input: ReplayClaimInput = {
      request: {
        replayId: randomUUID(),
        type: "dlq.replay.requested.v1",
        occurredAt: "2026-08-21T12:00:00.000Z",
        originalEventId,
        requestId,
        idempotencyKey: "postgres-integration",
        reason: "integration test",
      },
      original: {
        eventId: originalEventId,
        requestId,
        body: { eventId: originalEventId, requestId, value: "original" },
      },
      bodyHash: hashCanonicalJson({ eventId: originalEventId, requestId, value: "original" }),
      publisherIdempotencyKey: `dlq-replay-v1:${originalEventId}`,
    };
    await Promise.all([ledger.claim(input), ledger.claim(input)]);
    const now = new Date(Date.now() + 1_000);
    const claims = await Promise.all([
      ledger.claimOutbox({ originalEventId, now, leaseMs: 1_000 }),
      ledger.claimOutbox({ originalEventId, now, leaseMs: 1_000 }),
    ]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);

    const reclaimed = await ledger.claimOutbox({
      originalEventId,
      now: new Date(now.getTime() + 1_001),
      leaseMs: 1_000,
    });
    expect(reclaimed).toMatchObject({ attempt: 2, idempotencyKey: `dlq-replay-v1:${originalEventId}` });
    await ledger.markPublished(reclaimed!, new Date(now.getTime() + 1_002));
  });

  it("rolls back and fails closed when a non-identity body field changes without its digest", async () => {
    const ledger = new PostgresReplayLedger(database!);
    const originalEventId = randomUUID();
    const requestId = randomUUID();
    const body = { eventId: originalEventId, requestId, value: "original" };
    const bodyHash = hashCanonicalJson(body);
    const input: ReplayClaimInput = {
      request: {
        replayId: randomUUID(), type: "dlq.replay.requested.v1",
        occurredAt: "2026-08-21T12:00:00.000Z", originalEventId, requestId,
        idempotencyKey: "postgres-tamper", reason: "integration test",
      },
      original: { eventId: originalEventId, requestId, body },
      bodyHash,
      publisherIdempotencyKey: `dlq-replay-v1:${originalEventId}`,
    };
    await ledger.claim(input);
    await database!`
      UPDATE agent_market.recovery_replay_outbox
      SET event_body = jsonb_set(event_body, '{value}', '"tampered"'::jsonb)
      WHERE original_event_id = ${originalEventId}
    `;

    await expect(ledger.claimOutbox({ now: new Date(Date.now() + 1_000), leaseMs: 1_000 }))
      .rejects.toThrow("REPLAY_BODY_HASH_MISMATCH");
    const rows = await database!<{ status: string; attempt: number }[]>`
      SELECT status, attempt FROM agent_market.recovery_replay_outbox
      WHERE original_event_id = ${originalEventId}
    `;
    expect(rows).toEqual([{ status: "pending", attempt: 0 }]);
  });
});
