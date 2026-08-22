import { createHmac, createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { SignedRequestHeadersSchema, type SignedRequestHeaders } from "@agent-market/shared-contracts";

export type SigningKey = {
  keyId: string;
  secret: string;
};

export type SigningOptions = {
  key: SigningKey;
  now?: () => Date;
  nonce?: () => string;
};

export type VerifyOptions = {
  keys: ReadonlyMap<string, string> | Record<string, string>;
  now?: () => Date;
  windowMs?: number;
  nonceStore?: NonceReplayStore;
};

export type VerifyResult = { ok: true; headers: SignedRequestHeaders } | { ok: false; reason: string };

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
): SignedRequestHeaders {
  const timestamp = options.now?.().getTime() ?? Date.now();
  const nonce = options.nonce?.() ?? randomUUID();
  const bodyHash = bodySha256(body);
  const signature = signCanonical(options.key.secret, method, path, timestamp, nonce, bodyHash);

  return SignedRequestHeadersSchema.parse({
    keyId: options.key.keyId,
    timestamp,
    nonce,
    bodySha256: bodyHash,
    signature,
  });
}

export function signedHeaders(headers: SignedRequestHeaders): HeadersInit {
  return {
    [HEADER_NAMES.keyId]: headers.keyId,
    [HEADER_NAMES.timestamp]: String(headers.timestamp),
    [HEADER_NAMES.nonce]: headers.nonce,
    [HEADER_NAMES.bodySha256]: headers.bodySha256,
    [HEADER_NAMES.signature]: headers.signature,
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

  const secret = readSecret(options.keys, parsed.keyId);
  if (secret === undefined) {
    return { ok: false, reason: "unknown signing key" };
  }

  const expected = signCanonical(secret, method, path, parsed.timestamp, parsed.nonce, parsed.bodySha256);
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
): string {
  return createHmac("sha256", secret)
    .update([method.toUpperCase(), path, String(timestamp), nonce, bodyHash].join("\n"))
    .digest("hex");
}

function readSecret(keys: ReadonlyMap<string, string> | Record<string, string>, keyId: string): string | undefined {
  if (keys instanceof Map) {
    return keys.get(keyId);
  }

  return (keys as Record<string, string>)[keyId];
}
