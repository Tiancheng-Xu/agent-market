import { describe, expect, it } from "vitest";
import {
  NonceReplayStore,
  runtimeSigningKeysFromEnv,
  signRequest,
  signedHeaders,
  verifySignedRequest,
} from "./signing";

const publicKey = { keyId: "edge-public-test", secret: "local-public-test-secret", allowedCallerScopes: ["public"] as const };
const ownerKey = { keyId: "owner-test", secret: "local-owner-test-secret", allowedCallerScopes: ["owner"] as const };
const now = () => new Date("2026-09-09T00:00:00Z");
const body = '{"request":"synthetic"}';
const options = { keys: { [publicKey.keyId]: publicKey, [ownerKey.keyId]: ownerKey }, now };
const assertion = (callerScope: "public" | "owner") => {
  const key = callerScope === "owner" ? ownerKey : publicKey;
  return new Headers(signedHeaders(signRequest("POST", "/graphql", body, { key, now, callerScope })));
};
const verify = (headers: Headers) => verifySignedRequest("POST", "/graphql", body, headers, options);

describe("signed caller scope", () => {
  it("builds distinct public-only and owner-only runtime keys", () => {
    expect(runtimeSigningKeysFromEnv({
      AGENT_RUNTIME_PUBLIC_KEY_ID: publicKey.keyId,
      AGENT_RUNTIME_PUBLIC_SECRET: publicKey.secret,
      AGENT_RUNTIME_OWNER_KEY_ID: ownerKey.keyId,
      AGENT_RUNTIME_OWNER_SECRET: ownerKey.secret,
    })).toEqual([publicKey, ownerKey]);
  });
  it("fails closed for the legacy shared key and duplicate scoped key ids", () => {
    expect(() => runtimeSigningKeysFromEnv({
      AGENT_RUNTIME_KEY_ID: "legacy-key",
      AGENT_RUNTIME_SHARED_SECRET: "legacy-secret",
    })).toThrow("RUNTIME_SIGNING_DUAL_KEYS_REQUIRED");
    expect(() => runtimeSigningKeysFromEnv({
      AGENT_RUNTIME_PUBLIC_KEY_ID: "same-key",
      AGENT_RUNTIME_PUBLIC_SECRET: publicKey.secret,
      AGENT_RUNTIME_OWNER_KEY_ID: "same-key",
      AGENT_RUNTIME_OWNER_SECRET: ownerKey.secret,
    })).toThrow("RUNTIME_SIGNING_KEY_ID_COLLISION");
  });
  it("preserves public Edge compatibility including an omitted public header", () => {
    const headers = assertion("public");
    expect(verify(headers).ok).toBe(true);
    headers.delete("x-agent-caller-scope");
    expect(verify(headers).ok).toBe(true);
  });
  it("rejects a public assertion relabelled as owner", () => {
    const headers = assertion("public");
    headers.set("x-agent-caller-scope", "owner");
    expect(verify(headers).ok).toBe(false);
  });
  it("does not allow the public Edge key to sign owner scope", () => {
    expect(() => signRequest("POST", "/graphql", body, {
      key: publicKey,
      now,
      callerScope: "owner",
    })).toThrow("SIGNING_KEY_SCOPE_FORBIDDEN");
  });
  it("accepts signed owner requests but rejects scope stripping and unknown scopes", () => {
    const headers = assertion("owner");
    expect(verify(headers).ok).toBe(true);
    headers.delete("x-agent-caller-scope");
    expect(verify(headers).ok).toBe(false);
    headers.set("x-agent-caller-scope", "admin");
    expect(verify(headers).ok).toBe(false);
  });
  it("keeps body/path binding and consumes a valid owner nonce only once", () => {
    const headers = assertion("owner");
    const scoped = { ...options, nonceStore: new NonceReplayStore() };
    expect(verifySignedRequest("POST", "/agent/chat", body, headers, scoped).ok).toBe(false);
    expect(verifySignedRequest("POST", "/graphql", body + " ", headers, scoped).ok).toBe(false);
    expect(verifySignedRequest("POST", "/graphql", body, headers, scoped).ok).toBe(true);
    expect(verifySignedRequest("POST", "/graphql", body, headers, scoped).ok).toBe(false);
  });
});
