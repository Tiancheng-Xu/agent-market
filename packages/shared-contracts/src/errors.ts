import { z } from "zod";

export const AppErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CONFLICT",
  "UNAVAILABLE",
  "INTERNAL",
]);

export const AppErrorSchema = z.strictObject({
  code: AppErrorCodeSchema,
  message: z.string().min(1).max(240),
  requestId: z.string().uuid().optional(),
  retryable: z.boolean().default(false),
});

export type AppError = z.infer<typeof AppErrorSchema>;
