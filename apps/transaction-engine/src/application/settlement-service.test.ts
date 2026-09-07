import { describe, expect, it } from "vitest";

import type { OrderSnapshot, TransactionIntentV1, TransactionVerificationV1 } from "@agent-market/shared-contracts";
import type { ChainTransactionExpectation } from "../chain/resources";
import { MemoryOrderStore, OrderService } from "./order-service";
import { projectSettlementVerification, SettlementService } from "./settlement-service";

const publisher = "0x1111111111111111111111111111111111111111";
const orderId = "11111111-1111-4111-8111-111111111111";
const intent: TransactionIntentV1 = {
  intentId: "22222222-2222-4222-8222-222222222222",
  requestId: "33333333-3333-4333-8333-333333333333",
  requestRef: `0x${"a".repeat(64)}`,
  chainId: 11155111,
  from: publisher,
  to: "0x2222222222222222222222222222222222222222",
  method: "createWorkflowTask",
  data: "0x",
  valueAtomic: "106",
  createdAt: "2026-08-31T12:00:00.000Z",
  expiresAt: "2026-08-31T12:10:00.000Z",
};
const expectation: ChainTransactionExpectation = {
  resourceId: orderId,
  resourceKind: "task",
  budgetAtomic: "100",
  bondAtomic: "0",
  agentWins: null,
};
const order: OrderSnapshot = {
  id: orderId,
  publisherWallet: publisher,
  agentId: null,
  agentWallet: null,
  title: "Project chain confirmation",
  budgetAtomic: "100",
  status: "funding_pending",
  version: 2,
  artifacts: [],
  reviewEligible: false,
  manualReview: null,
  updatedAt: "2026-08-31T12:00:00.000Z",
};

const confirmed: TransactionVerificationV1 = {
  intentId: intent.intentId,
  requestId: intent.requestId,
  txHash: `0x${"b".repeat(64)}`,
  checkedAt: "2026-08-31T12:03:00.000Z",
  status: "confirmed",
  confirmations: 2,
  blockNumber: 100,
  eventName: "WorkflowTaskCreated",
};

describe("SettlementService", () => {
  it("projects a confirmed workflow creation into the order ledger exactly once", async () => {
    const store = new MemoryOrderStore([order]);
    const service = new SettlementService(new OrderService(store));
    await service.project(intent, confirmed, expectation);
    await service.project(intent, confirmed, expectation);
    expect(await store.find(orderId)).toMatchObject({ status: "funded", version: 3 });
  });

  it("keeps ordinary confirmation wait pending but routes expiry and reorg to manual review", () => {
    expect(projectSettlementVerification(intent, {
      ...confirmed,
      status: "verifying",
      confirmations: 1,
      blockNumber: 100,
      checkedAt: "2026-08-31T12:05:00.000Z",
    }, expectation)).toEqual({ status: "pending", reasonCode: "confirmations_pending" });

    expect(projectSettlementVerification(intent, {
      ...confirmed,
      status: "verifying",
      confirmations: 1,
      blockNumber: 100,
      checkedAt: "2026-08-31T12:11:00.000Z",
    }, expectation)).toMatchObject({
      status: "project",
      command: { type: "mark_manual_review", reasonCode: "chain_verification_timeout" },
    });

    expect(projectSettlementVerification(intent, {
      ...confirmed,
      status: "reorged",
      confirmations: 0,
      blockNumber: 100,
      errorCode: "CHAIN_REORG",
    }, expectation)).toMatchObject({
      status: "project",
      command: { type: "mark_manual_review", reasonCode: "chain_reorg" },
    });
  });
});
