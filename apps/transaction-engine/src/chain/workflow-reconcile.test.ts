import { describe, expect, it } from "vitest";

import { buildTransactionIntent, getTransactionMethodDefinition, type BuildIntentInput } from "./intents";
import { reconcileTransaction, type ChainObservation, type ChainReader } from "./reconcile";

const taskId = `0x${"12".repeat(32)}`;
const requestRef = `0x${"34".repeat(32)}`;
const txHash = `0x${"56".repeat(32)}`;
const blockHash = `0x${"78".repeat(32)}`;
const from = "0x1111111111111111111111111111111111111111";
const to = "0x2222222222222222222222222222222222222222";
const base = {
  intentId: "10000000-0000-4000-8000-000000000001",
  requestId: "20000000-0000-4000-8000-000000000002",
  requestRef,
  from,
  to,
  createdAt: "2026-08-21T12:00:00.000Z",
  expiresAt: "2026-08-21T12:10:00.000Z",
} as const;

function reader(value: ChainObservation): ChainReader {
  return { async readTransaction() { return value; } };
}

async function verify(input: BuildIntentInput, eventArgs: readonly unknown[]) {
  const intent = buildTransactionIntent(input);
  const definition = getTransactionMethodDefinition(intent.method);
  const event = definition.contractInterface.encodeEventLog(
    definition.contractInterface.getEvent(definition.eventName)!, [...eventArgs],
  );
  const observation: ChainObservation = {
    transaction: {
      hash: txHash, chainId: 11_155_111, from, to, data: intent.data,
      valueAtomic: "0", blockNumber: 100, blockHash,
    },
    receipt: {
      status: "success", blockNumber: 100, blockHash,
      logs: [{ address: to, topics: event.topics, data: event.data }],
    },
    latestBlockNumber: 101,
    canonicalBlockHash: blockHash,
  };
  return reconcileTransaction({
    intent, txHash, rpc: reader(observation), blockscout: reader(observation),
    checkedAt: "2026-08-21T14:00:00.000Z", minimumConfirmations: 2,
    expectation: {
      resourceId: "018f0f9c-8b35-7f31-8f11-75f06c12a521",
      budgetAtomic: "100", bondAtomic: "6", agentWins: null,
    },
  });
}

describe("V3 Workflow Escrow reconciliation", () => {
  it("accepts createWorkflowTask only with exact budget, fee, deadline, and requestRef", async () => {
    await expect(verify({
      ...base, method: "createWorkflowTask",
      args: { taskId, budgetAtomic: "100", deadline: 1_800_000_000 },
    }, [taskId, requestRef, from, "100", "6", 1_800_000_000])).resolves.toMatchObject({
      status: "confirmed", eventName: "TaskCreated",
    });
  });

  it("accepts resolveWorkflowTask only with the exact arbiter, outcome, task, and budget", async () => {
    await expect(verify({
      ...base, method: "resolveWorkflowTask", args: { taskId, agentsWin: true },
    }, [taskId, true, from, "100"])).resolves.toMatchObject({
      status: "confirmed", eventName: "TaskResolved",
    });
  });
});
