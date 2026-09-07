import { describe, expect, it, vi } from "vitest";
import { OrderCommandSchema, type OrderCommand } from "@agent-market/shared-contracts";

import { createOrderCommandHandler } from "./route";

const orderId = "0191f6f8-cb6b-7f31-81ad-c497d7d90301";
const requestId = "0191f6f8-cb6b-7f31-81ad-c497d7d90302";

const quoteId = "44444444-4444-4444-8444-444444444444";
const taskFingerprint = `sha256:${"a".repeat(64)}`;

function request(body: Record<string, unknown> | string): Request {
  return new Request(`https://agent-market.test/api/orders/${orderId}/commands`, {
    method: "POST",
    headers: {
      cookie: "__Host-agent_market_session=test-session",
      origin: "https://agent-market.test",
      "content-type": "application/json",
      "idempotency-key": "browser-command-test",
      "x-request-id": requestId,
    },
    body: JSON.stringify(typeof body === "string" ? { type: body } : body),
  });
}

describe("POST /api/orders/:orderId/commands public boundary", () => {
  it("keeps start_matching available to the internal system command contract", () => {
    expect(OrderCommandSchema.parse({
      type: "start_matching",
      quoteId,
      taskFingerprint,
      actorWallet: null,
      requestId,
      idempotencyKey: "internal-matching-command",
      occurredAt: "2026-09-01T12:00:00.000Z",
    }).type).toBe("start_matching");
  });

  it.each([{}, { quoteId }, { taskFingerprint }])(
    "rejects internal matching without complete quote context: %j",
    (context) => {
      expect(OrderCommandSchema.safeParse({
        type: "start_matching",
        actorWallet: null,
        requestId,
        idempotencyKey: "internal-matching-command",
        occurredAt: "2026-09-01T12:00:00.000Z",
        ...context,
      }).success).toBe(false);
    },
  );

  it.each(["start_matching", "mark_funded", "settle", "refund"])(
    "rejects system-only command %s before service execution",
    async (type) => {
      const execute = vi.fn(async (): Promise<never> => {
        throw new Error("SYSTEM_COMMAND_REACHED_SERVICE");
      });
      const handler = createOrderCommandHandler({
        auth: { async authenticateSession() { return { walletAddress: "0x1111111111111111111111111111111111111111" }; } },
        service: { execute },
        authOrigin: new URL("https://agent-market.test"),
      });

      const response = await handler(request(type), orderId);
      const body = await response.json() as { error: string };

      expect(response.status).toBe(400);
      expect(body.error).toBe("ORDER_COMMAND_INVALID");
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    { type: "mark_funding_pending" },
    { type: "mark_funding_pending", quoteId },
    { type: "mark_funding_pending", taskFingerprint },
  ])("rejects mark_funding_pending without complete confirmed quote context", async (body) => {
    const execute = vi.fn();
    const handler = createOrderCommandHandler({
      auth: { async authenticateSession() { return { walletAddress: "0x1111111111111111111111111111111111111111" }; } },
      service: { execute },
      authOrigin: new URL("https://agent-market.test"),
    });

    const response = await handler(request(body), orderId);
    const payload = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(payload.error).toBe("ORDER_COMMAND_INVALID");
    expect(execute).not.toHaveBeenCalled();
  });

  it("forwards the complete confirmed quote context to the service", async () => {
    const execute = vi.fn(async (_id: string, command: OrderCommand) => ({
      snapshot: {
        id: orderId,
        publisherWallet: "0x1111111111111111111111111111111111111111",
        agentId: null,
        agentWallet: null,
        title: "Quote-gated order",
        budgetAtomic: "100",
        status: "funding_pending" as const,
        version: 2,
        artifacts: [],
        reviewEligible: false,
        manualReview: null,
        updatedAt: command.occurredAt,
      },
      event: {
        orderId,
        requestId: command.requestId,
        action: command.type,
        actorWallet: command.actorWallet,
        from: "open" as const,
        to: "funding_pending" as const,
        version: 2,
        occurredAt: command.occurredAt,
      },
    }));
    const handler = createOrderCommandHandler({
      auth: { async authenticateSession() { return { walletAddress: "0x1111111111111111111111111111111111111111" }; } },
      service: { execute },
      authOrigin: new URL("https://agent-market.test"),
    });

    const response = await handler(request({ type: "mark_funding_pending", quoteId, taskFingerprint }), orderId);

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(orderId, expect.objectContaining({
      type: "mark_funding_pending",
      quoteId,
      taskFingerprint,
    }));
  });
});
