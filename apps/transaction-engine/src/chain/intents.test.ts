import { TransactionIntentV1Schema } from "@agent-market/shared-contracts";
import { describe, expect, it } from "vitest";

import {
  buildTransactionIntent,
  getTransactionMethodDefinition,
  type BuildIntentInput,
} from "./intents";

const base = {
  intentId: "10000000-0000-4000-8000-000000000001",
  requestId: "20000000-0000-4000-8000-000000000002",
  requestRef: `0x${"AB".repeat(32)}`,
  from: "0x11111111111111111111111111111111111111AA",
  to: "0x22222222222222222222222222222222222222BB",
  createdAt: "2026-08-21T12:00:00.000Z",
  expiresAt: "2026-08-21T12:10:00.000Z",
} as const;

describe("unsigned transaction intents", () => {
  it("strictly ABI-encodes createTask and normalizes public identifiers", () => {
    const intent = buildTransactionIntent({
      ...base,
      method: "createTask",
      args: {
        taskId: `0x${"11".repeat(32)}`,
        budgetAtomic: "6000000",
        deadline: 1_800_000_000,
      },
    });
    const decoded = getTransactionMethodDefinition("createTask").contractInterface
      .decodeFunctionData("createTask", intent.data);

    expect(TransactionIntentV1Schema.parse(intent)).toEqual(intent);
    expect(intent).toMatchObject({
      chainId: 11_155_111,
      from: base.from.toLowerCase(),
      to: base.to.toLowerCase(),
      requestRef: base.requestRef.toLowerCase(),
      valueAtomic: "0",
      createdAt: base.createdAt,
      expiresAt: base.expiresAt,
    });
    expect(decoded.map(String)).toEqual([
      `0x${"11".repeat(32)}`,
      base.requestRef.toLowerCase(),
      "6000000",
      "1800000000",
    ]);
    expect(intent).not.toHaveProperty("privateKey");
    expect(intent).not.toHaveProperty("signature");
  });

  it("encodes every shared TransactionMethod with its known ABI", () => {
    const taskId = `0x${"33".repeat(32)}`;
    const cases: BuildIntentInput[] = [
      { ...base, method: "faucet", args: {} },
      { ...base, method: "approve", args: { spender: base.to, amountAtomic: "9" } },
      { ...base, method: "createTask", args: { taskId, budgetAtomic: "9", deadline: 1_800_000_000 } },
      { ...base, method: "assignAgent", args: { taskId, agent: base.from } },
      { ...base, method: "acceptTask", args: { taskId } },
      { ...base, method: "submitWork", args: { taskId } },
      { ...base, method: "acceptWork", args: { taskId } },
      { ...base, method: "timeoutTask", args: { taskId } },
      { ...base, method: "openDispute", args: { taskId } },
      { ...base, method: "castVote", args: { taskId, agentWins: true } },
      { ...base, method: "stake", args: { amountAtomic: "9" } },
      { ...base, method: "unstake", args: { amountAtomic: "9" } },
      { ...base, method: "claimYield", args: {} },
    ];

    expect(cases.map((entry) => buildTransactionIntent(entry).method)).toEqual(
      cases.map((entry) => entry.method),
    );
  });

  it("rejects an expired intent instead of producing ambiguous signing data", () => {
    expect(() =>
      buildTransactionIntent({
        ...base,
        method: "faucet",
        args: {},
        expiresAt: base.createdAt,
      }),
    ).toThrow("Intent expiry must be after creation");
  });
});
