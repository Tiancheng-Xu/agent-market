import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { queenEventOperationKey, type QueenWorkflowEvent } from "./queen-workflow-event";

type Outcome = "committed" | "duplicate-committed" | "busy" | "uncertain";
type Row = { payload_hash: string; status: "executing" | "committed" | "uncertain" };

export class QueenOperationLedger {
  private readonly sql: ReturnType<typeof postgres>;
  private readonly table: string;
  constructor(databaseUrl: string, schema: "queen_runtime_public" | "queen_runtime_owner") {
    if (!["queen_runtime_public", "queen_runtime_owner"].includes(schema)) throw new Error("QUEEN_LEDGER_SCHEMA_INVALID");
    this.sql = postgres(databaseUrl, { max: 2, prepare: false });
    this.table = `"${schema}"."queen_operations"`;
  }
  async close() { await this.sql.end({ timeout: 5 }); }

  async execute(event: QueenWorkflowEvent, operation: () => Promise<void>): Promise<Outcome> {
    if (event.operationKey !== queenEventOperationKey(event)) throw new Error("QUEEN_EVENT_IDENTITY_INVALID");
    const token = randomUUID();
    const claimed = await this.sql`
      INSERT INTO ${this.sql.unsafe(this.table)}
        (operation_key, payload_hash, task_id, scope_id, graph_revision, owner_token, status)
      VALUES (${event.operationKey}, ${event.payloadHash}, ${event.taskId}, ${event.scopeId}, ${event.graphRevision}, ${token}, 'executing')
      ON CONFLICT (operation_key) DO NOTHING RETURNING operation_key
    `;
    if (claimed.count === 0) {
      // A crashed owner cannot hold the operation forever. Expiry never grants
      // permission to rerun an unknown external effect; it moves the record to
      // explicit reconciliation instead.
      const expired = await this.sql`
        UPDATE ${this.sql.unsafe(this.table)}
        SET status = 'uncertain', updated_at = clock_timestamp()
        WHERE operation_key = ${event.operationKey}
          AND payload_hash = ${event.payloadHash}
          AND status = 'executing'
          AND updated_at <= clock_timestamp() - interval '5 minutes'
        RETURNING operation_key
      `;
      if (expired.count === 1) return "uncertain";
      const rows = await this.sql<Row[]>`SELECT payload_hash, status FROM ${this.sql.unsafe(this.table)} WHERE operation_key = ${event.operationKey}`;
      const row = rows[0];
      if (!row || row.payload_hash !== event.payloadHash) throw new Error("QUEEN_OPERATION_IDENTITY_CONFLICT");
      return row.status === "committed" ? "duplicate-committed" : row.status === "uncertain" ? "uncertain" : "busy";
    }
    try {
      // The adapter must persist business outputs/checkpoints before resolving.
      await operation();
      const saved = await this.sql`
        UPDATE ${this.sql.unsafe(this.table)} SET status = 'committed', updated_at = clock_timestamp()
        WHERE operation_key = ${event.operationKey} AND owner_token = ${token} AND status = 'executing'
        RETURNING operation_key
      `;
      if (saved.count !== 1) throw new Error("QUEEN_OPERATION_COMMIT_CONFLICT");
      return "committed";
    } catch {
      // An external effect may already have succeeded. Never assume failure means safe retry.
      await this.sql`
        UPDATE ${this.sql.unsafe(this.table)} SET status = 'uncertain', updated_at = clock_timestamp()
        WHERE operation_key = ${event.operationKey} AND owner_token = ${token} AND status = 'executing'
      `.catch(() => undefined);
      return "uncertain";
    }
  }
}
