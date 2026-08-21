import { describe, expect, it } from "vitest";

import { MemoryTransactionStore } from "./transaction-store";

const intent = {
  intentId: "0191f6f8-cb6b-7f31-81ad-c497d7d90201",
  requestId: "0191f6f8-cb6b-7f31-81ad-c497d7d90202",
  requestRef: `0x${"12".repeat(32)}`,
  chainId: 11_155_111 as const,
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  method: "createTask" as const,
  data: "0x1234",
  valueAtomic: "0",
  createdAt: "2026-08-21T12:00:00.000Z",
  expiresAt: "2026-08-21T12:05:00.000Z",
};
const expectation = {
  resourceId: "0191f6f8-cb6b-7f31-81ad-c497d7d90209",
  budgetAtomic: "100",
  bondAtomic: "6",
  agentWins: null,
};

describe("transaction store", () => {
  it("creates intents idempotently and rejects a conflicting transaction hash", async () => {
    const store = new MemoryTransactionStore();
    expect(await store.createIntent(intent, expectation)).toEqual(intent);
    expect(await store.createIntent({
      ...intent,
      createdAt: "2026-08-21T12:00:01.000Z",
      expiresAt: "2026-08-21T12:05:01.000Z",
    }, expectation)).toEqual(intent);
    await store.recordSubmission(intent.intentId, `0x${"34".repeat(32)}`, intent.createdAt);
    await expect(store.recordSubmission(intent.intentId, `0x${"56".repeat(32)}`, intent.createdAt))
      .rejects.toThrow("CHAIN_TRANSACTION_CONFLICT");
  });

  it("does not downgrade a confirmed verification on duplicate reconciliation", async () => {
    const store = new MemoryTransactionStore();
    await store.createIntent(intent, expectation);
    const confirmed = {
      intentId: intent.intentId,
      requestId: intent.requestId,
      txHash: `0x${"34".repeat(32)}`,
      status: "confirmed" as const,
      confirmations: 2,
      blockNumber: 9_000_000,
      eventName: "TaskCreated",
      checkedAt: "2026-08-21T12:06:00.000Z",
    };
    expect(await store.saveVerification(confirmed, { blockHash: `0x${"78".repeat(32)}`, requestRef: intent.requestRef })).toEqual(confirmed);
    const later = await store.saveVerification({
      intentId: confirmed.intentId,
      requestId: confirmed.requestId,
      txHash: confirmed.txHash,
      status: "reorged",
      confirmations: 0,
      blockNumber: null,
      errorCode: "CHAIN_REORG",
      checkedAt: "2026-08-21T12:07:00.000Z",
    });
    expect(later.status).toBe("reorged");
  });

  it("rejects confirmed hash conflicts and observed requestRef conflicts", async () => {
    const store = new MemoryTransactionStore();
    await store.createIntent(intent, expectation);
    const confirmed = {
      intentId: intent.intentId,
      requestId: intent.requestId,
      txHash: `0x${"34".repeat(32)}`,
      status: "confirmed" as const,
      confirmations: 2,
      blockNumber: 9_000_000,
      eventName: "TaskCreated",
      checkedAt: "2026-08-21T12:06:00.000Z",
    };
    await expect(store.saveVerification(confirmed, {
      blockHash: `0x${"78".repeat(32)}`,
      requestRef: `0x${"99".repeat(32)}`,
    })).rejects.toThrow("CHAIN_REQUEST_REF_CONFLICT");
    await store.saveVerification(confirmed, {
      blockHash: `0x${"78".repeat(32)}`,
      requestRef: intent.requestRef,
    });
    await expect(store.saveVerification({
      ...confirmed,
      txHash: `0x${"56".repeat(32)}`,
      checkedAt: "2026-08-21T12:07:00.000Z",
    }, {
      blockHash: `0x${"78".repeat(32)}`,
      requestRef: intent.requestRef,
    })).rejects.toThrow("CHAIN_TRANSACTION_CONFLICT");
  });
});
