import type { TransactionVerificationV1 } from "@agent-market/shared-contracts";
import { describe, expect, it } from "vitest";

import { buildTransactionIntent, getTransactionMethodDefinition } from "./intents";
import {
  reconcileTransaction,
  type ChainObservation,
  type ChainReader,
} from "./reconcile";

const txHash = `0x${"CD".repeat(32)}`;
const blockHash = `0x${"EF".repeat(32)}`;
const taskId = `0x${"12".repeat(32)}`;
const requestRef = `0x${"34".repeat(32)}`;
const from = "0x1111111111111111111111111111111111111111";
const to = "0x2222222222222222222222222222222222222222";
const checkedAt = "2026-08-21T14:00:00.000Z";

const intent = buildTransactionIntent({
  intentId: "10000000-0000-4000-8000-000000000001",
  requestId: "20000000-0000-4000-8000-000000000002",
  requestRef,
  from,
  to,
  method: "createTask",
  args: { taskId, budgetAtomic: "6000000", deadline: 1_800_000_000 },
  createdAt: "2026-08-21T12:00:00.000Z",
  expiresAt: "2026-08-21T12:10:00.000Z",
});

function observation(overrides: {
  transaction?: Partial<NonNullable<ChainObservation["transaction"]>>;
  receipt?: Partial<NonNullable<ChainObservation["receipt"]>>;
  latestBlockNumber?: number | null;
  canonicalBlockHash?: string | null;
  eventRequestRef?: string;
    eventBudget?: string;
    eventDeadline?: number;
} = {}): ChainObservation {
  const definition = getTransactionMethodDefinition("createTask");
  const encoded = definition.contractInterface.encodeEventLog(
    definition.contractInterface.getEvent("TaskCreated")!,
    [
      taskId,
      overrides.eventRequestRef ?? requestRef,
      from,
      overrides.eventBudget ?? "6000000",
      overrides.eventDeadline ?? 1_800_000_000,
    ],
  );
  return {
    transaction: {
      hash: txHash,
      chainId: 11_155_111,
      from,
      to,
      data: intent.data,
      valueAtomic: "0",
      blockNumber: 100,
      blockHash,
      ...overrides.transaction,
    },
    receipt: {
      status: "success",
      blockNumber: 100,
      blockHash,
      logs: [{ address: to, topics: encoded.topics, data: encoded.data }],
      ...overrides.receipt,
    },
    latestBlockNumber: overrides.latestBlockNumber === undefined ? 101 : overrides.latestBlockNumber,
    canonicalBlockHash:
      overrides.canonicalBlockHash === undefined ? blockHash : overrides.canonicalBlockHash,
  };
}

const reader = (value: ChainObservation | null): ChainReader => ({
  async readTransaction() {
    return value;
  },
});

async function reconcile(
  rpcObservation: ChainObservation | null,
  blockscoutObservation: ChainObservation | null = rpcObservation,
  extra: Partial<Parameters<typeof reconcileTransaction>[0]> = {},
) {
  return reconcileTransaction({
    intent,
    txHash,
    rpc: reader(rpcObservation),
    blockscout: reader(blockscoutObservation),
    checkedAt,
    minimumConfirmations: 2,
    ...extra,
  });
}

describe("dual-source transaction reconciliation", () => {
  it("confirms only with canonical receipt, exact event, block number, and correct confirmations", async () => {
    await expect(reconcile(observation())).resolves.toEqual({
      intentId: intent.intentId,
      requestId: intent.requestId,
      txHash: txHash.toLowerCase(),
      checkedAt,
      status: "confirmed",
      confirmations: 2,
      blockNumber: 100,
      eventName: "TaskCreated",
    });
  });

  it.each([
    ["wrong chain", { transaction: { chainId: 1 } }, "WRONG_CHAIN"],
    ["wrong target", { transaction: { to: from } }, "WRONG_TO"],
    ["wrong sender", { transaction: { from: to } }, "WRONG_SENDER"],
    ["wrong amount", { transaction: { valueAtomic: "1" } }, "WRONG_AMOUNT"],
    ["wrong selector", { transaction: { data: `0xdeadbeef${intent.data.slice(10)}` } }, "WRONG_SELECTOR"],
  ])("fails a transaction with %s", async (_name, overrides, errorCode) => {
    const changed = observation(overrides as Parameters<typeof observation>[0]);
    await expect(reconcile(changed, changed)).resolves.toMatchObject({ status: "failed", errorCode });
  });

  it("detects a wrong calldata requestRef", async () => {
    const wrongData = getTransactionMethodDefinition("createTask").contractInterface.encodeFunctionData(
      "createTask",
      [taskId, `0x${"56".repeat(32)}`, "6000000", 1_800_000_000],
    );
    const changed = observation({ transaction: { data: wrongData } });
    await expect(reconcile(changed, changed)).resolves.toMatchObject({
      status: "failed",
      errorCode: "WRONG_REQUEST_REF",
    });
  });

  it("detects wrong event requestRef and amount", async () => {
    const wrongRef = observation({ eventRequestRef: `0x${"56".repeat(32)}` });
    const wrongAmount = observation({ eventBudget: "7" });
    await expect(reconcile(wrongRef, wrongRef)).resolves.toMatchObject({
      status: "failed",
      errorCode: "WRONG_REQUEST_REF",
    });
    await expect(reconcile(wrongAmount, wrongAmount)).resolves.toMatchObject({
      status: "failed",
      errorCode: "WRONG_AMOUNT",
    });
  });

  it("rejects a TaskCreated event with a different deadline", async () => {
    const changed = observation({ eventDeadline: 1_800_000_001 });
    await expect(reconcile(changed, changed)).resolves.toMatchObject({
      status: "failed",
      errorCode: "EVENT_MISMATCH",
    });
  });

  it("marks a failed receipt as failed", async () => {
    const changed = observation({ receipt: { status: "failed" } });
    await expect(reconcile(changed, changed)).resolves.toMatchObject({
      status: "failed",
      errorCode: "FAILED_RECEIPT",
    });
  });

  it("keeps insufficient confirmations in verifying", async () => {
    await expect(reconcile(observation({ latestBlockNumber: 100 }))).resolves.toMatchObject({
      status: "verifying",
      confirmations: 1,
      blockNumber: 100,
    });
  });

  it("keeps timeout, missing source data, and source disagreement in verifying", async () => {
    const timeout: ChainReader = {
      async readTransaction() {
        throw new Error("RPC timeout");
      },
    };
    await expect(
      reconcileTransaction({ intent, txHash, rpc: timeout, blockscout: reader(observation()), checkedAt }),
    ).resolves.toMatchObject({ status: "verifying", blockNumber: null });
    await expect(reconcile(observation(), null)).resolves.toMatchObject({ status: "verifying" });
    await expect(reconcile(observation(), observation({ transaction: { chainId: 1 } }))).resolves.toMatchObject({
      status: "verifying",
    });
  });

  it("detects a non-canonical block and a changed previously confirmed block", async () => {
    await expect(
      reconcile(observation({ canonicalBlockHash: `0x${"99".repeat(32)}` })),
    ).resolves.toMatchObject({ status: "reorged", confirmations: 0, errorCode: "CHAIN_REORG" });

    const previous: TransactionVerificationV1 = {
      intentId: intent.intentId,
      requestId: intent.requestId,
      txHash: txHash.toLowerCase(),
      checkedAt,
      status: "confirmed",
      confirmations: 2,
      blockNumber: 100,
      eventName: "TaskCreated",
    };
    await expect(
      reconcile(observation(), observation(), {
        previous,
        previousCanonicalBlockHash: `0x${"88".repeat(32)}`,
      }),
    ).resolves.toMatchObject({ status: "reorged", errorCode: "CHAIN_REORG" });
  });

  it("reconciles a duplicate confirmation idempotently", async () => {
    const first = await reconcile(observation());
    const second = await reconcile(observation(), observation(), {
      previous: first,
      previousCanonicalBlockHash: blockHash,
    });
    expect(second).toEqual(first);
  });

  it.each([
    ["acceptTask", "TaskAccepted", false],
    ["acceptWork", "TaskSettled", true],
    ["timeoutTask", "TaskSettled", false],
  ] as const)("enforces exact method semantics for %s", async (method, eventName, agentWins) => {
    const methodIntent = buildTransactionIntent({
      intentId: "10000000-0000-4000-8000-000000000011",
      requestId: "20000000-0000-4000-8000-000000000012",
      requestRef,
      from,
      to,
      method,
      args: { taskId },
      createdAt: "2026-08-21T12:00:00.000Z",
      expiresAt: "2026-08-21T12:10:00.000Z",
    });
    const definition = getTransactionMethodDefinition(method);
    const goodArgs = method === "acceptTask"
      ? [taskId, requestRef, "6000", 1_800_000_000]
      : [taskId, requestRef, agentWins, "100000", "6000", "0", "0"];
    const badArgs = method === "acceptTask"
      ? [taskId, requestRef, "6001", 1_800_000_000]
      : [taskId, requestRef, !agentWins, "100001", "6001", "0", "0"];
    const makeObservation = (eventArgs: readonly unknown[]): ChainObservation => {
      const encoded = definition.contractInterface.encodeEventLog(
        definition.contractInterface.getEvent(eventName)!, [...eventArgs],
      );
      return {
        transaction: {
          hash: txHash, chainId: 11_155_111, from, to, data: methodIntent.data,
          valueAtomic: "0", blockNumber: 100, blockHash,
        },
        receipt: {
          status: "success", blockNumber: 100, blockHash,
          logs: [{ address: to, topics: encoded.topics, data: encoded.data }],
        },
        latestBlockNumber: 101,
        canonicalBlockHash: blockHash,
      };
    };
    const expectation = {
      resourceId: "0191f6f8-cb6b-7f31-81ad-c497d7d90209",
      budgetAtomic: "100000",
      bondAtomic: "6000",
      agentWins: method === "acceptTask" ? null : agentWins,
    };
    const good = makeObservation(goodArgs);
    await expect(reconcileTransaction({
      intent: methodIntent, expectation, txHash, rpc: reader(good), blockscout: reader(good),
      checkedAt, minimumConfirmations: 2,
    })).resolves.toMatchObject({ status: "confirmed", eventName });
    const bad = makeObservation(badArgs);
    await expect(reconcileTransaction({
      intent: methodIntent, expectation, txHash, rpc: reader(bad), blockscout: reader(bad),
      checkedAt, minimumConfirmations: 2,
    })).resolves.toMatchObject({ status: "failed" });
  });
});
