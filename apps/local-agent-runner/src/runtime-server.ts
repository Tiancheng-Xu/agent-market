import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { AgentManifest } from "@agent-market/shared-contracts";

import { parseRunnerConfig, type RunnerEnv } from "./config";
import { discoverOllamaManifests, ollamaMetadataToManifest } from "./model-registry";
import { OllamaClient } from "./ollama-client";
import { providerManifests } from "./provider-adapters";
import {
  PROVIDERS,
  ProviderApiClient,
  readProviderApiKey,
  readProviderBaseUrl,
  readProviderModel,
  type ProviderName,
} from "./provider-api-client";
import { createLocalStreamRuntime } from "./stream-runtime";
import { createFileModelScoreStore } from "./model-score-store";

const env = loadRuntimeEnv();
const config = parseRunnerConfig(env);
const ollamaClient = new OllamaClient(config);
const providerClients = buildProviderClients(env);
const manifests = await buildManifests(env, config, ollamaClient);
const signingSecret = env.AGENT_RUNTIME_SHARED_SECRET;
if (!signingSecret) {
  throw new Error("AGENT_RUNTIME_SHARED_SECRET is required for local stream runtime");
}

const runtime = createLocalStreamRuntime({
  manifests,
  ollamaClient,
  providerClients,
  signingKey: { keyId: env.AGENT_RUNTIME_KEY_ID ?? "edge-runtime-v1", secret: signingSecret },
  scoreStore: createFileModelScoreStore(env.AGENT_SCORE_STORE_PATH ?? `${env.HOME ?? "."}/.agent-market/model-scores.json`),
});

const host = "127.0.0.1";
const port = parsePort(env.LOCAL_AGENT_RUNTIME_PORT);
const server = createServer((incoming, outgoing) => {
  void handleNodeRequest(incoming, outgoing);
});

server.listen(port, host, () => {
  console.info(JSON.stringify({
    event: "local-runtime.ready",
    host,
    port,
    agents: manifests.map((manifest) => ({
      id: manifest.id,
      provider: manifest.provider,
      status: manifest.health.status,
    })),
  }));
});

process.once("SIGINT", () => closeServer());
process.once("SIGTERM", () => closeServer());

async function handleNodeRequest(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  try {
    const body = incoming.method === "GET" || incoming.method === "HEAD" ? undefined : await readBody(incoming);
    const init: RequestInit = {
      method: incoming.method ?? "GET",
      headers: incoming.headers as HeadersInit,
    };
    if (body !== undefined) init.body = body;
    const request = new Request(`http://127.0.0.1:${port}${incoming.url ?? "/"}`, init);
    const response = await runtime.fetch(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body === null) {
      outgoing.end();
    } else {
      await writeWebResponseBody(response.body, outgoing);
    }
  } catch {
    outgoing.writeHead(500, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ code: "INTERNAL", message: "runtime request failed", retryable: true }));
  }
}

async function writeWebResponseBody(body: ReadableStream<Uint8Array>, outgoing: ServerResponse): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) outgoing.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    outgoing.end();
  }
}

function loadRuntimeEnv(): RunnerEnv {
  const localEnvPath = new URL("../.env.local", import.meta.url);
  const values: RunnerEnv = { ...process.env };
  if (!existsSync(localEnvPath)) return values;

  const content = readFileSync(localEnvPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index);
    const value = trimmed.slice(index + 1).replace(/^['"]|['"]$/g, "");
    values[key] = value;
  }
  return values;
}

async function buildManifests(
  env: RunnerEnv,
  currentConfig: ReturnType<typeof parseRunnerConfig>,
  currentOllamaClient: OllamaClient,
): Promise<AgentManifest[]> {
  const provider = providerManifests(currentConfig, env);
  try {
    return [...await discoverOllamaManifests(currentOllamaClient, currentConfig), ...provider];
  } catch {
    return [offlineOwnerManifest(currentConfig), ...provider];
  }
}

function buildProviderClients(env: RunnerEnv): Partial<Record<ProviderName, ProviderApiClient>> {
  const clients: Partial<Record<ProviderName, ProviderApiClient>> = {};
  for (const provider of Object.keys(PROVIDERS) as ProviderName[]) {
    const definition = PROVIDERS[provider];
    const key = readProviderApiKey(definition, env);
    if (key === undefined) continue;
    const baseDefinition = { ...definition, baseUrl: readProviderBaseUrl(definition, env) };
    clients[provider] = new ProviderApiClient(
      baseDefinition,
      key,
      config.timeoutMs,
      config.maxPayloadBytes,
      fetch,
      readProviderModel(definition, env),
    );
  }
  return clients;
}

function offlineOwnerManifest(currentConfig: ReturnType<typeof parseRunnerConfig>): AgentManifest {
  const manifest = ollamaMetadataToManifest(
    {
      name: currentConfig.defaultOwnerModel,
      digest: currentConfig.defaultOwnerModelDigest,
      details: { family: "qwen3", parameter_size: "8.2B", quantization_level: "Q4_K_M" },
    },
    {
      capabilities: ["completion", "thinking", "tools"],
      model_info: { "llama.context_length": 40960 },
    },
    currentConfig,
  );
  if (manifest === undefined) throw new Error("owner manifest could not be built");
  return { ...manifest, health: { status: "offline" } };
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? "8789");
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error("LOCAL_AGENT_RUNTIME_PORT must be an integer from 1024 to 65535");
  }
  return parsed;
}

async function readBody(incoming: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function closeServer(): void {
  server.close(() => {
    console.info(JSON.stringify({ event: "local-runtime.stopped" }));
  });
}
