import { createHash } from "node:crypto";
import { z } from "zod";

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const QueenWorkflowEventSchema = z.object({
  schemaVersion: z.literal("queen-workflow-event.v1"),
  eventId: z.string().uuid(),
  eventType: z.enum(["task.requested", "task.approval-recorded", "task.resume-requested"]),
  taskId: z.string().uuid(),
  scopeId: z.string().uuid(),
  graphRevision: z.number().int().positive(),
  taskFingerprint: Digest,
  operationKey: Digest,
  payloadRef: z.string().uuid(),
  payloadHash: Digest,
  occurredAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.occurredAt)) {
    ctx.addIssue({ code: "custom", message: "QUEEN_EVENT_EXPIRY_INVALID", path: ["expiresAt"] });
  }
});
export type QueenWorkflowEvent = z.infer<typeof QueenWorkflowEventSchema>;

export function queenEventOperationKey(event: Pick<QueenWorkflowEvent,
  "eventType" | "taskId" | "scopeId" | "graphRevision" | "taskFingerprint" | "payloadRef" | "payloadHash">): string {
  // Transport retries can have different SNS/SQS IDs. Bind business identity instead.
  return `sha256:${createHash("sha256").update(JSON.stringify([
    "queen-workflow-event.v1", event.eventType, event.scopeId, event.taskId,
    event.graphRevision, event.taskFingerprint, event.payloadRef, event.payloadHash,
  ])).digest("hex")}`;
}

export interface QueenWorkflowConsumerPorts {
  // Verify the trusted SNS/SQS source separately; never follow URLs from an SNS envelope.
  assertTrustedSource(): Promise<void>;
  // Must resolve payloadRef on the server and verify its hash, current permissions,
  // approval and graph revision. Event fields are not authorization credentials.
  authorizeAndResolve(event: QueenWorkflowEvent): Promise<void>;
  // Backed by a durable unique operation ledger. All outcomes must match this
  // operationKey AND payloadHash. Unknown provider results require reconciliation.
  executeDurably(event: QueenWorkflowEvent): Promise<"committed" | "duplicate-committed" | "busy" | "uncertain">;
  deleteMessage(): Promise<void>;
}

export async function consumeQueenWorkflowEvent(body: string, ports: QueenWorkflowConsumerPorts, now = Date.now()) {
  await ports.assertTrustedSource();
  if (Buffer.byteLength(body, "utf8") > 8192) throw new Error("QUEEN_EVENT_TOO_LARGE");
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new Error("QUEEN_EVENT_INVALID"); }
  const parsed = QueenWorkflowEventSchema.safeParse(value);
  if (!parsed.success) throw new Error("QUEEN_EVENT_INVALID");
  const event = parsed.data;
  if (Date.parse(event.expiresAt) <= now || Date.parse(event.occurredAt) > now + 60000) {
    throw new Error("QUEEN_EVENT_TIME_INVALID");
  }
  if (event.operationKey !== queenEventOperationKey(event)) throw new Error("QUEEN_EVENT_IDENTITY_INVALID");
  await ports.authorizeAndResolve(event);
  const outcome = await ports.executeDurably(event);
  if (outcome !== "committed" && outcome !== "duplicate-committed") {
    throw new Error(outcome === "busy" ? "QUEEN_EVENT_BUSY" : "QUEEN_EVENT_RECONCILIATION_REQUIRED");
  }
  await ports.deleteMessage();
  return { eventId: event.eventId, outcome };
}
