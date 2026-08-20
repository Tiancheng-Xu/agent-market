import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type BinaryLike,
} from "node:crypto";

export interface EncryptedCredential {
  algorithm: "aes-256-gcm";
  iv: string;
  authenticationTag: string;
  ciphertext: string;
}

function assertKey(key: BinaryLike): void {
  if (Buffer.byteLength(key) !== 32) {
    throw new Error("CREDENTIAL_KEY_INVALID");
  }
}

export function encryptCredential(
  plaintext: string,
  key: BinaryLike,
  agentId: string,
): EncryptedCredential {
  assertKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(agentId, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    authenticationTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export function decryptCredential(
  encrypted: EncryptedCredential,
  key: BinaryLike,
  agentId: string,
): string {
  assertKey(key);

  try {
    const decipher = createDecipheriv(
      encrypted.algorithm,
      key,
      Buffer.from(encrypted.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(agentId, "utf8"));
    decipher.setAuthTag(Buffer.from(encrypted.authenticationTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("CREDENTIAL_AUTHENTICATION_FAILED");
  }
}

export function serializeEncryptedCredential(
  encrypted: EncryptedCredential,
): string {
  return JSON.stringify(encrypted);
}
