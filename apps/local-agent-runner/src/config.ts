export const CANONICAL_OLLAMA_ORIGIN = "http://127.0.0.1:11434";
export const DEFAULT_OWNER_MODEL = "personal-ai-agent-runtime:v4.1";
export const DEFAULT_OWNER_MODEL_DIGEST =
  "2c422ec890241b8492e08d4ba69f79f25efcf8ae4220e83797d2df9cbc7eb52a";
export const PROVIDER_MANAGED_DIGEST = "provider-managed";
export const PINNED_LAYA_MODEL_REVISION = "68f27dfe5a27a54fb2b1fefc432f43f972e90868";
export const PINNED_LAYA_MODEL_HASHES = {
  "laya.onnx": "a874eb254b58b0fcb1e7ad56fbb188c29d64e08c9a46b689433e1f52c66dba1e",
  "laya.onnx.data": "487746363a8da57bcadb4345352997d22a0fb90d70aa22c6856668d023242aba",
} as const;

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

export type JevShadowConfig = {
  enabled: boolean;
  apiKey: string | undefined;
  timeoutMs: number;
  sampleRate: number;
  maxRequests: number;
};

export type SystemOneShadowConfig =
  | { mode: "off" }
  | {
      mode: "dual-shadow";
      referenceHmacKey: string;
      laya: {
        modelDir: string;
        revision: typeof PINNED_LAYA_MODEL_REVISION;
        hashes: typeof PINNED_LAYA_MODEL_HASHES;
        timeoutMs: number;
      };
      jev: JevShadowConfig;
    };

const DEFAULT_ALLOWLIST = ["*"];
const DEFAULT_MAX_CONCURRENCY = 1;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576;
const DEFAULT_JEV_TIMEOUT_MS = 1_500;
const DEFAULT_LAYA_TIMEOUT_MS = 2_000;
const DEFAULT_JEV_SAMPLE_RATE = 0.1;
const DEFAULT_JEV_MAX_REQUESTS = 100;

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

export function parseJevShadowConfig(env: RunnerEnv = process.env): JevShadowConfig {
  const enabledValue = env.JEV_SHADOW_ENABLED?.trim().toLowerCase();
  if (enabledValue !== undefined && enabledValue !== "true" && enabledValue !== "false") {
    throw new Error("JEV_SHADOW_ENABLED must be true or false");
  }
  const apiKey = env.TYPESAFE_API_KEY?.trim();

  return {
    enabled: enabledValue === "true",
    apiKey: apiKey === undefined || apiKey === "" ? undefined : apiKey,
    timeoutMs: parseBoundedInteger(env.JEV_SHADOW_TIMEOUT_MS, DEFAULT_JEV_TIMEOUT_MS, 100, 10_000, "JEV_SHADOW_TIMEOUT_MS"),
    sampleRate: parseBoundedNumber(env.JEV_SHADOW_SAMPLE_RATE, DEFAULT_JEV_SAMPLE_RATE, 0, 1, "JEV_SHADOW_SAMPLE_RATE"),
    maxRequests: parseBoundedInteger(env.JEV_SHADOW_MAX_REQUESTS, DEFAULT_JEV_MAX_REQUESTS, 0, 100_000, "JEV_SHADOW_MAX_REQUESTS"),
  };
}

export function parseSystemOneShadowConfig(env: RunnerEnv = process.env): SystemOneShadowConfig {
  const mode = env.SYSTEM_ONE_SHADOW_MODE?.trim().toLowerCase() ?? "off";
  if (mode === "off") return { mode: "off" };
  if (mode !== "dual-shadow") {
    throw new Error("SYSTEM_ONE_SHADOW_MODE must be off or dual-shadow");
  }

  const modelDir = env.LAYA_MODEL_DIR?.trim() ?? "";
  if (!isAbsolute(modelDir)) throw new Error("LAYA_MODEL_DIR must be an absolute path");
  if (env.LAYA_MODEL_REVISION !== PINNED_LAYA_MODEL_REVISION) {
    throw new Error(`LAYA_MODEL_REVISION must be ${PINNED_LAYA_MODEL_REVISION}`);
  }
  const layaTimeoutMs = parseBoundedInteger(env.LAYA_TIMEOUT_MS, DEFAULT_LAYA_TIMEOUT_MS, 100, 10_000, "LAYA_TIMEOUT_MS");
  const referenceHmacKey = env.SYSTEM_ONE_SHADOW_HMAC_KEY?.trim() ?? "";
  if (referenceHmacKey.length < 32) throw new Error("SYSTEM_ONE_SHADOW_HMAC_KEY must contain at least 32 characters");

  return {
    mode: "dual-shadow",
    referenceHmacKey,
    laya: {
      modelDir,
      revision: PINNED_LAYA_MODEL_REVISION,
      hashes: PINNED_LAYA_MODEL_HASHES,
      timeoutMs: layaTimeoutMs,
    },
    jev: parseJevShadowConfig(env),
  };
}

function parseBoundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a number from ${minimum} to ${maximum}`);
  }
  return parsed;
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
import { isAbsolute } from "node:path";
