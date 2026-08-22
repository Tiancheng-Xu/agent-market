import { z } from "zod";

export const MATCH_REQUESTED_V1 = "match.requested.v1" as const;
export const DLQ_REPLAY_REQUESTED_V1 = "dlq.replay.requested.v1" as const;

export const MatchRequestedV1Schema = z.strictObject({
  eventId: z.string().uuid(),
  type: z.literal(MATCH_REQUESTED_V1),
  occurredAt: z.string().datetime(),
  requestId: z.string().uuid(),
  matchJobId: z.string().uuid(),
  taskId: z.string().uuid(),
  modelVersion: z.string().min(1),
});

export type MatchRequestedV1 = z.infer<typeof MatchRequestedV1Schema>;

export const DlqReplayRequestedV1Schema = z.strictObject({
  replayId: z.string().uuid(),
  type: z.literal(DLQ_REPLAY_REQUESTED_V1),
  occurredAt: z.string().datetime(),
  originalEventId: z.string().uuid(),
  requestId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  reason: z.string().min(1).max(240),
});

export type DlqReplayRequestedV1 = z.infer<
  typeof DlqReplayRequestedV1Schema
>;
