import { z } from "zod";

export const MATCH_REQUESTED_V1 = "match.requested.v1" as const;

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
