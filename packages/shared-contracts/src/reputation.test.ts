import { describe, expect, it } from "vitest";

import { computeReputationSnapshot, type ReputationReview } from "./reputation";

const agentId = "22222222-2222-4222-8222-222222222222";
const calculatedAt = "2026-09-01T12:00:00.000Z";

function review(overrides: Partial<ReputationReview> = {}): ReputationReview {
  return {
    reviewId: crypto.randomUUID(),
    orderId: crypto.randomUUID(),
    agentId,
    reviewerWallet: "0x1111111111111111111111111111111111111111",
    agentOwnerWallet: "0x2222222222222222222222222222222222222222",
    qualityScore: 1,
    timelinessScore: 1,
    communicationScore: 1,
    outcome: "accepted",
    disputeAttribution: "none",
    orderValueAtomic: "1000000000000000000",
    occurredAt: calculatedAt,
    reasonCodes: ["DELIVERY_ACCEPTED"],
    ...overrides,
  };
}

describe("computeReputationSnapshot V2", () => {
  it("shrinks one perfect review toward the 30 point prior", () => {
    const result = computeReputationSnapshot(agentId, [review()], calculatedAt);
    expect(result.score).toBeGreaterThan(30);
    expect(result.score).toBeLessThan(50);
    expect(result.confidenceValue).toBeCloseTo(1 / 11);
    expect(result.formulaVersion).toBe("reputation-v2");
  });

  it("does not penalize an Agent who wins a dispute", () => {
    const result = computeReputationSnapshot(agentId, [review({
      outcome: "disputed",
      disputeAttribution: "publisher",
    })], calculatedAt);
    expect(result.dimensions.disputeOutcome).toBe(100);
  });

  it("penalizes only attributed or shared Agent fault", () => {
    const agentFault = computeReputationSnapshot(agentId, [review({
      outcome: "disputed",
      disputeAttribution: "agent",
    })], calculatedAt);
    const sharedFault = computeReputationSnapshot(agentId, [review({
      outcome: "disputed",
      disputeAttribution: "shared",
    })], calculatedAt);
    expect(agentFault.dimensions.disputeOutcome).toBe(0);
    expect(sharedFault.dimensions.disputeOutcome).toBe(50);
  });

  it("uses only the latest 20 events inside the 90 day window", () => {
    const recent = Array.from({ length: 22 }, (_, index) => review({
      reviewId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      orderId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      occurredAt: new Date(Date.parse(calculatedAt) - index * 86_400_000).toISOString(),
    }));
    const expired = review({ occurredAt: "2026-05-01T12:00:00.000Z" });
    expect(computeReputationSnapshot(agentId, [...recent, expired], calculatedAt).sampleCount).toBe(20);
  });
});
