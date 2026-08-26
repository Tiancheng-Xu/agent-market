import { describe, expect, it, vi } from "vitest";

import type { AgentManifest } from "@agent-market/shared-contracts";

import { createLocalStreamRuntime } from "./stream-runtime";
import { signedHeaders, signRequest } from "./signing";

const now = () => new Date("2026-08-22T12:00:00.000Z");
const signingKey = { keyId: "edge-runtime-v1", secret: "runtime-secret" };

describe("local stream runtime", () => {
  it("reports public health without private endpoints", async () => {
    const runtime = createLocalStreamRuntime({
      manifests: [manifest()],
      ollamaClient: { chatStream: vi.fn() },
      now,
    });

    const response = await runtime.fetch(new Request("http://127.0.0.1:8789/healthz"));
    const body = await response.json();

    expect(body).toMatchObject({ status: "online", runtime: "local-runtime" });
    expect(JSON.stringify(body)).not.toContain("11434");
  });

  it("reports degraded health when only provider API agents are configured", async () => {
    const runtime = createLocalStreamRuntime({
      manifests: [{ ...manifest(), provider: "deepseek", id: "deepseek-deepseek-v4-flash", displayName: "DeepSeek V4 Flash", ownership: "third-party/provider-api", model: { ...manifest().model, tag: "deepseek-v4-flash", digest: "provider-managed" }, health: { status: "degraded" } }],
      ollamaClient: { chatStream: vi.fn() },
      now,
    });

    const response = await runtime.fetch(new Request("http://127.0.0.1:8789/healthz"));
    const body = await response.json();

    expect(body).toMatchObject({ status: "degraded" });
  });

  it("streams signed Ollama chat deltas and done events", async () => {
    const runtime = createLocalStreamRuntime({
      manifests: [manifest()],
      ollamaClient: {
        async chatStream(_request, onDelta) {
          onDelta({ content: "hello", raw: {} });
          onDelta({ content: " world", raw: {} });
        },
      },
      signingKey,
      now,
    });
    const body = JSON.stringify({
      requestId: "11111111-1111-4111-8111-111111111111",
      agentId: "personal-ai-agent-runtime-v4-1",
      messages: [{ role: "user", content: "hi" }],
    });
    const headers = signRequest("POST", "/agent/chat", body, { key: signingKey, now, nonce: () => "nonce-1" });

    const response = await runtime.fetch(new Request("http://127.0.0.1:8789/agent/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-caller-scope": "owner", ...signedHeaders(headers) },
      body,
    }));
    const text = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain("event: meta");
    expect(text).toContain("hello");
    expect(text).toContain("event: done");
  });

  it("rejects unsigned runtime chat requests", async () => {
    const runtime = createLocalStreamRuntime({
      manifests: [manifest()],
      ollamaClient: { chatStream: vi.fn() },
      signingKey,
      now,
    });

    const response = await runtime.fetch(new Request("http://127.0.0.1:8789/agent/chat", {
      method: "POST",
      body: JSON.stringify({ agentId: "personal-ai-agent-runtime-v4-1", messages: [{ role: "user", content: "hi" }] }),
    }));

    expect(response.status).toBe(401);
  });

  it("rejects owner-only chat from a public caller without invoking Ollama", async () => {
    const chatStream = vi.fn();
    const runtime = createLocalStreamRuntime({ manifests: [manifest()], ollamaClient: { chatStream }, signingKey, now });
    const body = JSON.stringify({
      requestId: "11111111-1111-4111-8111-111111111111",
      agentId: "personal-ai-agent-runtime-v4-1",
      messages: [{ role: "user", content: "hi" }],
    });
    const headers = signRequest("POST", "/agent/chat", body, { key: signingKey, now, nonce: () => "public-owner-only" });

    const response = await runtime.fetch(new Request("http://127.0.0.1:8789/agent/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...signedHeaders(headers) },
      body,
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "FORBIDDEN", retryable: false });
    expect(chatStream).not.toHaveBeenCalled();
  });

  it("rejects a replayed signed request before a second model call", async () => {
    const chatStream = vi.fn(async (_request, onDelta) => onDelta({ content: "ok", raw: {} }));
    const runtime = createLocalStreamRuntime({ manifests: [manifest()], ollamaClient: { chatStream }, signingKey, now });
    const body = JSON.stringify({
      requestId: "11111111-1111-4111-8111-111111111111",
      agentId: "personal-ai-agent-runtime-v4-1",
      messages: [{ role: "user", content: "hi" }],
    });
    const signed = signRequest("POST", "/agent/chat", body, { key: signingKey, now, nonce: () => "single-use-nonce" });
    const request = () => new Request("http://127.0.0.1:8789/agent/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-caller-scope": "owner", ...signedHeaders(signed) },
      body,
    });

    expect((await runtime.fetch(request())).status).toBe(200);
    const replay = await runtime.fetch(request());

    expect(replay.status).toBe(401);
    expect(chatStream).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "provider failure", expectedCode: "MODEL_UNAVAILABLE", abort: false, timeoutMs: 1_000 },
    { name: "runtime timeout", expectedCode: "UPSTREAM_TIMEOUT", abort: false, timeoutMs: 5 },
    { name: "user cancellation", expectedCode: "CANCELLED", abort: true, timeoutMs: 1_000 },
  ])("returns an explicit GraphQL terminal error for $name", async ({ expectedCode, abort, timeoutMs }) => {
    const provider = providerManifest();
    const controller = new AbortController();
    const runtime = createLocalStreamRuntime({
      manifests: [manifest(), provider],
      ollamaClient: {
        chatStream: async (_request, onDelta, signal) => {
          if (expectedCode === "MODEL_UNAVAILABLE") {
            onDelta({ content: "local", raw: {} });
            return;
          }
          await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("model request aborted")), { once: true }));
        },
      },
      providerClients: {
        deepseek: {
          chat: expectedCode === "MODEL_UNAVAILABLE"
            ? vi.fn().mockRejectedValue(new Error("provider unavailable"))
            : vi.fn().mockResolvedValue({ content: "provider" }),
        },
      },
      signingKey,
      now,
      requestTimeoutMs: timeoutMs,
    });
    const body = JSON.stringify({
      query: "mutation OrchestrateAgents($input: AgentOrchestrationInput!) { orchestrateAgents(input: $input) { finalOutput } }",
      operationName: "OrchestrateAgents",
      variables: { input: { requestId: "11111111-1111-4111-8111-111111111111", agentIds: [manifest().id, provider.id], messages: [{ role: "user", content: "hi" }] } },
    });
    const signed = signRequest("POST", "/graphql", body, { key: signingKey, now, nonce: () => `terminal-${expectedCode}` });
    const responsePromise = runtime.fetch(new Request("http://127.0.0.1:8789/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-caller-scope": "owner", ...signedHeaders(signed) },
      body,
      signal: controller.signal,
    }));
    if (abort) setTimeout(() => controller.abort(), 1);
    const payload = await (await responsePromise).json();

    expect(payload.errors[0].extensions.code).toBe(expectedCode);
    expect(payload.data).toBeNull();
  });

  it("runs signed GraphQL orchestration through selected agents and lead synthesis", async () => {
    const localAgent = manifest();
    const providerAgent: AgentManifest = {
      ...manifest(),
      id: "deepseek-deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      ownership: "third-party/provider-api",
      provider: "deepseek",
      model: {
        ...manifest().model,
        tag: "deepseek-v4-flash",
        digest: "provider-managed",
        family: "deepseek",
        parameterSize: "provider-managed",
        quantization: "provider-managed",
        source: "DeepSeek API",
      },
    };
    const providerChat = vi.fn().mockResolvedValueOnce({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      content: "provider answer",
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    const runtime = createLocalStreamRuntime({
      manifests: [localAgent, providerAgent],
      ollamaClient: {
        async chatStream(_request, onDelta) {
          onDelta({ content: "local answer", raw: {} });
        },
      },
      providerClients: { deepseek: { chat: providerChat } },
      signingKey,
      now,
    });
    const body = JSON.stringify({
      query: "mutation OrchestrateAgents($input: AgentOrchestrationInput!) { orchestrateAgents(input: $input) { finalOutput } }",
      operationName: "OrchestrateAgents",
      variables: {
        input: {
          requestId: "11111111-1111-4111-8111-111111111111",
          agentIds: [localAgent.id, providerAgent.id],
          messages: [{ role: "user", content: "hi" }],
        },
      },
    });
    const headers = signRequest("POST", "/graphql", body, { key: signingKey, now, nonce: () => "nonce-graphql" });

    const response = await runtime.fetch(new Request("http://127.0.0.1:8789/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-caller-scope": "owner", ...signedHeaders(headers) },
      body,
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      data: {
        orchestrateAgents: {
          requestId: "11111111-1111-4111-8111-111111111111",
          status: "succeeded",
          leadAgentId: localAgent.id,
          finalOutput: "local answer",
          steps: [
            { agentId: localAgent.id, output: "local answer" },
            { agentId: providerAgent.id, output: "provider answer" },
          ],
        },
      },
    });
  });

  it("routes signed Queen GraphQL mutations to the state-machine orchestrator", async () => {
    const runtime = createLocalStreamRuntime({
      manifests: [manifest()],
      ollamaClient: { chatStream: vi.fn() },
      signingKey,
      now,
    });
    const body = JSON.stringify({
      query: "mutation ProposeTaskGraph($input: ProposeTaskGraphInput!) { proposeTaskGraph(input: $input) { taskId } }",
      operationName: "ProposeTaskGraph",
      variables: {
        input: {
          requirement: "Build a verified agent workflow",
          queenAgentId: "queen-router-v1",
        },
      },
    });
    const headers = signRequest("POST", "/graphql", body, { key: signingKey, now, nonce: () => "nonce-queen" });

    const response = await runtime.fetch(new Request("http://127.0.0.1:8789/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", ...signedHeaders(headers) },
      body,
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data.proposeTaskGraph.rescuePolicy).toMatchObject({
      mode: "auto",
      visibleToUser: false,
    });
    expect(payload.data.proposeTaskGraph.nodes.map((node: { type: string }) => node.type)).toContain("deliver");
  });

  it("rejects unsigned Queen GraphQL runtime requests", async () => {
    const runtime = createLocalStreamRuntime({
      manifests: [manifest()],
      ollamaClient: { chatStream: vi.fn() },
      signingKey,
      now,
    });

    const response = await runtime.fetch(new Request("http://127.0.0.1:8789/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "mutation ProposeTaskGraph($input: ProposeTaskGraphInput!) { proposeTaskGraph(input: $input) { taskId } }",
        operationName: "ProposeTaskGraph",
        variables: { input: { requirement: "Build workflow" } },
      }),
    }));

    expect(response.status).toBe(401);
  });

  it("executes Queen node output through the configured local agent client", async () => {
    const runtime = createLocalStreamRuntime({
      manifests: [manifest()],
      ollamaClient: {
        async chatStream(_request, onDelta) {
          onDelta({ content: "runtime executor output", raw: {} });
        },
      },
      signingKey,
      now,
    });
    let nonceIndex = 0;
    const mutateRuntime = async (operationName: string, query: string, input: Record<string, unknown>) => {
      const body = JSON.stringify({ query, operationName, variables: { input } });
      const signed = signRequest("POST", "/graphql", body, {
        key: signingKey,
        now,
        nonce: () => `nonce-runtime-${operationName}-${nonceIndex++}`,
      });
      const response = await runtime.fetch(new Request("http://127.0.0.1:8789/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-caller-scope": "owner", ...signedHeaders(signed) },
        body,
      }));
      return response.json();
    };
    const proposedPayload = await mutateRuntime(
      "ProposeTaskGraph",
      "mutation ProposeTaskGraph($input: ProposeTaskGraphInput!) { proposeTaskGraph(input: $input) { taskId nodes { nodeId required } } }",
      { requirement: "Build workflow", queenAgentId: "queen-router-v1" },
    );
    const taskId = proposedPayload.data.proposeTaskGraph.taskId;
    for (const node of proposedPayload.data.proposeTaskGraph.nodes.filter((item: { required: boolean }) => item.required)) {
      await mutateRuntime(
        "AcceptNodeAssignment",
        "mutation AcceptNodeAssignment($input: AcceptNodeAssignmentInput!) { acceptNodeAssignment(input: $input) { status } }",
        { taskId, nodeId: node.nodeId, agentId: "personal-ai-agent-runtime-v4-1" },
      );
    }
    await mutateRuntime(
      "ConfirmTaskGraph",
      "mutation ConfirmTaskGraph($input: ConfirmTaskGraphInput!) { confirmTaskGraph(input: $input) { confirmationStatus } }",
      { taskId },
    );
    await mutateRuntime(
      "StartTaskRun",
      "mutation StartTaskRun($input: StartTaskRunInput!) { startTaskRun(input: $input) { status } }",
      { taskId },
    );
    const payload = await mutateRuntime(
      "SubmitNodeOutput",
      "mutation SubmitNodeOutput($input: SubmitNodeOutputInput!) { submitNodeOutput(input: $input) { output } }",
      { taskId, nodeId: "execute-1", executorAgentId: "personal-ai-agent-runtime-v4-1" },
    );

    expect(payload.data.submitNodeOutput.output).toBe("runtime executor output");
  });
});

function manifest(): AgentManifest {
  return {
    id: "personal-ai-agent-runtime-v4-1",
    displayName: "Personal AI Agent Runtime v4.1",
    ownership: "owner-trained",
    provider: "ollama",
    capabilities: ["completion"],
    toolSchemas: [],
    model: {
      tag: "personal-ai-agent-runtime:v4.1",
      digest: "2c422ec890241b8492e08d4ba69f79f25efcf8ae4220e83797d2df9cbc7eb52a",
      family: "qwen3",
      parameterSize: "8.2B",
      quantization: "Q4_K_M",
      contextLength: 40960,
      source: "owner-trained",
      license: "pending metadata",
    },
    health: {
      status: "online",
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
}

function providerManifest(): AgentManifest {
  return {
    ...manifest(),
    id: "deepseek-deepseek-v4-flash",
    displayName: "DeepSeek V4 Flash",
    ownership: "third-party/provider-api",
    provider: "deepseek",
    model: {
      ...manifest().model,
      tag: "deepseek-v4-flash",
      digest: "provider-managed",
      family: "deepseek",
      parameterSize: "provider-managed",
      quantization: "provider-managed",
      source: "DeepSeek API",
    },
    access: { visibility: "marketplace", selectableBy: "public-market" },
  };
}
