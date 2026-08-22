import { randomUUID } from "node:crypto";

import postgres, { type Sql } from "postgres";

import type {
  JSONObject,
  ReplayClaim,
  ReplayClaimInput,
  ReplayLedger,
  ReplayOutboxLease,
  ReplayResult,
} from "./replay";
import { hashCanonicalJson } from "./replay";

type DurableStatus = "pending" | "publishing" | "published" | "failed";

interface ReplayRow {
  replay_id: string;
  original_event_id: string;
  original_request_id: string;
  publisher_idempotency_key: string;
  original_body_hash: string;
  status: DurableStatus;
}

interface OutboxDeliveryRow {
  original_event_id: string;
  original_request_id: string;
  event_body: JSONObject;
  publisher_idempotency_key: string;
  original_body_hash: string;
  lease_token: string;
  lease_until: Date;
  attempt: number;
}

export class PostgresReplayLedger implements ReplayLedger {
  constructor(private readonly sql: Sql) {}

  static connect(databaseUrl: string): PostgresReplayLedger {
    return new PostgresReplayLedger(postgres(databaseUrl, { max: 5, prepare: false }));
  }

  async claim(input: ReplayClaimInput): Promise<ReplayClaim> {
    return this.sql.begin(async (transaction) => {
      const inserted = await transaction<ReplayRow[]>`
        INSERT INTO agent_market.recovery_replays (
          original_event_id, original_request_id, replay_id,
          operator_idempotency_key, publisher_idempotency_key,
          original_body_hash, status, attempt, next_attempt_at
        ) VALUES (
          ${input.request.originalEventId}, ${input.request.requestId}, ${input.request.replayId},
          ${input.request.idempotencyKey}, ${input.publisherIdempotencyKey},
          ${input.bodyHash}, 'pending', 0, now()
        )
        ON CONFLICT (original_event_id) DO NOTHING
        RETURNING replay_id, original_event_id, original_request_id,
          publisher_idempotency_key, original_body_hash, status
      `;
      if (inserted[0] !== undefined) {
        await transaction`
          INSERT INTO agent_market.recovery_replay_outbox (
            original_event_id, original_request_id, event_body,
            publisher_idempotency_key, original_body_hash,
            status, attempt, next_attempt_at
          ) VALUES (
            ${input.request.originalEventId}, ${input.request.requestId},
            ${transaction.json(input.original.body)},
            ${input.publisherIdempotencyKey}, ${input.bodyHash},
            'pending', 0, now()
          )
        `;
        return { claimed: true, result: rowResult(inserted[0]) };
      }

      const rows = await transaction<ReplayRow[]>`
        SELECT replay_id, original_event_id, original_request_id,
          publisher_idempotency_key, original_body_hash, status
        FROM agent_market.recovery_replays
        WHERE original_event_id = ${input.request.originalEventId}
        FOR UPDATE
      `;
      const row = rows[0];
      if (row === undefined) throw new Error("REPLAY_NOT_FOUND");
      if (row.original_request_id !== input.request.requestId || row.original_body_hash !== input.bodyHash) {
        throw new Error("REPLAY_ORIGINAL_CONFLICT");
      }
      return { claimed: false, result: rowResult(row) };
    });
  }

  async claimOutbox(options: {
    originalEventId?: string;
    now: Date;
    leaseMs: number;
  }): Promise<ReplayOutboxLease | null> {
    return this.sql.begin(async (transaction) => {
      const requestedId = options.originalEventId ?? null;
      const candidates = await transaction<{ original_event_id: string }[]>`
        SELECT o.original_event_id
        FROM agent_market.recovery_replay_outbox o
        WHERE o.status IN ('pending', 'publishing', 'failed')
          AND o.next_attempt_at <= ${options.now}
          AND (o.lease_until IS NULL OR o.lease_until <= ${options.now})
          AND (${requestedId}::uuid IS NULL OR o.original_event_id = ${requestedId})
        ORDER BY o.next_attempt_at, o.created_at, o.original_event_id
        FOR UPDATE OF o SKIP LOCKED
        LIMIT 1
      `;
      const candidate = candidates[0];
      if (candidate === undefined) return null;

      const leaseToken = randomUUID();
      const leaseUntil = new Date(options.now.getTime() + options.leaseMs);
      const outboxRows = await transaction<OutboxDeliveryRow[]>`
        UPDATE agent_market.recovery_replay_outbox
        SET status = 'publishing', attempt = attempt + 1,
          lease_token = ${leaseToken}, lease_until = ${leaseUntil},
          updated_at = ${options.now}, last_error_code = NULL
        WHERE original_event_id = ${candidate.original_event_id}
        RETURNING original_event_id, original_request_id, event_body,
          publisher_idempotency_key, original_body_hash, lease_token, lease_until, attempt
      `;
      const row = outboxRows[0];
      if (row === undefined) throw new Error("REPLAY_OUTBOX_INVARIANT");
      if (hashCanonicalJson(row.event_body) !== row.original_body_hash) {
        throw new Error("REPLAY_BODY_HASH_MISMATCH");
      }
      const replayRows = await transaction<{ original_event_id: string }[]>`
        UPDATE agent_market.recovery_replays
        SET status = 'publishing', attempt = attempt + 1,
          lease_token = ${leaseToken}, lease_until = ${leaseUntil},
          updated_at = ${options.now}, last_error_code = NULL
        WHERE original_event_id = ${candidate.original_event_id}
        RETURNING original_event_id
      `;
      if (replayRows.length !== 1) throw new Error("REPLAY_OUTBOX_INVARIANT");
      return {
        originalEventId: row.original_event_id,
        requestId: row.original_request_id,
        event: {
          eventId: row.original_event_id,
          requestId: row.original_request_id,
          body: row.event_body,
        },
        idempotencyKey: row.publisher_idempotency_key,
        bodyHash: row.original_body_hash,
        leaseToken: row.lease_token,
        leaseUntil: row.lease_until,
        attempt: row.attempt,
      };
    });
  }

  async markPublished(lease: ReplayOutboxLease, now: Date): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const outboxRows = await transaction<{ original_event_id: string }[]>`
        UPDATE agent_market.recovery_replay_outbox
        SET status = 'published', published_at = ${now}, updated_at = ${now},
          lease_token = NULL, lease_until = NULL
        WHERE original_event_id = ${lease.originalEventId}
          AND status = 'publishing' AND lease_token = ${lease.leaseToken}
        RETURNING original_event_id
      `;
      if (outboxRows.length !== 1) throw new Error("REPLAY_LEASE_LOST");
      const replayRows = await transaction<{ original_event_id: string }[]>`
        UPDATE agent_market.recovery_replays
        SET status = 'published', published_at = ${now}, updated_at = ${now},
          lease_token = NULL, lease_until = NULL
        WHERE original_event_id = ${lease.originalEventId}
          AND status = 'publishing' AND lease_token = ${lease.leaseToken}
        RETURNING original_event_id
      `;
      if (replayRows.length !== 1) throw new Error("REPLAY_OUTBOX_INVARIANT");
    });
  }

  async markFailed(
    lease: ReplayOutboxLease,
    errorCode: string,
    nextAttemptAt: Date,
    now: Date,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const outboxRows = await transaction<{ original_event_id: string }[]>`
        UPDATE agent_market.recovery_replay_outbox
        SET status = 'failed', last_error_code = ${errorCode},
          next_attempt_at = ${nextAttemptAt}, updated_at = ${now},
          lease_token = NULL, lease_until = NULL
        WHERE original_event_id = ${lease.originalEventId}
          AND status = 'publishing' AND lease_token = ${lease.leaseToken}
        RETURNING original_event_id
      `;
      if (outboxRows.length !== 1) throw new Error("REPLAY_LEASE_LOST");
      const replayRows = await transaction<{ original_event_id: string }[]>`
        UPDATE agent_market.recovery_replays
        SET status = 'failed', last_error_code = ${errorCode},
          next_attempt_at = ${nextAttemptAt}, updated_at = ${now},
          lease_token = NULL, lease_until = NULL
        WHERE original_event_id = ${lease.originalEventId}
          AND status = 'publishing' AND lease_token = ${lease.leaseToken}
        RETURNING original_event_id
      `;
      if (replayRows.length !== 1) throw new Error("REPLAY_OUTBOX_INVARIANT");
    });
  }

  async find(originalEventId: string): Promise<ReplayResult | null> {
    const rows = await this.sql<ReplayRow[]>`
      SELECT replay_id, original_event_id, original_request_id,
        publisher_idempotency_key, original_body_hash, status
      FROM agent_market.recovery_replays
      WHERE original_event_id = ${originalEventId}
      LIMIT 1
    `;
    return rows[0] === undefined ? null : rowResult(rows[0]);
  }
}

function rowResult(row: ReplayRow): ReplayResult {
  return {
    replayId: row.replay_id,
    originalEventId: row.original_event_id,
    requestId: row.original_request_id,
    idempotencyKey: row.publisher_idempotency_key,
    status: row.status === "published" ? "published" : "in_progress",
  };
}
