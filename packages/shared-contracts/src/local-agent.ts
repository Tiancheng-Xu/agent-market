import { z } from "zod";

const HexDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const ModelDigestSchema = z.union([HexDigestSchema, z.literal("provider-managed")]);
const ModelIdentitySchema = z.strictObject({
  tag: z.string().min(1),
  digest: ModelDigestSchema,
});

export const OwnerTrainedModels = [
  {
    id: "personal-ai-agent-runtime-v4-1",
    displayName: "Personal AI Runtime v4.1",
    tag: "personal-ai-agent-runtime:v4.1",
    digest: "2c422ec890241b8492e08d4ba69f79f25efcf8ae4220e83797d2df9cbc7eb52a",
    capabilities: ["completion", "thinking", "tools"],
    parentModel: "personal-ai-agent:v4.1",
    revision: undefined,
    family: "qwen3",
    parameterSize: "8.2B",
    quantization: "Q4_K_M",
    contextLength: 40960,
    source: "owner-trained",
    license: "pending metadata",
  },
  {
    id: "personal-code-agent",
    displayName: "Personal Code Agent",
    tag: "personal-code-agent:v1",
    digest: "4b9c60671fff53a198630f9aaf6b76d7d46c356359f41030f52e61f77f7b83bb",
    artifactDigest: "928df447cbc20d75c19d30b66bd2504701231841749e67b72887311478020121",
    capabilities: ["completion", "code-planning", "implementation-plan", "verification-gates", "structured-json", "local-runtime"],
    parentModel: "Qwen3-8B",
    revision: "b968826d9c46dd6066d109eabc6255188de91218",
    family: "qwen3",
    parameterSize: "8B",
    quantization: "Q4_K_M",
    contextLength: 8192,
    source: "Tiancheng-Xu/personal-ai-agent",
    license: "Apache-2.0",
  },
  {
    id: "personal-image-agent",
    displayName: "Personal Image Agent",
    tag: "personal-image-agent:v1",
    digest: "2fa405e1244629244798cb4d7b8f4b3a5dd9e47aaf9ea7329e8dbe27bd32cffd",
    artifactDigest: "4bba2f8f38a08edb2ad74a9a7b1a8927d5df4c31e7ec6270a6bdb3309706bfba",
    capabilities: ["completion", "image-brief", "asset-manifest", "visual-quality-gates", "structured-json", "local-runtime"],
    parentModel: "Qwen3-8B",
    revision: "b968826d9c46dd6066d109eabc6255188de91218",
    family: "qwen3",
    parameterSize: "8B",
    quantization: "Q4_K_M",
    contextLength: 8192,
    source: "Tiancheng-Xu/personal-ai-agent",
    license: "Apache-2.0",
  },
] as const;

const CapabilitySchema = z.enum([
  "completion",
  "thinking",
  "tools",
  "embedding",
  "code-planning",
  "implementation-plan",
  "verification-gates",
  "structured-json",
  "local-runtime",
  "image-brief",
  "asset-manifest",
  "visual-quality-gates",
]);

const ToolSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});

const AgentModelSchema = z.strictObject({
  tag: z.string().min(1),
  digest: ModelDigestSchema,
  artifactDigest: HexDigestSchema.optional(),
  parentModel: z.string().min(1).optional(),
  revision: z.string().min(1).optional(),
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

const AgentAccessSchema = z.strictObject({
  visibility: z.enum(["private", "listed", "marketplace"]),
  selectableBy: z.enum(["owner-only", "assigned-task", "public-market"]),
  ownerScope: z.enum(["local-runtime-owner", "workspace-owner", "platform"]).optional(),
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
    access: AgentAccessSchema,
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
  .refine(
    (value) =>
      value.ownership !== "owner-trained" ||
      OwnerTrainedModels.some((model) => model.tag === value.model.tag && model.digest === value.model.digest),
    {
      message: "Owner-trained ownership requires a registered model tag and digest pair",
      path: ["model"],
    },
  )
  .refine(
    (value) => value.ownership !== "owner-trained" || OwnerTrainedModels.some((model) => (
      model.tag === value.model.tag && (!("artifactDigest" in model) || model.artifactDigest === value.model.artifactDigest)
    )),
    { message: "Owner-trained artifact digest must match the registered provenance record", path: ["model", "artifactDigest"] },
  )
  .refine((value) => value.provider !== "ollama" || value.access.selectableBy === "owner-only", {
    message: "Local Ollama agents are owner-only by default",
    path: ["access", "selectableBy"],
  })
  .refine((value) => value.provider !== "ollama" || value.access.visibility === "private", {
    message: "Local Ollama agents must not be exposed as public marketplace agents",
    path: ["access", "visibility"],
  })
  .refine((value) => value.provider === "ollama" || value.access.selectableBy === "public-market", {
    message: "Provider API agents must be selectable through the public market policy",
    path: ["access", "selectableBy"],
  })
  .refine((value) => value.provider === "ollama" || value.access.visibility === "marketplace", {
    message: "Provider API agents must use marketplace visibility",
    path: ["access", "visibility"],
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
