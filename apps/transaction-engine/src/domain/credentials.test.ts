import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decryptCredential,
  encryptCredential,
  serializeEncryptedCredential,
} from "./credentials";

describe("agent credential envelope", () => {
  it("round-trips a secret with AES-256-GCM without serializing plaintext", () => {
    const key = randomBytes(32);
    const plaintext = "agent-secret-value";
    const encrypted = encryptCredential(plaintext, key, "agent-research-01");
    const serialized = serializeEncryptedCredential(encrypted);

    expect(serialized).not.toContain(plaintext);
    expect(encrypted.algorithm).toBe("aes-256-gcm");
    expect(decryptCredential(encrypted, key, "agent-research-01")).toBe(plaintext);
  });

  it("rejects decryption when the credential is bound to another agent", () => {
    const key = randomBytes(32);
    const encrypted = encryptCredential("secret", key, "agent-research-01");

    expect(() => decryptCredential(encrypted, key, "agent-other"))
      .toThrowError("CREDENTIAL_AUTHENTICATION_FAILED");
  });
});
