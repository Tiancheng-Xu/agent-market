import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import { QueenWorkflowEventSchema, queenEventOperationKey, type QueenWorkflowEvent } from "./queen-workflow-event";

// Ordered fields reproduce the producer's canonical planning payload, including
// after PostgreSQL JSONB has reordered object keys. Private content stays here.
const Payload = z.object({
  version: z.literal("queen-planning-payload.v1"), action: z.literal("plan"),
  taskId: z.string().uuid(), taskVersion: z.number().int().positive(),
  title: z.string(), description: z.string(), requirements: z.array(z.string()),
  budgetAtomic: z.string().regex(/^[1-9][0-9]*$/u),
}).strict();
export type QueenPlanningPayload = z.infer<typeof Payload>;
const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

export function createQueenPlanningAuthorization(sql: Sql) {
  return async (input: QueenWorkflowEvent): Promise<QueenPlanningPayload> => {
    const event = QueenWorkflowEventSchema.parse(input);
    if (event.eventType !== "task.requested" || event.graphRevision !== 1
        || event.operationKey !== queenEventOperationKey(event)) {
      throw new Error("QUEEN_PLANNING_EVENT_REJECTED");
    }
    const [row] = await sql`
      SELECT request.payload, request.event, request.task_version,
        request.publisher_wallet AS authorized_wallet,
        request.status AS request_status, request.allowed_action,
        request.expires_at > clock_timestamp() AS valid,
        task.id, task.version, task.status, task.publisher_wallet,
        task.title, task.description, task.requirements,
        task.budget_atomic::text AS budget_atomic
      FROM agent_market.queen_planning_requests request
      JOIN agent_market.tasks task ON task.id = request.task_id
      WHERE request.id = ${event.payloadRef} AND task.id = ${event.taskId}
    `;
    if (!row || !row.valid || row.request_status !== "requested" || row.allowed_action !== "plan"
        || row.status !== "open" || row.version !== row.task_version
        || String(row.publisher_wallet).toLowerCase() !== String(row.authorized_wallet).toLowerCase()) {
      throw new Error("QUEEN_PLANNING_AUTHORIZATION_REJECTED");
    }
    const authorized = QueenWorkflowEventSchema.parse(row.event);
    if (Object.keys(authorized).some(key => authorized[key as keyof QueenWorkflowEvent] !== event[key as keyof QueenWorkflowEvent])) {
      throw new Error("QUEEN_PLANNING_EVENT_MISMATCH");
    }
    const payload = Payload.parse(row.payload);
    const current = Payload.parse({
      version: "queen-planning-payload.v1", action: "plan", taskId: row.id,
      taskVersion: row.version, title: row.title, description: row.description,
      requirements: row.requirements, budgetAtomic: row.budget_atomic,
    });
    if (digest(payload) !== event.payloadHash || digest(current) !== event.payloadHash
        || digest(["queen-planning-task.v1", event.payloadHash]) !== event.taskFingerprint) {
      throw new Error("QUEEN_PLANNING_PAYLOAD_MISMATCH");
    }
    return payload;
  };
}
