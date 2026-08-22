export const CANONICAL_OLLAMA_ORIGIN = "http://127.0.0.1:11434";
export const DEFAULT_OWNER_MODEL = "personal-ai-agent-runtime:v4.1";
export const DEFAULT_OWNER_MODEL_DIGEST =
  "2c422ec890241b8492e08d4ba69f79f25efcf8ae4220e83797d2df9cbc7eb52a";
export const PROVIDER_MANAGED_DIGEST = "provider-managed";

export type RunnerConfig = {
  ollamaOrigin: typeof CANONICAL_OLLAMA_ORIGIN;
  ollamaModelAllowlist: string[];
  maxConcurrency: 1 | 2;
  timeoutMs: number;
  maxPayloadBytes: number;
  defaultOwnerModel: typeof DEFAULT_OWNER_MODEL;
  defaultOwnerModelDigest: typeof DEFAULT_OWNER_MODEL_DIGEST;
};

export type RunnerEnv = Record<string, string | undefined>;

const DEFAULT_ALLOWLIST = ["*"];
const DEFAULT_MAX_CONCURRENCY = 1;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576;

export function assertCanonicalOllamaOrigin(value: string): typeof CANONICAL_OLLAMA_ORIGIN {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("OLLAMA_ORIGIN must be http://127.0.0.1:11434");
  }

  if (parsed.origin !== CANONICAL_OLLAMA_ORIGIN || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("OLLAMA_ORIGIN must be http://127.0.0.1:11434");
  }

  return CANONICAL_OLLAMA_ORIGIN;
}

export function parseRunnerConfig(env: RunnerEnv = process.env): RunnerConfig {
  return {
    ollamaOrigin: assertCanonicalOllamaOrigin(env.OLLAMA_ORIGIN ?? CANONICAL_OLLAMA_ORIGIN),
    ollamaModelAllowlist: parseAllowlist(env.LOCAL_AGENT_MODEL_ALLOWLIST),
    maxConcurrency: parseMaxConcurrency(env.LOCAL_AGENT_MAX_CONCURRENCY),
    timeoutMs: parseBoundedInteger(env.LOCAL_AGENT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 120_000, "LOCAL_AGENT_TIMEOUT_MS"),
    maxPayloadBytes: parseBoundedInteger(
      env.LOCAL_AGENT_MAX_PAYLOAD_BYTES,
      DEFAULT_MAX_PAYLOAD_BYTES,
      1_024,
      1_048_576,
      "LOCAL_AGENT_MAX_PAYLOAD_BYTES",
    ),
    defaultOwnerModel: DEFAULT_OWNER_MODEL,
    defaultOwnerModelDigest: DEFAULT_OWNER_MODEL_DIGEST,
  };
}

export function isModelAllowed(tag: string, allowlist: readonly string[]): boolean {
  return allowlist.includes("*") || allowlist.includes(tag);
}

function parseAllowlist(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_ALLOWLIST;
  }

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return entries.length > 0 ? entries : DEFAULT_ALLOWLIST;
}

function parseMaxConcurrency(value: string | undefined): 1 | 2 {
  const parsed = parseBoundedInteger(value, DEFAULT_MAX_CONCURRENCY, 1, 2, "LOCAL_AGENT_MAX_CONCURRENCY");
  return parsed === 1 ? 1 : 2;
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }

  return parsed;
}
