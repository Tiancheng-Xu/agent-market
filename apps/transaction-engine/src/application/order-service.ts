import { createHash } from "node:crypto";

import {
  applyOrderCommand,
  OrderCommandSchema,
  type OrderCommand,
  type OrderEvent,
  type OrderSnapshot,
} from "@agent-market/shared-contracts";

export type StoredOrderResult = {
  fingerprint: string;
  snapshot: OrderSnapshot;
  event: OrderEvent;
};

export interface OrderStore {
  find(orderId: string): Promise<OrderSnapshot | null>;
  findResult(orderId: string, idempotencyKey: string): Promise<StoredOrderResult | null>;
  commit(input: {
    expectedVersion: number;
    fingerprint: string;
    idempotencyKey: string;
    snapshot: OrderSnapshot;
    event: OrderEvent;
  }): Promise<void>;
}

type QuoteGateDecision =
  | { status: "ready"; code: string; quoteId: string }
  | { status: "blocked"; code: string; quoteId: string }
  | { status: "manual_review"; code: string; reasonCode: string; quoteId: string };

export interface OrderRiskQuoteGate {
  evaluatePreliminary(input: {
    taskId: string;
    quoteId: string;
    taskFingerprint: string;
    evaluatedAt: string;
  }): Promise<QuoteGateDecision>;
  evaluateFunding(input: {
    taskId: string;
    quoteId: string;
    taskFingerprint: string;
    evaluatedAt: string;
  }): Promise<QuoteGateDecision>;
}

function commandFingerprint(command: OrderCommand): string {
  const { requestId: _requestId, idempotencyKey: _idempotencyKey, occurredAt: _occurredAt, ...payload } = command;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export class OrderService {
  constructor(
    private readonly store: OrderStore,
    private readonly riskQuoteGate?: OrderRiskQuoteGate,
  ) {}

  async execute(orderId: string, input: OrderCommand): Promise<{ snapshot: OrderSnapshot; event: OrderEvent }> {
    const command = OrderCommandSchema.parse(input);
    const fingerprint = commandFingerprint(command);
    const existing = await this.store.findResult(orderId, command.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("ORDER_IDEMPOTENCY_CONFLICT");
      return { snapshot: existing.snapshot, event: existing.event };
    }

    const current = await this.store.find(orderId);
    if (!current) throw new Error("ORDER_NOT_FOUND");
    let effectiveCommand = command;
    if (command.type === "start_matching" || command.type === "mark_funding_pending") {
      if (!this.riskQuoteGate) throw new Error("RISK_QUOTE_GATE_UNAVAILABLE");
      let decision: QuoteGateDecision;
      try {
        const input = {
          taskId: orderId,
          quoteId: command.quoteId,
          taskFingerprint: command.taskFingerprint,
          evaluatedAt: command.occurredAt,
        };
        decision = command.type === "start_matching"
          ? await this.riskQuoteGate.evaluatePreliminary(input)
          : await this.riskQuoteGate.evaluateFunding(input);
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (!["RISK_QUOTE_STATE_UNKNOWN", "RISK_QUOTE_READ_TIMEOUT", "FUNDING_STATE_UNKNOWN"].includes(code)) throw error;
        decision = {
          status: "manual_review",
          code,
          reasonCode: "funding_state_unknown",
          quoteId: command.quoteId,
        };
      }
      if (decision.status === "blocked") throw new Error(decision.code);
      if (decision.status === "manual_review") {
        effectiveCommand = OrderCommandSchema.parse({
          type: "mark_manual_review",
          requestId: command.requestId,
          idempotencyKey: command.idempotencyKey,
          actorWallet: null,
          occurredAt: command.occurredAt,
          reasonCode: decision.reasonCode,
        });
      }
    }
    const result = applyOrderCommand(current, effectiveCommand);
    await this.store.commit({
      expectedVersion: current.version,
      fingerprint,
      idempotencyKey: command.idempotencyKey,
      ...result,
    });
    return result;
  }
}

export class MemoryOrderStore implements OrderStore {
  private readonly orders = new Map<string, OrderSnapshot>();
  private readonly results = new Map<string, StoredOrderResult>();

  constructor(seed: readonly OrderSnapshot[] = []) {
    seed.forEach((order) => this.orders.set(order.id, structuredClone(order)));
  }

  async find(orderId: string): Promise<OrderSnapshot | null> {
    const order = this.orders.get(orderId);
    return order ? structuredClone(order) : null;
  }

  async findResult(orderId: string, idempotencyKey: string): Promise<StoredOrderResult | null> {
    const result = this.results.get(`${orderId}:${idempotencyKey}`);
    return result ? structuredClone(result) : null;
  }

  async commit(input: {
    expectedVersion: number;
    fingerprint: string;
    idempotencyKey: string;
    snapshot: OrderSnapshot;
    event: OrderEvent;
  }): Promise<void> {
    const current = this.orders.get(input.snapshot.id);
    if (!current) throw new Error("ORDER_NOT_FOUND");
    if (current.version !== input.expectedVersion) throw new Error("ORDER_VERSION_CONFLICT");
    const key = `${input.snapshot.id}:${input.idempotencyKey}`;
    const existing = this.results.get(key);
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) throw new Error("ORDER_IDEMPOTENCY_CONFLICT");
      return;
    }
    this.orders.set(input.snapshot.id, structuredClone(input.snapshot));
    this.results.set(key, structuredClone({
      fingerprint: input.fingerprint,
      snapshot: input.snapshot,
      event: input.event,
    }));
  }
}
