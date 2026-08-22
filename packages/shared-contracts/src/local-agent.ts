import { z } from "zod";

const HexDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const ModelDigestSchema = z.union([HexDigestSchema, z.literal("provider-managed")]);
const ModelIdentitySchema = z.strictObject({
  tag: z.string().min(1),
  digest: ModelDigestSchema,
});

const OwnerTrainedModel = {
  tag: "personal-ai-agent-runtime:v4.1",
  digest: "2c422ec890241b8492e08d4ba69f79f25efcf8ae4220e83797d2df9cbc7eb52a",
} as const;

const CapabilitySchema = z.enum(["completion", "thinking", "tools", "embedding"]);

const ToolSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});

const AgentModelSchema = z.strictObject({
  tag: z.string().min(1),
  digest: ModelDigestSchema,
  parentModel: z.string().min(1).optional(),
  family: z.string().min(1),
  parameterSize: z.string().min(1),
  quantization: z.string().min(1),
  contextLength: z.number().int().positive(),
  embeddingLength: z.number().int().positive().optional(),
  source: z.string().min(1),
  license: z.string().min(1),
});

const AgentHealthSchema = z.strictObject({
  status: z.enum(["online", "offline", "degraded"]),
  lastHeartbeatAt: z.string().datetime().optional(),
  lastVerifiedAt: z.string().datetime().optional(),
});

const AgentLimitsSchema = z.strictObject({
  maxConcurrency: z.number().int().min(1).max(2),
  timeoutMs: z.number().int().min(1000).max(120000),
  maxPayloadBytes: z.number().int().min(1024).max(1048576),
});

export const AgentManifestSchema = z
  .strictObject({
    id: z.string().min(1),
    displayName: z.string().min(1),
    ownership: z.enum(["owner-trained", "third-party/local-served", "third-party/provider-api"]),
    provider: z.enum(["ollama", "deepseek", "kimi", "qwen", "zhipu"]),
    capabilities: z.array(CapabilitySchema).min(1),
    toolSchemas: z.array(ToolSchema),
    model: AgentModelSchema,
    health: AgentHealthSchema,
    limits: AgentLimitsSchema,
  })
  .refine((value) => value.capabilities.includes("completion"), {
    message: "An agent must support completion",
    path: ["capabilities"],
  })
  .refine((value) => value.provider !== "ollama" || value.model.digest !== "provider-managed", {
    message: "Ollama agents require a concrete local model digest",
    path: ["model", "digest"],
  })
  .refine((value) => value.provider === "ollama" || value.model.digest === "provider-managed", {
    message: "Provider API agents must use provider-managed model identity",
    path: ["model", "digest"],
  })
  .refine((value) => value.provider !== "ollama" || value.ownership !== "third-party/provider-api", {
    message: "Ollama agents must not use provider API ownership",
    path: ["ownership"],
  })
  .refine((value) => value.provider === "ollama" || value.ownership === "third-party/provider-api", {
    message: "Provider API agents must use third-party/provider-api ownership",
    path: ["ownership"],
  })
  .refine((value) => value.ownership !== "owner-trained" || value.provider === "ollama", {
    message: "Owner-trained agents must be served by the local Ollama adapter",
    path: ["provider"],
  })
  .refine((value) => value.ownership !== "owner-trained" || value.model.tag === OwnerTrainedModel.tag, {
    message: "Owner-trained ownership is reserved for the canonical trained model tag",
    path: ["model", "tag"],
  })
  .refine((value) => value.ownership !== "owner-trained" || value.model.digest === OwnerTrainedModel.digest, {
    message: "Owner-trained ownership is reserved for the canonical trained model digest",
    path: ["model", "digest"],
  });

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

export const AgentTaskLeaseSchema = z.strictObject({
  taskId: z.string().uuid(),
  requestId: z.string().uuid(),
  runId: z.string().uuid(),
  leaseId: z.string().uuid(),
  agentId: z.string().min(1),
  model: ModelIdentitySchema,
  prompt: z.string().min(1).max(16000),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  nonce: z.string().min(1),
});

export type AgentTaskLease = z.infer<typeof AgentTaskLeaseSchema>;

const ResultIdentitySchema = z.strictObject({
  taskId: z.string().uuid(),
  requestId: z.string().uuid(),
  runId: z.string().uuid(),
  leaseId: z.string().uuid(),
  agentId: z.string().min(1),
  model: ModelIdentitySchema,
});

const SafeErrorSchema = z.strictObject({
  code: z.enum(["VALIDATION_FAILED", "UNAUTHORIZED", "TIMEOUT", "CANCELLED", "UNAVAILABLE", "MODEL_ERROR", "INTERNAL"]),
  message: z.string().min(1).max(240),
});

export const AgentTaskResultSchema = ResultIdentitySchema.extend({
  status: z.enum(["succeeded", "failed", "cancelled"]),
  output: z.string().max(32000).optional(),
  error: SafeErrorSchema.optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
}).superRefine((value, context) => {
  if (value.status === "succeeded" && value.output === undefined) {
    context.addIssue({ code: "custom", path: ["output"], message: "Succeeded results require output" });
  }
});

export type AgentTaskResult = z.infer<typeof AgentTaskResultSchema>;

export const SignedRequestHeadersSchema = z.strictObject({
  keyId: z.string().min(1),
  timestamp: z.number().int().nonnegative(),
  nonce: z.string().min(1),
  bodySha256: HexDigestSchema,
  signature: HexDigestSchema,
});

export type SignedRequestHeaders = z.infer<typeof SignedRequestHeadersSchema>;
