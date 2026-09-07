import { describe, expect, it, vi } from "vitest";

import type { OrderCommand, OrderSnapshot } from "@agent-market/shared-contracts";
import { MemoryOrderStore, OrderService } from "./order-service";

const publisher = "0x1111111111111111111111111111111111111111";
const order: OrderSnapshot = {
  id: "11111111-1111-4111-8111-111111111111",
  publisherWallet: publisher,
  agentId: null,
  agentWallet: null,
  title: "Verify the handoff",
  budgetAtomic: "100",
  status: "open",
  version: 1,
  artifacts: [],
  reviewEligible: false,
  manualReview: null,
  updatedAt: "2026-08-31T12:00:00.000Z",
};

const command: OrderCommand = {
  type: "mark_funding_pending",
  requestId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "fund-order-11111111",
  actorWallet: publisher,
  occurredAt: "2026-08-31T12:01:00.000Z",
  quoteId: "44444444-4444-4444-8444-444444444444",
  taskFingerprint: `sha256:${"a".repeat(64)}`,
};

const readyQuoteGate = {
  async evaluateFunding() {
    return { status: "ready" as const, code: "RISK_QUOTE_READY", quoteId: command.quoteId };
  },
  async evaluatePreliminary() {
    return { status: "ready" as const, code: "RISK_QUOTE_READY", quoteId: command.quoteId };
  },
};

describe("OrderService", () => {
  it("returns the persisted result for a repeated idempotent command", async () => {
    const service = new OrderService(new MemoryOrderStore([order]), readyQuoteGate);
    const first = await service.execute(order.id, command);
    const repeated = await service.execute(order.id, {
      ...command,
      requestId: "33333333-3333-4333-8333-333333333333",
      occurredAt: "2026-08-31T12:02:00.000Z",
    });
    expect(repeated).toEqual(first);
    expect(repeated.snapshot).toMatchObject({ status: "funding_pending", version: 2 });
  });

  it("rejects reuse of an idempotency key with a different command payload", async () => {
    const service = new OrderService(new MemoryOrderStore([order]), readyQuoteGate);
    await service.execute(order.id, command);
    await expect(service.execute(order.id, {
      ...command,
      type: "open_dispute",
      reasonCode: "different_payload",
    })).rejects.toThrow("ORDER_IDEMPOTENCY_CONFLICT");
  });

  it("keeps funding preparation behind the quote gate with the supplied context", async () => {
    const evaluateFunding = vi.fn(async () => ({
      status: "ready" as const,
      code: "RISK_QUOTE_READY",
      quoteId: "44444444-4444-4444-8444-444444444444",
    }));
    const service = new OrderService(new MemoryOrderStore([order]), {
      evaluateFunding,
      async evaluatePreliminary() {
        throw new Error("PRELIMINARY_GATE_NOT_EXPECTED");
      },
    });

    await service.execute(order.id, {
      ...command,
      quoteId: "44444444-4444-4444-8444-444444444444",
      taskFingerprint: `sha256:${"a".repeat(64)}`,
    });

    expect(evaluateFunding).toHaveBeenCalledWith({
      taskId: order.id,
      quoteId: "44444444-4444-4444-8444-444444444444",
      taskFingerprint: `sha256:${"a".repeat(64)}`,
      evaluatedAt: command.occurredAt,
    });
  });

  it("fails closed when a risk-gated command has no quote gate", async () => {
    const service = new OrderService(new MemoryOrderStore([order]));
    await expect(service.execute(order.id, command)).rejects.toThrow("RISK_QUOTE_GATE_UNAVAILABLE");
  });
});
