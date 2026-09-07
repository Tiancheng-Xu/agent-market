import type { Sql } from "postgres";
import { QueenWorkflowEventSchema, queenEventOperationKey, type QueenWorkflowEvent } from "./queen-workflow-event";

export async function publishQueenOutbox(
  sql: Sql,
  schema: "queen_runtime_public" | "queen_runtime_owner",
  publish: (event: QueenWorkflowEvent, signal: AbortSignal) => Promise<{ messageId: string }>,
  limit = 10,
): Promise<number> {
  if (!["queen_runtime_public", "queen_runtime_owner"].includes(schema)) throw new Error("QUEEN_OUTBOX_SCHEMA_INVALID");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("QUEEN_OUTBOX_BATCH_INVALID");
  const table = `"${schema}"."queen_outbox"`;
  let sent = 0;
  for (let i = 0; i < limit; i++) {
    const found = await sql.begin(async tx => {
      const rows = await tx<{ event_id: string; event: unknown }[]>`
        SELECT event_id, event FROM ${tx.unsafe(table)}
        WHERE status = 'pending' ORDER BY created_at, event_id
        LIMIT 1 FOR UPDATE SKIP LOCKED
      `;
      const row = rows[0];
      if (!row) return false;
      const event = QueenWorkflowEventSchema.parse(row.event);
      if (event.eventId !== row.event_id || event.operationKey !== queenEventOperationKey(event)) {
        throw new Error("QUEEN_OUTBOX_IDENTITY_INVALID");
      }
      // Publisher must honor the abort signal. A timeout is not proof of non-delivery.
      const receipt = await publish(event, AbortSignal.timeout(10000));
      if (!receipt || typeof receipt.messageId !== "string" || !receipt.messageId.trim()) {
        throw new Error("QUEEN_OUTBOX_PUBLISH_UNCONFIRMED");
      }
      await tx`UPDATE ${tx.unsafe(table)} SET status = 'published', published_at = clock_timestamp()
        WHERE event_id = ${row.event_id}`;
      return true;
    });
    if (!found) break;
    sent++;
  }
  return sent;
}
