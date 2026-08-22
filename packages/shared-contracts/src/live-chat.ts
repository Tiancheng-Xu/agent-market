import { z } from "zod";

export const LiveChatRoleSchema = z.enum(["system", "user", "assistant"]);

export const LiveChatMessageSchema = z.strictObject({
  role: LiveChatRoleSchema,
  content: z.string().min(1).max(4000),
});

export const LiveChatRequestSchema = z.strictObject({
  requestId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
  agentId: z.string().min(1).max(160),
  messages: z.array(LiveChatMessageSchema).min(1).max(12),
  turnstileToken: z.string().min(1).max(4096).optional(),
});

export const LiveAgentOrchestrationInputSchema = z.strictObject({
  requestId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
  agentIds: z.array(z.string().min(1).max(160)).min(2).max(3),
  messages: z.array(LiveChatMessageSchema).min(1).max(12),
  turnstileToken: z.string().min(1).max(4096).optional(),
});

export const LiveAgentGraphqlRequestSchema = z.strictObject({
  query: z.string().min(1).max(10000),
  operationName: z.string().min(1).max(128).optional(),
  variables: z.strictObject({
    input: LiveAgentOrchestrationInputSchema,
  }),
});

export const LiveChatErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "RATE_LIMITED",
  "TURNSTILE_FAILED",
  "REQUEST_TOO_LARGE",
  "UPSTREAM_TIMEOUT",
  "RUNTIME_OFFLINE",
  "MODEL_UNAVAILABLE",
  "INTERNAL",
]);

export const LiveChatErrorSchema = z.strictObject({
  code: LiveChatErrorCodeSchema,
  message: z.string().min(1).max(240),
  requestId: z.string().uuid().optional(),
  retryable: z.boolean().default(false),
});

export const LiveAgentHealthSchema = z.strictObject({
  agentId: z.string().min(1),
  displayName: z.string().min(1),
  provider: z.enum(["ollama", "deepseek", "kimi", "qwen", "zhipu"]),
  ownership: z.enum(["owner-trained", "third-party/local-served", "third-party/provider-api"]),
  modelTag: z.string().min(1),
  modelDigest: z.union([z.string().regex(/^[0-9a-f]{64}$/), z.literal("provider-managed")]),
  status: z.enum(["online", "offline", "degraded"]),
  reasonCode: LiveChatErrorCodeSchema.optional(),
  lastVerifiedAt: z.string().datetime().optional(),
});

export const LiveChatHealthSchema = z.strictObject({
  status: z.enum(["online", "offline", "degraded"]),
  checkedAt: z.string().datetime(),
  runtime: z.enum(["edge", "local-runtime", "mock"]),
  agents: z.array(LiveAgentHealthSchema),
  reasonCode: LiveChatErrorCodeSchema.optional(),
});

export const LiveChatSseMetaSchema = z.strictObject({
  event: z.literal("meta"),
  requestId: z.string().uuid(),
  runId: z.string().uuid(),
  agentId: z.string().min(1),
  provider: z.enum(["ollama", "deepseek", "kimi", "qwen", "zhipu"]),
  modelTag: z.string().min(1),
});

export const LiveChatSseDeltaSchema = z.strictObject({
  event: z.literal("delta"),
  requestId: z.string().uuid(),
  delta: z.string().min(1).max(8000),
});

export const LiveChatSseDoneSchema = z.strictObject({
  event: z.literal("done"),
  requestId: z.string().uuid(),
  outputBytes: z.number().int().nonnegative(),
});

export const LiveChatSseErrorSchema = z.strictObject({
  event: z.literal("error"),
  error: LiveChatErrorSchema,
});

export const LiveChatSseEventSchema = z.discriminatedUnion("event", [
  LiveChatSseMetaSchema,
  LiveChatSseDeltaSchema,
  LiveChatSseDoneSchema,
  LiveChatSseErrorSchema,
]);

export type LiveChatMessage = z.infer<typeof LiveChatMessageSchema>;
export type LiveChatRequest = z.infer<typeof LiveChatRequestSchema>;
export type LiveAgentOrchestrationInput = z.infer<typeof LiveAgentOrchestrationInputSchema>;
export type LiveAgentGraphqlRequest = z.infer<typeof LiveAgentGraphqlRequestSchema>;
export type LiveChatErrorCode = z.infer<typeof LiveChatErrorCodeSchema>;
export type LiveChatError = z.infer<typeof LiveChatErrorSchema>;
export type LiveAgentHealth = z.infer<typeof LiveAgentHealthSchema>;
export type LiveChatHealth = z.infer<typeof LiveChatHealthSchema>;
export type LiveChatSseEvent = z.infer<typeof LiveChatSseEventSchema>;
