import { createHmac, createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { SignedRequestHeadersSchema, type SignedRequestHeaders } from "@agent-market/shared-contracts";

export type SigningKey = {
  keyId: string;
  secret: string;
  allowedCallerScopes?: readonly CallerScope[];
};

export type CallerScope = "public" | "owner";

export type SigningOptions = {
  key: SigningKey;
  callerScope?: CallerScope;
  now?: () => Date;
  nonce?: () => string;
};

export type VerifyOptions = {
  keys: ReadonlyMap<string, string | SigningKey> | Record<string, string | SigningKey>;
  now?: () => Date;
  windowMs?: number;
  nonceStore?: NonceReplayStore;
};

export type VerifyResult = { ok: true; headers: SignedRequestHeaders } | { ok: false; reason: string };

export function runtimeSigningKeysFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): SigningKey[] {
  if (env.AGENT_RUNTIME_KEY_ID?.trim() || env.AGENT_RUNTIME_SHARED_SECRET?.trim()) {
    throw new Error(
      "RUNTIME_SIGNING_DUAL_KEYS_REQUIRED: AGENT_RUNTIME_KEY_ID and AGENT_RUNTIME_SHARED_SECRET are unsupported",
    );
  }

  const required = (name: string, preserveWhitespace = false): string => {
    const value = env[name];
    if (!value?.trim()) {
      throw new Error(`RUNTIME_SIGNING_DUAL_KEYS_REQUIRED: missing ${name}`);
    }
    return preserveWhitespace ? value : value.trim();
  };
  const publicKeyId = required("AGENT_RUNTIME_PUBLIC_KEY_ID");
  const ownerKeyId = required("AGENT_RUNTIME_OWNER_KEY_ID");
  if (publicKeyId === ownerKeyId) {
    throw new Error("RUNTIME_SIGNING_KEY_ID_COLLISION");
  }

  return [
    {
      keyId: publicKeyId,
      secret: required("AGENT_RUNTIME_PUBLIC_SECRET", true),
      allowedCallerScopes: ["public"],
    },
    {
      keyId: ownerKeyId,
      secret: required("AGENT_RUNTIME_OWNER_SECRET", true),
      allowedCallerScopes: ["owner"],
    },
  ];
}

export class NonceReplayStore {
  readonly #seen = new Map<string, number>();

  remember(keyId: string, nonce: string, timestamp: number, windowMs: number, nowMs: number): boolean {
    this.#prune(nowMs, windowMs);
    const key = `${keyId}:${nonce}`;
    if (this.#seen.has(key)) {
      return false;
    }

    this.#seen.set(key, timestamp);
    return true;
  }

  #prune(nowMs: number, windowMs: number): void {
    for (const [key, timestamp] of this.#seen) {
      if (Math.abs(nowMs - timestamp) > windowMs) {
        this.#seen.delete(key);
      }
    }
  }
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const HEADER_NAMES = {
  keyId: "x-agent-key-id",
  timestamp: "x-agent-timestamp",
  nonce: "x-agent-nonce",
  bodySha256: "x-agent-body-sha256",
  signature: "x-agent-signature",
} as const;

export function bodySha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function signRequest(
  method: string,
  path: string,
  body: string,
  options: SigningOptions,
): SignedRequestHeaders & { callerScope: "public" | "owner" } {
  const timestamp = options.now?.().getTime() ?? Date.now();
  const nonce = options.nonce?.() ?? randomUUID();
  const bodyHash = bodySha256(body);
  const callerScope = options.callerScope ?? "public";
  if (!allowedCallerScopes(options.key).includes(callerScope)) {
    throw new Error("SIGNING_KEY_SCOPE_FORBIDDEN");
  }
  const signature = signCanonical(options.key.secret, method, path, timestamp, nonce, bodyHash, callerScope);

  return { ...SignedRequestHeadersSchema.parse({
    keyId: options.key.keyId,
    timestamp,
    nonce,
    bodySha256: bodyHash,
    signature,
  }), callerScope };
}

export function signedHeaders(headers: SignedRequestHeaders & { callerScope?: "public" | "owner" }): HeadersInit {
  return {
    [HEADER_NAMES.keyId]: headers.keyId,
    [HEADER_NAMES.timestamp]: String(headers.timestamp),
    [HEADER_NAMES.nonce]: headers.nonce,
    [HEADER_NAMES.bodySha256]: headers.bodySha256,
    [HEADER_NAMES.signature]: headers.signature,
    ...(headers.callerScope ? { "x-agent-caller-scope": headers.callerScope } : {}),
  };
}

export function readSignedHeaders(headers: Headers): SignedRequestHeaders {
  return SignedRequestHeadersSchema.parse({
    keyId: headers.get(HEADER_NAMES.keyId),
    timestamp: Number(headers.get(HEADER_NAMES.timestamp)),
    nonce: headers.get(HEADER_NAMES.nonce),
    bodySha256: headers.get(HEADER_NAMES.bodySha256),
    signature: headers.get(HEADER_NAMES.signature),
  });
}

export function verifySignedRequest(
  method: string,
  path: string,
  body: string,
  headers: Headers,
  options: VerifyOptions,
): VerifyResult {
  let parsed: SignedRequestHeaders;
  try {
    parsed = readSignedHeaders(headers);
  } catch {
    return { ok: false, reason: "invalid signature headers" };
  }

  if (parsed.bodySha256 !== bodySha256(body)) {
    return { ok: false, reason: "body hash mismatch" };
  }

  const nowMs = options.now?.().getTime() ?? Date.now();
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  if (Math.abs(nowMs - parsed.timestamp) > windowMs) {
    return { ok: false, reason: "signature timestamp outside window" };
  }

  const key = readSigningKey(options.keys, parsed.keyId);
  if (key === undefined) {
    return { ok: false, reason: "unknown signing key" };
  }

  const callerScope = headers.get("x-agent-caller-scope") ?? "public";
  if (callerScope !== "public" && callerScope !== "owner") return { ok: false, reason: "invalid caller scope" };
  if (!allowedCallerScopes(key).includes(callerScope)) {
    return { ok: false, reason: "signing key scope forbidden" };
  }
  const expected = signCanonical(key.secret, method, path, parsed.timestamp, parsed.nonce, parsed.bodySha256, callerScope);
  const actualBuffer = Buffer.from(parsed.signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return { ok: false, reason: "signature mismatch" };
  }

  if (options.nonceStore?.remember(parsed.keyId, parsed.nonce, parsed.timestamp, windowMs, nowMs) === false) {
    return { ok: false, reason: "nonce replay" };
  }

  return { ok: true, headers: parsed };
}

function signCanonical(
  secret: string,
  method: string,
  path: string,
  timestamp: number,
  nonce: string,
  bodyHash: string,
  callerScope: "public" | "owner" = "public",
): string {
  // Public signatures retain the deployed Edge canonical form. Privileged
  // requests use a separate domain so editing/removing the scope invalidates it.
  const fields = [method.toUpperCase(), path, String(timestamp), nonce, bodyHash];
  if (callerScope === "owner") fields.push("agent-market-caller-scope.v1:owner");
  return createHmac("sha256", secret)
    .update(fields.join("\n"))
    .digest("hex");
}

function allowedCallerScopes(key: SigningKey): readonly CallerScope[] {
  return key.allowedCallerScopes ?? ["public"];
}

function readSigningKey(
  keys: ReadonlyMap<string, string | SigningKey> | Record<string, string | SigningKey>,
  keyId: string,
): SigningKey | undefined {
  const value = keys instanceof Map
    ? keys.get(keyId)
    : (keys as Record<string, string | SigningKey>)[keyId];
  if (typeof value === "string") {
    return { keyId, secret: value, allowedCallerScopes: ["public"] };
  }
  return value?.keyId === keyId ? value : undefined;
}
