import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AppErrorSchema,
  DlqReplayRequestedV1Schema,
  MatchRequestedV1Schema,
  SEPOLIA_CHAIN_ID,
  TransactionIntentV1Schema,
  TransactionVerificationV1Schema,
  WalletChallengeV1Schema,
  WalletSessionV1Schema,
} from "./index";

const fixturePath = fileURLToPath(
  new URL("../fixtures/match-requested.v1.json", import.meta.url),
);

describe("shared contracts", () => {
  it("accepts the canonical match event fixture", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    expect(MatchRequestedV1Schema.parse(fixture).type).toBe(
      "match.requested.v1",
    );
  });

  it("rejects internal error details", () => {
    expect(() =>
      AppErrorSchema.parse({
        code: "INTERNAL",
        message: "safe",
        stack: "secret",
      }),
    ).toThrow();
  });

  it("accepts strict Sepolia wallet challenge and session contracts", () => {
    const challenge = {
      challengeId: "0191f6f8-cb6b-7f31-81ad-c497d7d90001",
      requestId: "0191f6f8-cb6b-7f31-81ad-c497d7d90002",
      walletAddress: "0x1111111111111111111111111111111111111111",
      chainId: SEPOLIA_CHAIN_ID,
      nonce: "nonce-0123456789abcdef",
      domain: "agent-market.baby2b.online",
      uri: "https://agent-market.baby2b.online",
      statement: "Sign in to Agent Market on Sepolia.",
      issuedAt: "2026-08-21T09:00:00.000Z",
      expiresAt: "2026-08-21T09:05:00.000Z",
    };
    expect(WalletChallengeV1Schema.parse(challenge).chainId).toBe(11_155_111);
    expect(WalletChallengeV1Schema.parse({
      ...challenge,
      walletAddress: "0xAa11111111111111111111111111111111111111",
    }).walletAddress).toBe("0xaa11111111111111111111111111111111111111");
    expect(() => WalletChallengeV1Schema.parse({ ...challenge, chainId: 1 })).toThrow();

    const session = {
      sessionId: "0191f6f8-cb6b-7f31-81ad-c497d7d90003",
      requestId: challenge.requestId,
      walletAddress: challenge.walletAddress,
      chainId: SEPOLIA_CHAIN_ID,
      issuedAt: challenge.issuedAt,
      expiresAt: "2026-08-21T09:30:00.000Z",
      recentAuthAt: challenge.issuedAt,
    };
    expect(WalletSessionV1Schema.parse(session).walletAddress).toBe(
      challenge.walletAddress,
    );
    expect(() => WalletSessionV1Schema.parse({ ...session, secret: "leak" })).toThrow();
  });

  it("validates transaction intent and replay identities without secrets", () => {
    const intent = {
      intentId: "0191f6f8-cb6b-7f31-81ad-c497d7d90004",
      requestId: "0191f6f8-cb6b-7f31-81ad-c497d7d90005",
      requestRef: `0x${"12".repeat(32)}`,
      chainId: SEPOLIA_CHAIN_ID,
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      method: "createTask" as const,
      data: "0x1234",
      valueAtomic: "0",
      createdAt: "2026-08-21T09:00:00.000Z",
      expiresAt: "2026-08-21T09:05:00.000Z",
    };
    expect(TransactionIntentV1Schema.parse(intent).method).toBe("createTask");
    expect(() => TransactionIntentV1Schema.parse({ ...intent, privateKey: "no" })).toThrow();
    expect(() => TransactionVerificationV1Schema.parse({
      intentId: intent.intentId,
      requestId: intent.requestId,
      txHash: `0x${"34".repeat(32)}`,
      status: "confirmed",
      confirmations: 0,
      blockNumber: null,
      eventName: "TaskCreated",
      checkedAt: intent.createdAt,
    })).toThrow();
    expect(TransactionVerificationV1Schema.parse({
      intentId: intent.intentId,
      requestId: intent.requestId,
      txHash: `0x${"AB".repeat(32)}`,
      status: "confirmed",
      confirmations: 2,
      blockNumber: 9_000_000,
      eventName: "TaskCreated",
      checkedAt: intent.createdAt,
    }).txHash).toBe(`0x${"ab".repeat(32)}`);

    expect(DlqReplayRequestedV1Schema.parse({
      replayId: "0191f6f8-cb6b-7f31-81ad-c497d7d90006",
      type: "dlq.replay.requested.v1",
      occurredAt: "2026-08-21T09:00:00.000Z",
      originalEventId: "0191f6f8-cb6b-7f31-81ad-c497d7d90007",
      requestId: intent.requestId,
      idempotencyKey: "idem-0123456789",
      reason: "operator-approved replay",
    }).originalEventId).toBe("0191f6f8-cb6b-7f31-81ad-c497d7d90007");
  });
});
