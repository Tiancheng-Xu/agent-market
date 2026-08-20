import { z } from "zod";

export const RequestContextSchema = z.strictObject({
  requestId: z.string().uuid(),
  actorId: z.string().min(1),
  idempotencyKey: z.string().min(8).max(128),
});

export type RequestContext = z.infer<typeof RequestContextSchema>;
