import { describe, expect, it, vi } from "vitest";

import { OwnerTrainedModels, type AgentManifest, type AgentTaskLease } from "@agent-market/shared-contracts";

import { ControlPlaneClient } from "./control-plane-client";
import { parseRunnerConfig } from "./config";
import { discoverOllamaManifests, ollamaMetadataToManifest } from "./model-registry";
import { MockControlPlane } from "./mock-control-plane";
import { OllamaClient, type FetchLike } from "./ollama-client";
import { providerManifest, providerManifests } from "./provider-adapters";
import { PROVIDERS, ProviderApiClient, readProviderModels } from "./provider-api-client";
import { LocalAgentRunner } from "./runner";
import { signedHeaders, signRequest } from "./signing";

const fixedNow = new Date("2026-08-22T12:00:00.000Z");

describe("runner config", () => {
  it("rejects non-canonical Ollama origins", () => {
    for (const origin of [
      "http://localhost:11434",
      "http://0.0.0.0:11434",
      "http://192.168.1.10:11434",
      "https://api.example.com",
      "http://127.0.0.1:11434/path",
    ]) {
      expect(() => parseRunnerConfig({ OLLAMA_ORIGIN: origin })).toThrow("OLLAMA_ORIGIN");
    }
  });

  it("uses bounded defaults", () => {
    expect(parseRunnerConfig({})).toMatchObject({
      ollamaOrigin: "http://127.0.0.1:11434",
      ollamaModelAllowlist: ["*"],
      maxConcurrency: 1,
      timeoutMs: 120000,
      maxPayloadBytes: 1048576,
    });
  });
});

describe("Ollama model registry", () => {
  it("excludes embedding-only models", () => {
    const config = parseRunnerConfig({});
    const manifest = ollamaMetadataToManifest(
      {
        name: "nomic-embed-text:latest",
        digest: "a".repeat(64),
      },
      {
        capabilities: ["embedding"],
        model_info: {
          "llama.embedding_length": 768,
        },
      },
      config,
      fixedNow,
    );

    expect(manifest).toBeUndefined();
  });

  it("marks the default model as owner-trained with the canonical digest", () => {
    const config = parseRunnerConfig({});
    const manifest = ollamaMetadataToManifest(
      {
        name: "personal-ai-agent-runtime:v4.1",
        digest: "2c422ec890241b8492e08d4ba69f79f25efcf8ae4220e83797d2df9cbc7eb52a",
        details: {
          family: "qwen3",
          parameter_size: "8.2B",
          quantization_level: "Q4_K_M",
        },
      },
      {
        capabilities: ["completion", "thinking", "tools"],
        model_info: {
          "general.basename": "personal-ai-agent:v4.1",
          "llama.context_length": 40960,
        },
      },
      config,
      fixedNow,
    );

    expect(manifest).toMatchObject({
      id: "personal-ai-agent-runtime-v4-1",
      ownership: "owner-trained",
      provider: "ollama",
      capabilities: ["completion", "thinking", "tools"],
      model: {
        tag: "personal-ai-agent-runtime:v4.1",
        digest: "2c422ec890241b8492e08d4ba69f79f25efcf8ae4220e83797d2df9cbc7eb52a",
        parentModel: "personal-ai-agent:v4.1",
        family: "qwen3",
        contextLength: 40960,
      },
      health: {
        status: "online",
        lastVerifiedAt: "2026-08-22T12:00:00.000Z",
      },
    });
  });

  it("discovers the code and image training artifacts as registered owner-trained agents", () => {
    const config = parseRunnerConfig({});

    for (const ownerModel of OwnerTrainedModels.filter((model) => model.tag.endsWith(":v1"))) {
      const manifest = ollamaMetadataToManifest(
        { name: ownerModel.tag, digest: ownerModel.digest },
        { capabilities: ["completion"] },
        config,
        fixedNow,
      );

      expect(manifest).toMatchObject({
        id: ownerModel.id,
        displayName: ownerModel.displayName,
        ownership: "owner-trained",
        capabilities: ownerModel.capabilities,
        model: {
          tag: ownerModel.tag,
          digest: ownerModel.digest,
          ...("artifactDigest" in ownerModel ? { artifactDigest: ownerModel.artifactDigest } : {}),
          revision: ownerModel.revision,
          quantization: "Q4_K_M",
          contextLength: 8192,
          source: "Tiancheng-Xu/personal-ai-agent",
          license: "Apache-2.0",
        },
      });
    }
  });

  it("marks other chat models as third-party local-served", () => {
    const config = parseRunnerConfig({});
    const manifest = ollamaMetadataToManifest(
      {
        name: "qwen3:8b",
        digest: "b".repeat(64),
      },
      {
        capabilities: ["completion"],
        model_info: {
          "general.architecture": "qwen3",
        },
      },
      config,
      fixedNow,
    );

    expect(manifest).toMatchObject({
      ownership: "third-party/local-served",
      model: {
        digest: "b".repeat(64),
        license: "pending metadata",
      },
    });
  });

  it("isolates individual Ollama show failures during discovery", async () => {
    const client = {
      async listTags() {
        return [
          {
            name: "personal-ai-agent-runtime:v4.1",
            digest: "2c422ec890241b8492e08d4ba69f79f25efcf8ae4220e83797d2df9cbc7eb52a",
            capabilities: ["completion"],
            details: { family: "qwen3", parameter_size: "8.2B", quantization_level: "Q4_K_M", context_length: 40960 },
          },
          { name: "broken:latest", digest: "c".repeat(64), capabilities: ["completion"] },
        ];
      },
      async show(model: string) {
        if (model === "broken:latest") throw new Error("show failed");
        return { capabilities: ["completion"] };
      },
    };

    const manifests = await discoverOllamaManifests(client, parseRunnerConfig({}), undefined, () => fixedNow);

    expect(manifests.map((manifest) => manifest.id)).toEqual(["personal-ai-agent-runtime-v4-1"]);
  });
});

describe("provider manifests", () => {
  it("reports missing provider keys as offline without exposing key fields", () => {
    const config = parseRunnerConfig({});
    const manifest = providerManifest("deepseek", config, {}, () => fixedNow);

    expect(manifest).toMatchObject({
      id: "deepseek-deepseek-v4-flash",
      ownership: "third-party/provider-api",
      provider: "deepseek",
      health: { status: "offline" },
      model: { digest: "provider-managed", contextLength: 1000000 },
    });
    expect(JSON.stringify(manifest)).not.toContain("API_KEY");
  });

  it("reports configured Kimi provider as degraded pending live verification", () => {
    const config = parseRunnerConfig({});
    const manifest = providerManifest(
      "kimi",
      config,
      { MOONSHOT_API_KEY: "secret-value", MOONSHOT_MODEL: "kimi-k2.6" },
      () => fixedNow,
    );

    expect(manifest).toMatchObject({
      id: "kimi-kimi-k2-6",
      provider: "kimi",
      health: { status: "degraded" },
      model: {
        digest: "provider-managed",
        tag: "kimi-k2.6",
        source: "Moonshot Kimi API",
        contextLength: 1000000,
      },
    });
    expect(JSON.stringify(manifest)).not.toContain("secret-value");
  });

  it("uses current Kimi default model and allows provider model override", () => {
    const config = parseRunnerConfig({});

    expect(providerManifest("kimi", config, { MOONSHOT_API_KEY: "secret-value" }, () => fixedNow)).toMatchObject({
      id: "kimi-kimi-k2-7-code",
      model: { tag: "kimi-k2.7-code" },
    });
    expect(
      providerManifest("deepseek", config, { DEEPSEEK_API_KEY: "secret-value", DEEPSEEK_MODEL: "deepseek-v4-pro" }, () =>
        fixedNow,
      ),
    ).toMatchObject({
      id: "deepseek-deepseek-v4-pro",
      model: { tag: "deepseek-v4-pro" },
    });
    expect(providerManifest("qwen", config, { QWEN_API_KEY: "secret-value" }, () => fixedNow)).toMatchObject({
      id: "qwen-qwen-plus",
      provider: "qwen",
      model: {
        tag: "qwen-plus",
        source: "Alibaba Cloud Model Studio Qwen API",
      },
    });
    expect(providerManifest("zhipu", config, { ZHIPU_API_KEY: "secret-value" }, () => fixedNow)).toMatchObject({
      id: "zhipu-glm-5-3",
      provider: "zhipu",
      model: {
        tag: "glm-5.3",
        source: "Z.AI / Zhipu AI OpenAI-compatible API",
      },
    });
  });

  it("registers multiple provider API models without exposing credentials", () => {
    const config = parseRunnerConfig({});
    const manifests = providerManifests(
      config,
      {
        MOONSHOT_API_KEY: "secret-value",
        MOONSHOT_MODELS: "kimi-k2.7-code,kimi-k3 kimi-k2.6",
        DEEPSEEK_API_KEY: "secret-value",
        DEEPSEEK_MODELS: "deepseek-chat,deepseek-reasoner",
      },
      () => fixedNow,
    );

    expect(manifests.map((manifest) => manifest.id)).toEqual(expect.arrayContaining([
      "kimi-kimi-k2-7-code",
      "kimi-kimi-k3",
      "kimi-kimi-k2-6",
      "deepseek-deepseek-chat",
      "deepseek-deepseek-reasoner",
    ]));
    expect(JSON.stringify(manifests)).not.toContain("secret-value");
    expect(readProviderModels(PROVIDERS.kimi, { MOONSHOT_MODEL: "kimi-k3" })).toEqual(["kimi-k3"]);
  });

  it("rejects provider model overrides that look like local Ollama tags", () => {
    const config = parseRunnerConfig({});

    expect(() =>
      providerManifest(
        "deepseek",
        config,
        { DEEPSEEK_API_KEY: "secret-value", DEEPSEEK_MODEL: "personal-ai-agent-runtime:v4.1" },
        () => fixedNow,
      ),
    ).toThrow("model id");
  });

  it("does not claim owner-trained when the local tag digest differs from the verified model", () => {
    const config = parseRunnerConfig({});
    const manifest = ollamaMetadataToManifest(
      {
        name: "personal-ai-agent-runtime:v4.1",
        digest: "f".repeat(64),
      },
      { capabilities: ["completion"] },
      config,
      fixedNow,
    );

    expect(manifest).toBeUndefined();
  });

  it("rejects a mismatched digest for every registered owner-trained tag", () => {
    const config = parseRunnerConfig({});

    for (const ownerModel of OwnerTrainedModels) {
      expect(
        ollamaMetadataToManifest(
          { name: ownerModel.tag, digest: "f".repeat(64) },
          { capabilities: ["completion"] },
          config,
          fixedNow,
        ),
      ).toBeUndefined();
    }
  });
});

describe("chat clients", () => {
  it("sends Ollama chat requests to loopback with stream disabled", async () => {
    const json = vi.fn().mockResolvedValue({ message: { content: "ok" } });
    const fetchMock: FetchLike = vi.fn().mockResolvedValue({ ok: true, json } as unknown as Response);
    const client = new OllamaClient(parseRunnerConfig({}), fetchMock);

    await client.chat({ model: "qwen3:8b", messages: [{ role: "user", content: "hi" }] });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/chat",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "qwen3:8b",
          messages: [{ role: "user", content: "hi" }],
          think: false,
          stream: false,
        }),
      }),
    );
  });

  it("sends OpenAI-compatible provider requests and wires timeout signals", async () => {
    const json = vi.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json } as unknown as Response);
    const client = new ProviderApiClient(PROVIDERS.deepseek, "provider-secret", 1000, 1048576, fetchMock);

    await client.chat({ messages: [{ role: "user", content: "hi" }] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.com/chat/completions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      }),
    );
    expect(init.headers).toMatchObject({ authorization: "Bearer provider-secret" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("signed control plane and runner lifecycle", () => {
  const signingKey = { keyId: "local-agent-key-1", secret: "runner-shared-secret" };
  const now = () => fixedNow;

  it("registers online manifests, processes a task, and submits a signed result", async () => {
    const manifest = localManifest();
    const lease = taskLease(manifest);
    const mockPlane = new MockControlPlane({ signingKey, leases: [lease], now });
    const controlPlane = new ControlPlaneClient({
      origin: "https://control.example",
      signingKey,
      fetchLike: mockPlane.fetch,
      now,
      nonce: sequenceNonce(),
    });
    const ollama = { chat: vi.fn().mockResolvedValue({ message: { content: "local answer" } }) };
    const runner = new LocalAgentRunner({ manifests: [manifest], controlPlane, ollamaClient: ollama, now });

    await runner.registerAll();
    await runner.heartbeat();
    await expect(runner.pollOnce()).resolves.toBe("processed");

    expect(mockPlane.manifests).toHaveLength(1);
    expect(mockPlane.heartbeats).toEqual([[manifest.id]]);
    expect(mockPlane.results).toHaveLength(1);
    expect(mockPlane.results[0]).toMatchObject({ status: "succeeded", output: "local answer", leaseId: lease.leaseId });
    expect(ollama.chat).toHaveBeenCalledTimes(1);
  });

  it("returns cached terminal results for duplicate leases without calling the model twice", async () => {
    const manifest = localManifest();
    const lease = taskLease(manifest);
    const mockPlane = new MockControlPlane({ signingKey, leases: [lease, lease], now });
    const controlPlane = new ControlPlaneClient({
      origin: "https://control.example",
      signingKey,
      fetchLike: mockPlane.fetch,
      now,
      nonce: sequenceNonce(),
    });
    const ollama = { chat: vi.fn().mockResolvedValue({ message: { content: "deduped answer" } }) };
    const runner = new LocalAgentRunner({ manifests: [manifest], controlPlane, ollamaClient: ollama, now });

    await runner.pollOnce();
    await runner.pollOnce();

    expect(ollama.chat).toHaveBeenCalledTimes(1);
    expect(mockPlane.results).toHaveLength(2);
    expect(mockPlane.results[0]).toEqual(mockPlane.results[1]);
  });

  it("backs off as a no-op when the control plane is offline or has no lease", async () => {
    const manifest = localManifest();
    const mockPlane = new MockControlPlane({ signingKey, now });
    const controlPlane = new ControlPlaneClient({
      origin: "https://control.example",
      signingKey,
      fetchLike: mockPlane.fetch,
      now,
      nonce: sequenceNonce(),
    });
    const runner = new LocalAgentRunner({
      manifests: [manifest],
      controlPlane,
      ollamaClient: { chat: vi.fn() },
      now,
    });

    await expect(runner.pollOnce()).resolves.toBe("idle");
    mockPlane.offline = true;
    await expect(runner.pollOnce()).resolves.toBe("idle");
  });

  it("rejects signature nonce replay and body hash mismatch", async () => {
    const mockPlane = new MockControlPlane({ signingKey, now });
    const body = JSON.stringify({ agentIds: ["qwen3-8b"], at: fixedNow.toISOString() });
    const headers = signRequest("POST", "/agents/heartbeat", body, { key: signingKey, now, nonce: () => "same-nonce" });

    const first = await mockPlane.fetch("https://control.example/agents/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", ...signedHeaders(headers) },
      body,
    });
    const replay = await mockPlane.fetch("https://control.example/agents/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", ...signedHeaders(headers) },
      body,
    });
    const tampered = await mockPlane.fetch("https://control.example/agents/heartbeat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signedHeaders(
          signRequest("POST", "/agents/heartbeat", body, { key: signingKey, now, nonce: () => "fresh-nonce" }),
        ),
      },
      body: JSON.stringify({ agentIds: ["qwen3-8b"], at: "2026-08-22T12:00:01.000Z" }),
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: "nonce replay" });
    expect(tampered.status).toBe(401);
    expect(await tampered.json()).toMatchObject({ error: "body hash mismatch" });
  });

  it("does not call a model when lease identity differs from the registered manifest", async () => {
    const manifest = localManifest();
    const lease = taskLease(manifest, { model: { tag: "qwen3:14b", digest: "c".repeat(64) } });
    const mockPlane = new MockControlPlane({ signingKey, leases: [lease], now });
    const controlPlane = new ControlPlaneClient({
      origin: "https://control.example",
      signingKey,
      fetchLike: mockPlane.fetch,
      now,
      nonce: sequenceNonce(),
    });
    const ollama = { chat: vi.fn() };
    const runner = new LocalAgentRunner({ manifests: [manifest], controlPlane, ollamaClient: ollama, now });

    await runner.pollOnce();

    expect(ollama.chat).not.toHaveBeenCalled();
    expect(mockPlane.results[0]).toMatchObject({
      status: "failed",
      error: { code: "VALIDATION_FAILED" },
      agentId: manifest.id,
      model: { tag: "qwen3:14b", digest: "c".repeat(64) },
    });
  });

  it("uses provider-managed agentId and registered model identity when submitting provider results", async () => {
    const config = parseRunnerConfig({});
    const manifest = providerManifest("kimi", config, { MOONSHOT_API_KEY: "configured" }, () => fixedNow);
    const lease = taskLease(manifest);
    const mockPlane = new MockControlPlane({ signingKey, leases: [lease], now });
    const controlPlane = new ControlPlaneClient({
      origin: "https://control.example",
      signingKey,
      fetchLike: mockPlane.fetch,
      now,
      nonce: sequenceNonce(),
    });
    const kimi = { chat: vi.fn().mockResolvedValue({ choices: [{ message: { content: "provider answer" } }] }) };
    const runner = new LocalAgentRunner({
      manifests: [manifest],
      controlPlane,
      ollamaClient: { chat: vi.fn() },
      providerClients: { kimi },
      now,
    });

    await runner.pollOnce();

    expect(kimi.chat).toHaveBeenCalledWith(
      { model: manifest.model.tag, messages: [{ role: "user", content: "Give a concise status update." }] },
      expect.any(AbortSignal),
    );
    expect(mockPlane.results[0]).toMatchObject({
      agentId: manifest.id,
      model: { tag: manifest.model.tag, digest: "provider-managed" },
      output: "provider answer",
    });
  });
});

function localManifest(): AgentManifest {
  return ollamaMetadataToManifest(
    {
      name: "qwen3:8b",
      digest: "b".repeat(64),
    },
    {
      capabilities: ["completion"],
      model_info: {
        "general.architecture": "qwen3",
      },
    },
    parseRunnerConfig({}),
    fixedNow,
  )!;
}

function taskLease(manifest: AgentManifest, overrides: Partial<AgentTaskLease> = {}): AgentTaskLease {
  return {
    taskId: "11111111-1111-4111-8111-111111111111",
    requestId: "22222222-2222-4222-8222-222222222222",
    runId: "33333333-3333-4333-8333-333333333333",
    leaseId: "44444444-4444-4444-8444-444444444444",
    agentId: manifest.id,
    model: {
      tag: manifest.model.tag,
      digest: manifest.model.digest,
    },
    prompt: "Give a concise status update.",
    issuedAt: "2026-08-22T12:00:00.000Z",
    expiresAt: "2026-08-22T12:02:00.000Z",
    nonce: "nonce-lease-001",
    ...overrides,
  };
}

function sequenceNonce(): () => string {
  let index = 0;
  return () => `nonce-${(index += 1)}`;
}
