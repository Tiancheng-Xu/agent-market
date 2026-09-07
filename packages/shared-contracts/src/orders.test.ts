import { describe, expect, it } from "vitest";

import { applyOrderCommand, type OrderCommand, type OrderSnapshot } from "./orders";

const publisher = "0x1111111111111111111111111111111111111111";
const agent = "0x2222222222222222222222222222222222222222";
const base: OrderSnapshot = {
  id: "11111111-1111-4111-8111-111111111111",
  publisherWallet: publisher,
  agentId: null,
  agentWallet: null,
  title: "Audit the delivery",
  budgetAtomic: "100",
  status: "open",
  version: 1,
  artifacts: [],
  reviewEligible: false,
  manualReview: null,
  updatedAt: "2026-08-31T12:00:00.000Z",
};

type CommandInput<T = OrderCommand> = T extends OrderCommand
  ? Omit<T, "requestId" | "idempotencyKey" | "occurredAt">
  : never;

const command = <T extends CommandInput>(value: T): OrderCommand => ({
  ...value,
  requestId: crypto.randomUUID(),
  idempotencyKey: `order-action-${crypto.randomUUID()}`,
  occurredAt: "2026-08-31T12:01:00.000Z",
}) as OrderCommand;

describe("order contract", () => {
  it("supports the quote-gated order sequence from matching through funding", () => {
    const matching = applyOrderCommand(
      base,
      command({
        type: "start_matching",
        actorWallet: null,
        quoteId: "44444444-4444-4444-8444-444444444444",
        taskFingerprint: `sha256:${"b".repeat(64)}`,
      }),
    ).snapshot;
    const assigned = applyOrderCommand(
      matching,
      command({
        type: "assign_agent",
        actorWallet: null,
        agentId: "33333333-3333-4333-8333-333333333333",
        agentWallet: agent,
      }),
    ).snapshot;
    const pending = applyOrderCommand(
      assigned,
      command({
        type: "mark_funding_pending",
        actorWallet: publisher,
        quoteId: "55555555-5555-4555-8555-555555555555",
        taskFingerprint: `sha256:${"c".repeat(64)}`,
      }),
    ).snapshot;
    const funded = applyOrderCommand(
      pending,
      command({ type: "confirm_funding", actorWallet: null }),
    ).snapshot;

    expect([matching.status, assigned.status, pending.status, funded.status]).toEqual([
      "matching",
      "assigned",
      "funding_pending",
      "funded",
    ]);
  });

  it("requires the assigned agent and a verifiable artifact before acceptance", () => {
    const assigned = { ...base, status: "assigned" as const, agentId: "33333333-3333-4333-8333-333333333333", agentWallet: agent };
    expect(() => applyOrderCommand(assigned, command({ type: "accept_assignment", actorWallet: publisher }))).toThrow(
      "ORDER_AGENT_FORBIDDEN",
    );
    const inProgress = applyOrderCommand(
      assigned,
      command({ type: "accept_assignment", actorWallet: agent }),
    ).snapshot;
    const submitted = applyOrderCommand(
      inProgress,
      command({
        type: "submit_artifact",
        actorWallet: agent,
        artifact: {
          id: "22222222-2222-4222-8222-222222222222",
          uri: "https://agent.example/artifacts/result.json",
          contentHash: `sha256:${"a".repeat(64)}`,
          mediaType: "application/json",
          sizeBytes: 128,
          submittedAt: "2026-08-31T12:01:00.000Z",
        },
      }),
    ).snapshot;
    const accepted = applyOrderCommand(
      submitted,
      command({ type: "accept_delivery", actorWallet: publisher }),
    ).snapshot;
    expect(accepted).toMatchObject({ status: "accepted", reviewEligible: true });
  });

  it("routes unknown money state to manual review and restores only after operator action", () => {
    const funded = { ...base, status: "funded" as const };
    const held = applyOrderCommand(
      funded,
      command({ type: "mark_manual_review", actorWallet: null, reasonCode: "rpc_sources_disagree" }),
    ).snapshot;
    expect(held).toMatchObject({
      status: "manual_review",
      manualReview: { previousStatus: "funded", reasonCode: "rpc_sources_disagree" },
    });
    expect(() =>
      applyOrderCommand(held, command({ type: "resolve_manual_review", actorWallet: null })),
    ).toThrow("ORDER_OPERATOR_REQUIRED");
    expect(
      applyOrderCommand(
        held,
        command({ type: "resolve_manual_review", actorWallet: publisher }),
      ).snapshot.status,
    ).toBe("funded");
  });
});
