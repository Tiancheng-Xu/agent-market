import { createHash, randomBytes } from "node:crypto";

import {
  SEPOLIA_CHAIN_ID,
  WalletAddressSchema,
  WalletChallengeV1Schema,
  type WalletChallengeV1,
} from "@agent-market/shared-contracts";
import { v7 as uuidv7 } from "uuid";

import type { AuthStore, StoredChallenge } from "./auth-store";

export const AUTH_STATEMENT = "Sign in to Agent Market. This request does not submit a transaction or reimburse gas.";

export interface ChallengeRequestContext {
  requestId: string;
  domain: string;
  uri: string;
}

export interface ChallengeDependencies {
  now(): Date;
  id(): string;
  nonce(): string;
}

const defaultDependencies: ChallengeDependencies = {
  now: () => new Date(),
  id: () => uuidv7(),
  nonce: () => randomBytes(24).toString("base64url"),
};

export function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function formatChallengeMessage(challenge: WalletChallengeV1): string {
  return [
    "Agent Market wallet authentication",
    `Domain: ${challenge.domain}`,
    `Wallet: ${challenge.walletAddress}`,
    `Chain ID: ${challenge.chainId}`,
    `URI: ${challenge.uri}`,
    `Statement: ${challenge.statement}`,
    `Nonce: ${challenge.nonce}`,
    `Issued At: ${challenge.issuedAt}`,
    `Expiration Time: ${challenge.expiresAt}`,
    `Request ID: ${challenge.requestId}`,
    `Challenge ID: ${challenge.challengeId}`,
  ].join("\n");
}

function field(line: string | undefined, prefix: string): string {
  if (!line?.startsWith(prefix)) throw new Error("AUTH_CHALLENGE_MESSAGE_INVALID");
  return line.slice(prefix.length);
}

export function parseChallengeMessage(message: string): WalletChallengeV1 {
  const lines = message.split("\n");
  if (lines.length !== 11 || lines[0] !== "Agent Market wallet authentication") {
    throw new Error("AUTH_CHALLENGE_MESSAGE_INVALID");
  }
  try {
    return WalletChallengeV1Schema.parse({
      domain: field(lines[1], "Domain: "),
      walletAddress: field(lines[2], "Wallet: "),
      chainId: Number(field(lines[3], "Chain ID: ")),
      uri: field(lines[4], "URI: "),
      statement: field(lines[5], "Statement: "),
      nonce: field(lines[6], "Nonce: "),
      issuedAt: field(lines[7], "Issued At: "),
      expiresAt: field(lines[8], "Expiration Time: "),
      requestId: field(lines[9], "Request ID: "),
      challengeId: field(lines[10], "Challenge ID: "),
    });
  } catch {
    throw new Error("AUTH_CHALLENGE_MESSAGE_INVALID");
  }
}

export async function issueChallenge(
  store: AuthStore,
  address: string,
  context: ChallengeRequestContext,
  dependencies: ChallengeDependencies = defaultDependencies,
): Promise<WalletChallengeV1> {
  const issuedAt = dependencies.now();
  const challenge = WalletChallengeV1Schema.parse({
    challengeId: dependencies.id(),
    requestId: context.requestId,
    walletAddress: WalletAddressSchema.parse(address),
    chainId: SEPOLIA_CHAIN_ID,
    nonce: dependencies.nonce(),
    domain: context.domain,
    uri: context.uri,
    statement: AUTH_STATEMENT,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
  });
  const { nonce, ...publicFields } = challenge;
  const stored: StoredChallenge = { ...publicFields, nonceHash: hashSecret(nonce) };
  await store.createChallenge(stored);
  return challenge;
}
