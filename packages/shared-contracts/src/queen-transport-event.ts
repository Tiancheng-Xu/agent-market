import { z } from "zod";

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

/** Transport identity only. Never substitutes for task/wallet authorization. */
export const QueenTransportEventSchema = z.object({
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

export type QueenTransportEvent = z.infer<typeof QueenTransportEventSchema>;

export function queenTransportOperationParts(event: Pick<QueenTransportEvent,
  "eventType" | "taskId" | "scopeId" | "graphRevision" | "taskFingerprint" | "payloadRef" | "payloadHash">) {
  return ["queen-workflow-event.v1", event.eventType, event.scopeId, event.taskId,
    event.graphRevision, event.taskFingerprint, event.payloadRef, event.payloadHash] as const;
}
