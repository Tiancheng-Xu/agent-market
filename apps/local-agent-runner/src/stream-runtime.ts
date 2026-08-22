import {
  LiveAgentGraphqlRequestSchema,
  LiveChatHealthSchema,
  LiveChatRequestSchema,
  LiveChatSseEventSchema,
  QueenGraphqlRequestSchema,
  type AgentManifest,
  type AgentCandidate,
  type LiveAgentOrchestrationInput,
  type LiveAgentHealth,
  type LiveChatError,
  type LiveChatMessage,
  type LiveChatRequest,
} from "@agent-market/shared-contracts";

import type { ChatMessage, OllamaClient } from "./ollama-client";
import type { ProviderApiClient, ProviderName } from "./provider-api-client";
import { createQueenOrchestrator } from "./queen-orchestrator";
import { verifySignedRequest, type SigningKey } from "./signing";

type OllamaStreamingClient = Pick<OllamaClient, "chatStream">;
type ProviderClients = Partial<Record<ProviderName, Pick<ProviderApiClient, "chat">>>;

export type LocalStreamRuntimeOptions = {
  manifests: AgentManifest[];
  ollamaClient: OllamaStreamingClient;
  providerClients?: ProviderClients;
  signingKey?: SigningKey;
  now?: () => Date;
  requestTimeoutMs?: number;
};

type CallerAccess = {
  scope: "public" | "owner";
};

export function createLocalStreamRuntime(options: LocalStreamRuntimeOptions) {
  const manifests = new Map(options.manifests.map((manifest) => [manifest.id, manifest]));
  const now = options.now ?? (() => new Date());
  const queenAgents = agentCandidatesFromManifests([...manifests.values()], now);
  const publicQueenOrchestrator = createQueenOrchestrator({
    agents: queenAgents,
    queenAgentId: "queen-router-v1",
    now,
    executeAgentText: async (request) => {
      const manifest = manifests.get(request.agentId);
      if (manifest === undefined || manifest.health.status === "offline") {
        throw new Error(`Agent ${request.agentId} is unavailable`);
      }
      if (!canSelectManifest(manifest, { scope: "public" })) {
        throw new Error(`Agent ${request.agentId} is owner-only for this caller`);
      }
      return executeAgentText({
        manifest,
        messages: request.messages,
        ollamaClient: options.ollamaClient,
        providerClients: options.providerClients ?? {},
        signal: AbortSignal.timeout(options.requestTimeoutMs ?? manifest.limits.timeoutMs),
      });
    },
  });
  const ownerQueenOrchestrator = createQueenOrchestrator({
    agents: agentCandidatesFromManifests([...manifests.values()], now),
    queenAgentId: "queen-router-v1",
    now,
    allowOwnerOnlyAgents: true,
    executeAgentText: async (request) => {
      const manifest = manifests.get(request.agentId);
      if (manifest === undefined || manifest.health.status === "offline") {
        throw new Error(`Agent ${request.agentId} is unavailable`);
      }
      return executeAgentText({
        manifest,
        messages: request.messages,
        ollamaClient: options.ollamaClient,
        providerClients: options.providerClients ?? {},
        signal: AbortSignal.timeout(options.requestTimeoutMs ?? manifest.limits.timeoutMs),
      });
    },
  });

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json(publicHealth([...manifests.values()], now), {
          headers: { "cache-control": "no-store" },
        });
      }

      if (request.method !== "POST" || (url.pathname !== "/agent/chat" && url.pathname !== "/graphql")) {
        return jsonError("FORBIDDEN", "Runtime route is not exposed", undefined, false, 404);
      }

      const body = await request.text();
      if (options.signingKey !== undefined) {
        const verified = verifySignedRequest("POST", url.pathname, body, request.headers, {
          keys: { [options.signingKey.keyId]: options.signingKey.secret },
          now,
        });
        if (!verified.ok) {
          return jsonError("UNAUTHORIZED", "Runtime assertion failed", undefined, false, 401);
        }
      }

      if (url.pathname === "/graphql") {
        return handleGraphqlOrchestration({
          body,
          manifests,
          ollamaClient: options.ollamaClient,
          providerClients: options.providerClients ?? {},
          callerAccess: callerAccessFromHeaders(request.headers),
          queenOrchestrator: callerAccessFromHeaders(request.headers).scope === "owner" ? ownerQueenOrchestrator : publicQueenOrchestrator,
          requestSignal: request.signal,
          requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
        });
      }

      let payload: LiveChatRequest;
      try {
        payload = LiveChatRequestSchema.parse(JSON.parse(body));
      } catch {
        return jsonError("VALIDATION_FAILED", "Chat request shape is invalid", undefined, false, 400);
      }

      const manifest = manifests.get(payload.agentId);
      if (manifest === undefined || manifest.health.status === "offline") {
        return jsonError("MODEL_UNAVAILABLE", "Requested agent is unavailable", payload.requestId, true, 503);
      }
      if (!canSelectManifest(manifest, callerAccessFromHeaders(request.headers))) {
        return jsonError("FORBIDDEN", "Requested agent is owner-only for this caller", payload.requestId, false, 403);
      }

      return streamChat({
        manifest,
        payload,
        ollamaClient: options.ollamaClient,
        providerClients: options.providerClients ?? {},
        now,
        requestSignal: request.signal,
        requestTimeoutMs: options.requestTimeoutMs ?? manifest.limits.timeoutMs,
      });
    },
  };
}

async function handleGraphqlOrchestration(options: {
  body: string;
  manifests: Map<string, AgentManifest>;
  ollamaClient: OllamaStreamingClient;
  providerClients: ProviderClients;
  queenOrchestrator: ReturnType<typeof createQueenOrchestrator>;
  callerAccess: CallerAccess;
  requestSignal: AbortSignal;
  requestTimeoutMs: number;
}): Promise<Response> {
  let raw: unknown;
  try {
    raw = JSON.parse(options.body);
  } catch {
    return graphqlError("VALIDATION_FAILED", "GraphQL request shape is invalid", undefined, false, 400);
  }

  const queenRequest = QueenGraphqlRequestSchema.safeParse(raw);
  if (queenRequest.success && isQueenGraphqlOperation(queenRequest.data)) {
    const result = await options.queenOrchestrator.handleGraphql(queenRequest.data);
    return Response.json(result, {
      headers: { "cache-control": "no-store" },
    });
  }

  let request: ReturnType<typeof LiveAgentGraphqlRequestSchema.parse>;
  try {
    request = LiveAgentGraphqlRequestSchema.parse(raw);
  } catch {
    return graphqlError("VALIDATION_FAILED", "GraphQL request shape is invalid", undefined, false, 400);
  }

  if (!/\borchestrateAgents\b/.test(request.query)) {
    return graphqlError("VALIDATION_FAILED", "Only orchestrateAgents mutation is supported", request.variables.input.requestId, false, 400);
  }

  const requestId = request.variables.input.requestId ?? crypto.randomUUID();
  const runId = crypto.randomUUID();
  const timeout = AbortSignal.timeout(options.requestTimeoutMs);
  const signal = AbortSignal.any([options.requestSignal, timeout]);

  try {
    const result = await runSequentialOrchestration({
      input: { ...request.variables.input, requestId },
      runId,
      manifests: options.manifests,
      callerAccess: options.callerAccess,
      ollamaClient: options.ollamaClient,
      providerClients: options.providerClients,
      signal,
    });

    return Response.json({ data: { orchestrateAgents: result } }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return graphqlError(
      signal.aborted ? "UPSTREAM_TIMEOUT" : "MODEL_UNAVAILABLE",
      safeMessage(error),
      requestId,
      true,
      200,
    );
  }
}

async function runSequentialOrchestration(options: {
  input: LiveAgentOrchestrationInput & { requestId: string };
  runId: string;
  manifests: Map<string, AgentManifest>;
  callerAccess: CallerAccess;
  ollamaClient: OllamaStreamingClient;
  providerClients: ProviderClients;
  signal: AbortSignal;
}) {
  const prompt = options.input.messages[options.input.messages.length - 1]?.content ?? "";
  const outputs: Array<{ agentId: string; modelTag: string; provider: AgentManifest["provider"]; output: string }> = [];
  assertDistinctModels(options.input.agentIds, options.manifests);

  for (const [index, agentId] of options.input.agentIds.entries()) {
    const manifest = assertManifest(agentId, options.manifests, options.callerAccess);
    const messages = index === 0 ? options.input.messages : [{ role: "user" as const, content: buildStepPrompt(prompt, outputs) }];
    const output = await executeAgentText({
      manifest,
      messages,
      ollamaClient: options.ollamaClient,
      providerClients: options.providerClients,
      signal: options.signal,
    });
    outputs.push({ agentId, modelTag: manifest.model.tag, provider: manifest.provider, output });
  }

  const lead = assertManifest(options.input.agentIds[0]!, options.manifests, options.callerAccess);
  const finalOutput = await executeAgentText({
    manifest: lead,
    messages: [{ role: "user", content: buildFinalPrompt(prompt, outputs) }],
    ollamaClient: options.ollamaClient,
    providerClients: options.providerClients,
    signal: options.signal,
  });

  return {
    requestId: options.input.requestId,
    runId: options.runId,
    status: "succeeded",
    leadAgentId: lead.id,
    steps: outputs,
    finalOutput,
  };
}

function publicHealth(manifests: AgentManifest[], now: () => Date) {
  const agents: LiveAgentHealth[] = manifests.map((manifest) => ({
    agentId: manifest.id,
    displayName: manifest.displayName,
    provider: manifest.provider,
    ownership: manifest.ownership,
    modelTag: manifest.model.tag,
    modelDigest: manifest.model.digest,
    visibility: manifest.access.visibility,
    selectableBy: manifest.access.selectableBy,
    status: manifest.health.status,
    lastVerifiedAt: manifest.health.lastVerifiedAt,
  }));
  const status = agents.some((agent) => agent.status === "online")
    ? agents.some((agent) => agent.status === "degraded")
      ? "degraded"
      : "online"
    : agents.some((agent) => agent.status === "degraded")
      ? "degraded"
      : "offline";

  return LiveChatHealthSchema.parse({
    status,
    checkedAt: now().toISOString(),
    runtime: "local-runtime",
    agents,
    ...(status === "offline" ? { reasonCode: "RUNTIME_OFFLINE" } : {}),
  });
}

function agentCandidatesFromManifests(manifests: AgentManifest[], now: () => Date): AgentCandidate[] {
  return [
    {
      agentId: "queen-router-v1",
      displayName: "Queen Router",
      capabilities: ["plan", "completion"],
      tags: ["planner", "local-private"],
      provider: "codex",
      ownership: "local-private",
      selectableBy: "assigned-task",
      status: "online",
      costPer1kTokensUsd: 0,
      latencyMs: 0,
      qualityScore: 0.99,
      firstSeenAt: now().toISOString(),
      modelTag: "codex-local-queen",
      modelDigest: "local-private",
      riskCodes: ["local-private-preview"],
    },
    ...manifests.map((manifest) => ({
      agentId: manifest.id,
      displayName: manifest.displayName,
      capabilities: [...new Set([...manifest.capabilities, "judge", "red_team", "final_arbitration"])],
      tags: [
        manifest.provider,
        manifest.ownership,
        manifest.access.selectableBy,
        manifest.model.license,
        ...manifest.capabilities,
      ],
      license: manifest.model.license,
      provider: manifest.provider,
      ownership: manifest.ownership,
      selectableBy: manifest.access.selectableBy,
      status: manifest.health.status,
      costPer1kTokensUsd: manifest.provider === "ollama" ? 0 : 0.004,
      latencyMs: manifest.provider === "ollama" ? 1_200 : 900,
      qualityScore: manifest.health.status === "offline" ? 0 : 0.8,
      firstSeenAt: manifest.health.lastVerifiedAt ?? now().toISOString(),
      modelTag: manifest.model.tag,
      modelDigest: manifest.model.digest,
      riskCodes: manifest.health.status === "offline" ? ["offline"] : [],
    })),
  ];
}

function isQueenGraphqlOperation(request: ReturnType<typeof QueenGraphqlRequestSchema.parse>): boolean {
  if (request.operationName !== undefined) return true;
  return /\b(proposeTaskGraph|rankNodeAgents|selectNodeAgent|acceptNodeAssignment|confirmTaskGraph|startTaskRun|submitNodeOutput|judgeNodeOutput|requestAdversarialReview|repairNode|finalArbitrate|writeLearningLoop)\b/.test(request.query);
}

function streamChat(options: {
  manifest: AgentManifest;
  payload: LiveChatRequest;
  ollamaClient: OllamaStreamingClient;
  providerClients: ProviderClients;
  now: () => Date;
  requestSignal: AbortSignal;
  requestTimeoutMs: number;
}): Response {
  const encoder = new TextEncoder();
  const requestId = options.payload.requestId ?? crypto.randomUUID();
  const runId = crypto.randomUUID();
  const timeout = AbortSignal.timeout(options.requestTimeoutMs);
  const signal = AbortSignal.any([options.requestSignal, timeout]);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let outputBytes = 0;
      const send = (event: unknown) => {
        const parsed = LiveChatSseEventSchema.parse(event);
        controller.enqueue(encoder.encode(`event: ${parsed.event}\ndata: ${JSON.stringify(parsed)}\n\n`));
      };
      const sendDelta = (delta: string) => {
        outputBytes += encoder.encode(delta).byteLength;
        send({ event: "delta", requestId, delta });
      };

      try {
        send({
          event: "meta",
          requestId,
          runId,
          agentId: options.manifest.id,
          provider: options.manifest.provider,
          modelTag: options.manifest.model.tag,
        });

        if (options.manifest.provider === "ollama") {
          await options.ollamaClient.chatStream(
            { model: options.manifest.model.tag, messages: toChatMessages(options.payload.messages) },
            (delta) => sendDelta(delta.content),
            signal,
          );
        } else {
          const client = options.providerClients[options.manifest.provider];
          if (client === undefined) throw new Error("Provider client is not configured");
          const response = await client.chat(
            { model: options.manifest.model.tag, messages: toChatMessages(options.payload.messages) },
            signal,
          );
          sendDelta(extractOutput(response));
        }

        send({ event: "done", requestId, outputBytes });
      } catch (error) {
        send({
          event: "error",
          error: {
            code: signal.aborted ? "UPSTREAM_TIMEOUT" : "MODEL_UNAVAILABLE",
            message: safeMessage(error),
            requestId,
            retryable: true,
          },
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

function toChatMessages(messages: LiveChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

function assertManifest(agentId: string, manifests: Map<string, AgentManifest>, callerAccess: CallerAccess): AgentManifest {
  const manifest = manifests.get(agentId);
  if (manifest === undefined || manifest.health.status === "offline") {
    throw new Error(`Agent ${agentId} is unavailable`);
  }
  if (!canSelectManifest(manifest, callerAccess)) {
    throw new Error(`Agent ${agentId} is owner-only for this caller`);
  }
  return manifest;
}

function assertDistinctModels(agentIds: string[], manifests: Map<string, AgentManifest>): void {
  const seen = new Map<string, string>();
  for (const agentId of agentIds) {
    const manifest = manifests.get(agentId);
    const modelTag = manifest?.model.tag.toLowerCase() ?? agentId.toLowerCase();
    const previousAgentId = seen.get(modelTag);
    if (previousAgentId !== undefined) {
      throw new Error(`Sequential orchestration requires distinct models; ${previousAgentId} and ${agentId} both use ${modelTag}`);
    }
    seen.set(modelTag, agentId);
  }
}

function callerAccessFromHeaders(headers: Headers): CallerAccess {
  return headers.get("x-agent-caller-scope") === "owner" ? { scope: "owner" } : { scope: "public" };
}

function canSelectManifest(manifest: AgentManifest, callerAccess: CallerAccess): boolean {
  if (manifest.access.selectableBy !== "owner-only") return true;
  return callerAccess.scope === "owner";
}

async function executeAgentText(options: {
  manifest: AgentManifest;
  messages: LiveChatMessage[];
  ollamaClient: OllamaStreamingClient;
  providerClients: ProviderClients;
  signal: AbortSignal;
}): Promise<string> {
  if (options.manifest.provider === "ollama") {
    let output = "";
    await options.ollamaClient.chatStream(
      { model: options.manifest.model.tag, messages: toChatMessages(options.messages) },
      (delta) => {
        output += delta.content;
      },
      options.signal,
    );
    return output;
  }

  const client = options.providerClients[options.manifest.provider];
  if (client === undefined) throw new Error("Provider client is not configured");
  const response = await client.chat(
    { model: options.manifest.model.tag, messages: toChatMessages(options.messages) },
    options.signal,
  );
  return extractOutput(response);
}

function buildStepPrompt(prompt: string, outputs: Array<{ agentId: string; modelTag: string; output: string }>): string {
  return clipText([
    "Original request:",
    prompt,
    "",
    "Previous agent outputs:",
    outputs.map((item, index) => `${index + 1}. ${item.agentId} (${item.modelTag}):\n${clipText(item.output, 900)}`).join("\n\n"),
    "",
    "Add a complementary answer. Do not repeat unchanged points unless needed for correctness.",
  ].join("\n"), 3900);
}

function buildFinalPrompt(prompt: string, outputs: Array<{ agentId: string; modelTag: string; output: string }>): string {
  return clipText([
    "You are the lead orchestrator for Agent Market.",
    "Synthesize the selected agents' outputs into one final answer.",
    "Be concise, state disagreements or uncertainty, and prefer actionable decisions.",
    "",
    "Original request:",
    prompt,
    "",
    "Selected agent outputs:",
    outputs.map((item, index) => `${index + 1}. ${item.agentId} (${item.modelTag}):\n${clipText(item.output, 1100)}`).join("\n\n"),
  ].join("\n"), 3900);
}

function clipText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value;
}

function extractOutput(response: unknown): string {
  if (isRecord(response)) {
    if (typeof response["content"] === "string") return response["content"];
    const message = response["message"];
    if (isRecord(message) && typeof message["content"] === "string") return message["content"];
    const choices = response["choices"];
    if (Array.isArray(choices)) {
      const first = choices[0];
      if (isRecord(first)) {
        const choiceMessage = first["message"];
        if (isRecord(choiceMessage) && typeof choiceMessage["content"] === "string") return choiceMessage["content"];
      }
    }
  }
  return JSON.stringify(response);
}

function jsonError(
  code: LiveChatError["code"],
  message: string,
  requestId: string | undefined,
  retryable: boolean,
  status: number,
): Response {
  return Response.json({ code, message, requestId, retryable } satisfies LiveChatError, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function graphqlError(
  code: LiveChatError["code"],
  message: string,
  requestId: string | undefined,
  retryable: boolean,
  status: number,
): Response {
  return Response.json({
    data: null,
    errors: [
      {
        message,
        extensions: { code, requestId, retryable },
      },
    ],
  }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message.slice(0, 240) : "Agent runtime failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
