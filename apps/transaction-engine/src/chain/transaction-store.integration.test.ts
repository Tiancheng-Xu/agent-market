import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { PostgresTransactionStore } from "./transaction-store";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const OWNERSHIP_MARKER = "agent-market-t4-transaction-store-integration-v1";

function assertDedicatedLocalTestDatabase(value: string): void {
  const url = new URL(value);
  const name = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (process.env.TEST_DATABASE_DESTRUCTIVE !== "agent-market-ephemeral-only"
    || !new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)
    || !/^agent_market_chain_test_[a-z0-9_]+$/u.test(name)) throw new Error("UNSAFE_TEST_DATABASE");
}

function migration(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../database/migrations/${name}`, import.meta.url)), "utf8")
    .replace(/^\s*BEGIN;\s*$/gimu, "")
    .replace(/^\s*COMMIT;\s*$/gimu, "");
}

const intent = {
  intentId: "0191f6f8-cb6b-7f31-81ad-c497d7d90401",
  requestId: "0191f6f8-cb6b-7f31-81ad-c497d7d90402",
  requestRef: `0x${"12".repeat(32)}`,
  chainId: 11_155_111 as const,
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  method: "createTask" as const,
  data: "0x1234",
  valueAtomic: "0",
  createdAt: "2026-08-21T12:00:00.000Z",
  expiresAt: "2026-08-21T12:10:00.000Z",
};
const expectation = {
  resourceId: "0191f6f8-cb6b-7f31-81ad-c497d7d90409",
  budgetAtomic: "100",
  bondAtomic: "6",
  agentWins: null,
};

integration.sequential("PostgreSQL transaction store", () => {
  it("atomically protects confirmed state, canonical observations, and conflicts", async () => {
    assertDedicatedLocalTestDatabase(databaseUrl!);
    const sql = postgres(databaseUrl!, { max: 4, prepare: false });
    let ownsDatabase = false;
    try {
      const current = await sql<{ name: string }[]>`SELECT current_database() AS name`;
      const expectedName = decodeURIComponent(new URL(databaseUrl!).pathname.replace(/^\//u, ""));
      if (current[0]?.name !== expectedName) throw new Error("UNSAFE_TEST_DATABASE_IDENTITY");
      const existing = await sql<{ table_schema: string; table_name: string }[]>`
        SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_schema != 'information_schema' AND table_schema NOT LIKE 'pg_%'
      `;
      if (existing.length !== 0) throw new Error("UNSAFE_TEST_DATABASE_NOT_EMPTY");
      await sql.unsafe(`
        CREATE SCHEMA agent_market_t4_guard;
        CREATE TABLE agent_market_t4_guard.ownership (marker text PRIMARY KEY);
        INSERT INTO agent_market_t4_guard.ownership (marker) VALUES ('${OWNERSHIP_MARKER}');
      `);
      ownsDatabase = true;
      await sql.unsafe(migration("0001_agent_market_core.sql")
        .replace("CREATE EXTENSION IF NOT EXISTS vector;", "")
        .replace("embedding vector(384)", "embedding double precision[]"));
      await sql.unsafe(migration("0002_performance_observability.sql"));
      await sql.unsafe(migration("0003_phase2_lifecycle.sql"));
      await sql.unsafe(migration("0004_chain_reconciliation.sql"));
      await sql`
        INSERT INTO agent_market.tasks (
          id, publisher_wallet, title, description, requirements,
          budget_atomic, status, request_id
        ) VALUES (
          ${expectation.resourceId}, ${intent.from}, 'T4 integration task',
          'Dedicated transaction-store integration fixture', ARRAY[]::text[],
          ${expectation.budgetAtomic}, 'open', ${intent.requestId}
        )
      `;
      const store = new PostgresTransactionStore(sql);
      await store.createIntent(intent, expectation);
      expect(await store.createIntent({
        ...intent,
        createdAt: "2026-08-21T12:00:01.000Z",
        expiresAt: "2026-08-21T12:10:01.000Z",
      }, expectation)).toEqual(intent);
      await store.recordSubmission(intent.intentId, `0x${"34".repeat(32)}`, intent.createdAt);
      const confirmed = {
        intentId: intent.intentId,
        requestId: intent.requestId,
        txHash: `0x${"34".repeat(32)}`,
        status: "confirmed" as const,
        confirmations: 2,
        blockNumber: 100,
        eventName: "TaskCreated",
        checkedAt: "2026-08-21T12:02:00.000Z",
      };
      await expect(store.saveVerification(confirmed)).rejects.toThrow(
        "CHAIN_CANONICAL_OBSERVATION_REQUIRED",
      );
      await expect(store.saveVerification(confirmed, {
        blockHash: `0x${"56".repeat(32)}`,
        requestRef: `0x${"99".repeat(32)}`,
      })).rejects.toThrow("CHAIN_REQUEST_REF_CONFLICT");
      const staleInput = {
        intentId: intent.intentId,
        requestId: intent.requestId,
        txHash: confirmed.txHash,
        status: "verifying",
        confirmations: 1,
        blockNumber: 100,
        checkedAt: "2026-08-21T12:03:00.000Z",
      } as const;
      await Promise.all([
        store.saveVerification(staleInput),
        store.saveVerification(confirmed, {
          blockHash: `0x${"56".repeat(32)}`,
          requestRef: intent.requestRef,
        }),
      ]);
      expect(await store.findVerification(intent.intentId)).toMatchObject({ status: "confirmed" });
      await expect(store.saveVerification({
        ...confirmed,
        txHash: `0x${"77".repeat(32)}`,
        checkedAt: "2026-08-21T12:03:30.000Z",
      }, {
        blockHash: `0x${"56".repeat(32)}`,
        requestRef: intent.requestRef,
      })).rejects.toThrow("CHAIN_TRANSACTION_CONFLICT");
      const storedObservation = await sql<{ block_hash: string; request_ref_matches: boolean }[]>`
        SELECT block_hash, event_request_ref = request_ref AS request_ref_matches
        FROM agent_market.chain_transactions WHERE intent_id = ${intent.intentId}
      `;
      expect(storedObservation[0]).toEqual({
        block_hash: `0x${"56".repeat(32)}`,
        request_ref_matches: true,
      });
      const reorged = await store.saveVerification({
        intentId: intent.intentId,
        requestId: intent.requestId,
        txHash: confirmed.txHash,
        status: "reorged",
        confirmations: 0,
        blockNumber: 100,
        errorCode: "CHAIN_REORG",
        checkedAt: "2026-08-21T12:04:00.000Z",
      });
      expect(reorged.status).toBe("reorged");
      expect(await store.findCanonicalBlockHash(intent.intentId)).toBe(`0x${"56".repeat(32)}`);
      await expect(store.saveVerification({ ...confirmed, intentId: "0191f6f8-cb6b-7f31-81ad-c497d7d90409" }, {
        blockHash: `0x${"56".repeat(32)}`, requestRef: intent.requestRef,
      })).rejects.toThrow("CHAIN_INTENT_NOT_FOUND");
    } finally {
      try {
        if (ownsDatabase) {
          const marker = await sql<{ marker: string }[]>`
            SELECT marker FROM agent_market_t4_guard.ownership LIMIT 1
          `;
          if (marker[0]?.marker !== OWNERSHIP_MARKER) {
            throw new Error("UNSAFE_TEST_DATABASE_OWNERSHIP_LOST");
          }
          await sql.unsafe("DROP SCHEMA agent_market CASCADE; DROP SCHEMA agent_market_t4_guard CASCADE;");
        }
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  }, 30_000);
});
