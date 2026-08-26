import { describe, expect, it } from "vitest";

import {
  AgentManifestSchema,
  AgentTaskLeaseSchema,
  AgentTaskResultSchema,
  OwnerTrainedModels,
  SignedRequestHeadersSchema,
} from "./index";

const model = {
  tag: "personal-ai-agent-runtime:v4.1",
  digest: "2c422ec890241b8492e08d4ba69f79f25efcf8ae4220e83797d2df9cbc7eb52a",
};

const manifest = {
  id: "personal-ai-agent-runtime-v4-1",
  displayName: "Personal AI Agent Runtime v4.1",
  ownership: "owner-trained",
  provider: "ollama",
  capabilities: ["completion", "thinking", "tools"],
  toolSchemas: [],
  model: {
    ...model,
    parentModel: "personal-ai-agent:v4.1",
    family: "qwen3",
    parameterSize: "8.2B",
    quantization: "Q4_K_M",
    contextLength: 40960,
    source: "owner-trained",
    license: "pending metadata",
  },
  health: {
    status: "online",
    lastHeartbeatAt: "2026-08-22T12:00:00.000Z",
    lastVerifiedAt: "2026-08-22T12:00:00.000Z",
  },
  limits: {
    maxConcurrency: 1,
    timeoutMs: 120000,
    maxPayloadBytes: 1048576,
  },
  access: {
    visibility: "private",
    selectableBy: "owner-only",
    ownerScope: "local-runtime-owner",
  },
};

const deepSeekManifest = {
  id: "deepseek-v4-flash",
  displayName: "DeepSeek V4 Flash",
  ownership: "third-party/provider-api",
  provider: "deepseek",
  capabilities: ["completion", "thinking", "tools"],
  toolSchemas: [],
  model: {
    tag: "deepseek-v4-flash",
    digest: "provider-managed",
    family: "deepseek",
    parameterSize: "provider-managed",
    quantization: "provider-managed",
    contextLength: 1000000,
    source: "DeepSeek API",
    license: "provider terms pending metadata",
  },
  health: {
    status: "degraded",
    lastVerifiedAt: "2026-08-22T12:00:00.000Z",
  },
  limits: {
    maxConcurrency: 1,
    timeoutMs: 120000,
    maxPayloadBytes: 1048576,
  },
  access: {
    visibility: "marketplace",
    selectableBy: "public-market",
    ownerScope: "platform",
  },
};

const kimiManifest = {
  id: "kimi-k2-6",
  displayName: "Kimi K2.6",
  ownership: "third-party/provider-api",
  provider: "kimi",
  capabilities: ["completion", "thinking", "tools"],
  toolSchemas: [],
  model: {
    tag: "kimi-k2.6",
    digest: "provider-managed",
    family: "kimi",
    parameterSize: "provider-managed",
    quantization: "provider-managed",
    contextLength: 1000000,
    source: "Moonshot AI Kimi API",
    license: "provider terms pending metadata",
  },
  health: {
    status: "degraded",
    lastVerifiedAt: "2026-08-22T12:00:00.000Z",
  },
  limits: {
    maxConcurrency: 1,
    timeoutMs: 120000,
    maxPayloadBytes: 1048576,
  },
  access: {
    visibility: "marketplace",
    selectableBy: "public-market",
    ownerScope: "platform",
  },
};

const qwenManifest = {
  id: "qwen-qwen-plus",
  displayName: "Qwen Plus",
  ownership: "third-party/provider-api",
  provider: "qwen",
  capabilities: ["completion"],
  toolSchemas: [],
  model: {
    tag: "qwen-plus",
    digest: "provider-managed",
    family: "qwen",
    parameterSize: "provider-managed",
    quantization: "provider-managed",
    contextLength: 1000000,
    source: "Alibaba Cloud Model Studio Qwen API",
    license: "provider terms pending metadata",
  },
  health: {
    status: "degraded",
    lastVerifiedAt: "2026-08-22T12:00:00.000Z",
  },
  limits: {
    maxConcurrency: 1,
    timeoutMs: 120000,
    maxPayloadBytes: 1048576,
  },
  access: {
    visibility: "marketplace",
    selectableBy: "public-market",
    ownerScope: "platform",
  },
};

const zhipuManifest = {
  id: "zhipu-glm-5-3",
  displayName: "Glm 5 3",
  ownership: "third-party/provider-api",
  provider: "zhipu",
  capabilities: ["completion"],
  toolSchemas: [],
  model: {
    tag: "glm-5.3",
    digest: "provider-managed",
    family: "glm",
    parameterSize: "provider-managed",
    quantization: "provider-managed",
    contextLength: 1000000,
    source: "Z.AI / Zhipu AI OpenAI-compatible API",
    license: "provider terms pending metadata",
  },
  health: {
    status: "degraded",
    lastVerifiedAt: "2026-08-22T12:00:00.000Z",
  },
  limits: {
    maxConcurrency: 1,
    timeoutMs: 120000,
    maxPayloadBytes: 1048576,
  },
  access: {
    visibility: "marketplace",
    selectableBy: "public-market",
    ownerScope: "platform",
  },
};

const lease = {
  taskId: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
  leaseId: "44444444-4444-4444-8444-444444444444",
  agentId: manifest.id,
  model,
  prompt: "Give a concise status update.",
  issuedAt: "2026-08-22T12:00:00.000Z",
  expiresAt: "2026-08-22T12:02:00.000Z",
  nonce: "nonce-lease-001",
};

const resultIdentity = {
  taskId: lease.taskId,
  requestId: lease.requestId,
  runId: lease.runId,
  leaseId: lease.leaseId,
  agentId: lease.agentId,
  model: lease.model,
};

describe("local agent shared contracts", () => {
  it("accepts the canonical owner-trained manifest", () => {
    expect(AgentManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it("accepts every registered owner-trained model identity and capability contract", () => {
    for (const ownerModel of OwnerTrainedModels) {
      const candidate = {
        ...manifest,
        id: ownerModel.id,
        displayName: ownerModel.displayName,
        capabilities: [...ownerModel.capabilities],
        model: {
          ...manifest.model,
          tag: ownerModel.tag,
          digest: ownerModel.digest,
          ...("artifactDigest" in ownerModel ? { artifactDigest: ownerModel.artifactDigest } : {}),
          parentModel: ownerModel.parentModel,
          ...(ownerModel.revision === undefined ? {} : { revision: ownerModel.revision }),
          family: ownerModel.family,
          parameterSize: ownerModel.parameterSize,
          quantization: ownerModel.quantization,
          contextLength: ownerModel.contextLength,
          source: ownerModel.source,
          license: ownerModel.license,
        },
      };

      expect(AgentManifestSchema.parse(candidate)).toEqual(candidate);
    }
  });

  it("accepts third-party provider API manifests without local model digests", () => {
    expect(AgentManifestSchema.parse(deepSeekManifest)).toEqual(deepSeekManifest);
    expect(AgentManifestSchema.parse(kimiManifest)).toEqual(kimiManifest);
    expect(AgentManifestSchema.parse(qwenManifest)).toEqual(qwenManifest);
    expect(AgentManifestSchema.parse(zhipuManifest)).toEqual(zhipuManifest);
  });

  it("accepts a lease, result, and signed request headers", () => {
    expect(AgentTaskLeaseSchema.parse(lease)).toEqual(lease);
    expect(
      AgentTaskResultSchema.parse({
        ...resultIdentity,
        status: "succeeded",
        output: "Status is ready.",
        startedAt: "2026-08-22T12:00:01.000Z",
        completedAt: "2026-08-22T12:00:02.000Z",
      }),
    ).toMatchObject({ status: "succeeded", output: "Status is ready." });
    expect(
      SignedRequestHeadersSchema.parse({
        keyId: "local-agent-key-1",
        timestamp: 1780000000,
        nonce: "nonce-header-001",
        bodySha256: "a".repeat(64),
        signature: "b".repeat(64),
      }),
    ).toBeTruthy();
  });

  it("rejects unknown fields in every contract", () => {
    expect(() => AgentManifestSchema.parse({ ...manifest, extra: true })).toThrow();
    expect(() => AgentTaskLeaseSchema.parse({ ...lease, extra: true })).toThrow();
    expect(() =>
      AgentTaskResultSchema.parse({
        ...resultIdentity,
        status: "failed",
        startedAt: "2026-08-22T12:00:01.000Z",
        completedAt: "2026-08-22T12:00:02.000Z",
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      SignedRequestHeadersSchema.parse({
        keyId: "key",
        timestamp: 1780000000,
        nonce: "nonce",
        bodySha256: "a".repeat(64),
        signature: "b".repeat(64),
        extra: true,
      }),
    ).toThrow();
  });

  it("rejects invalid ownership, digest, concurrency, and payload limits", () => {
    expect(() => AgentManifestSchema.parse({ ...manifest, ownership: "unknown" })).toThrow();
    expect(() =>
      AgentManifestSchema.parse({ ...manifest, model: { ...manifest.model, digest: "ABC" } }),
    ).toThrow();
    expect(() =>
      AgentManifestSchema.parse({ ...manifest, limits: { ...manifest.limits, maxConcurrency: 3 } }),
    ).toThrow();
    expect(() =>
      AgentManifestSchema.parse({ ...manifest, limits: { ...manifest.limits, maxPayloadBytes: 1048577 } }),
    ).toThrow();
  });

  it("prevents Ollama agents from using provider-managed digests or provider API ownership", () => {
    expect(() =>
      AgentManifestSchema.parse({
        ...manifest,
        model: { ...manifest.model, digest: "provider-managed" },
      }),
    ).toThrow();
    expect(() => AgentManifestSchema.parse({ ...manifest, ownership: "third-party/provider-api" })).toThrow();
  });

  it("prevents hosted provider agents from being labeled local or owner-trained", () => {
    expect(() => AgentManifestSchema.parse({ ...deepSeekManifest, ownership: "owner-trained" })).toThrow();
    expect(() => AgentManifestSchema.parse({ ...deepSeekManifest, ownership: "third-party/local-served" })).toThrow();
    expect(() =>
      AgentManifestSchema.parse({
        ...deepSeekManifest,
        model: { ...deepSeekManifest.model, digest: "a".repeat(64) },
      }),
    ).toThrow();
  });

  it("enforces owner-only local agents and public-market provider agents", () => {
    expect(() =>
      AgentManifestSchema.parse({
        ...manifest,
        access: { visibility: "marketplace", selectableBy: "public-market", ownerScope: "platform" },
      }),
    ).toThrow();
    expect(() =>
      AgentManifestSchema.parse({
        ...deepSeekManifest,
        access: { visibility: "private", selectableBy: "owner-only", ownerScope: "local-runtime-owner" },
      }),
    ).toThrow();
  });

  it("reserves owner-trained ownership for the canonical trained model identity", () => {
    expect(() =>
      AgentManifestSchema.parse({
        ...manifest,
        model: { ...manifest.model, tag: "course-knowledge-assistant:v2.1" },
      }),
    ).toThrow();
    expect(() =>
      AgentManifestSchema.parse({
        ...manifest,
        model: { ...manifest.model, digest: "a".repeat(64) },
      }),
    ).toThrow();
    expect(() =>
      AgentManifestSchema.parse({
        ...manifest,
        model: {
          ...manifest.model,
          tag: "personal-code-agent:v1",
          digest: "a".repeat(64),
        },
      }),
    ).toThrow();
    expect(() =>
      AgentManifestSchema.parse({
        ...deepSeekManifest,
        provider: "ollama",
        ownership: "owner-trained",
        model: { ...deepSeekManifest.model, digest: "a".repeat(64) },
      }),
    ).toThrow();
  });

  it("rejects embedding-only agents", () => {
    expect(() =>
      AgentManifestSchema.parse({ ...manifest, capabilities: ["embedding"] }),
    ).toThrow();
  });

  it("requires output for succeeded results and prevents unsafe errors", () => {
    expect(() =>
      AgentTaskResultSchema.parse({
        ...resultIdentity,
        status: "succeeded",
        startedAt: "2026-08-22T12:00:01.000Z",
        completedAt: "2026-08-22T12:00:02.000Z",
      }),
    ).toThrow();
    expect(() =>
      AgentTaskResultSchema.parse({
        ...resultIdentity,
        status: "failed",
        error: { code: "FAILED", message: "safe", stack: "secret" },
        startedAt: "2026-08-22T12:00:01.000Z",
        completedAt: "2026-08-22T12:00:02.000Z",
      }),
    ).toThrow();
  });
});
