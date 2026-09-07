import { describe, expect, it } from "vitest";

import type { ReputationReview } from "@agent-market/shared-contracts";
import { MemoryReputationStore, ReputationService } from "./reputation-service";

const publisher = "0x1111111111111111111111111111111111111111";
const owner = "0x2222222222222222222222222222222222222222";
const linked = "0x3333333333333333333333333333333333333333";
const orderId = "11111111-1111-4111-8111-111111111111";
const taskId = "44444444-4444-4444-8444-444444444444";
const agentId = "22222222-2222-4222-8222-222222222222";
const review: ReputationReview = {
  reviewId: "33333333-3333-4333-8333-333333333333",
  orderId,
  agentId,
  reviewerWallet: publisher,
  agentOwnerWallet: owner,
  qualityScore: 1,
  timelinessScore: 0.8,
  communicationScore: 0.9,
  outcome: "accepted",
  disputeAttribution: "none",
  orderValueAtomic: "1000000000000000000",
  occurredAt: "2026-08-31T12:00:00.000Z",
  reasonCodes: ["delivery_accepted"],
};

const store = () => new MemoryReputationStore([{
  orderId,
  taskId,
  agentId,
  publisherWallet: publisher,
  agentOwnerWallet: owner,
  status: "available",
}]);

describe("ReputationService", () => {
  it("grants one low-confidence smoothed review from an accepted order", async () => {
    const service = new ReputationService(store());
    const snapshot = await service.submitReview(review);
    expect(snapshot).toMatchObject({
      sampleCount: 1,
      confidence: "low",
      acceptanceRate: 1,
      formulaVersion: "reputation-v2",
    });
    expect(snapshot.score).toBeGreaterThan(30);
    expect(snapshot.score).toBeLessThan(50);
    await expect(service.submitReview(review)).rejects.toThrow("REVIEW_NOT_ELIGIBLE");
  });

  it("resolves a consumable eligibility from stable task and Agent keys", async () => {
    await expect(new ReputationService(store()).findEligibilityForTaskAgent(taskId, agentId)).resolves.toMatchObject({
      orderId,
      taskId,
      agentId,
      status: "available",
    });
  });

  it("rejects self reviews and linked-wallet reviews", async () => {
    const selfService = new ReputationService(new MemoryReputationStore([{
      orderId,
      taskId,
      agentId,
      publisherWallet: owner,
      agentOwnerWallet: owner,
      status: "available",
    }]));
    await expect(selfService.submitReview({
      ...review,
      reviewerWallet: owner,
    })).rejects.toThrow("REVIEW_SELF_FORBIDDEN");

    const linkedStore = new MemoryReputationStore([{
      orderId,
      taskId,
      agentId,
      publisherWallet: linked,
      agentOwnerWallet: owner,
      status: "available",
    }]);
    linkedStore.setLinkedWallets(owner, [linked]);
    const linkedService = new ReputationService(linkedStore);
    await expect(linkedService.submitReview({
      ...review,
      reviewerWallet: linked,
    })).rejects.toThrow("REVIEW_LINKED_WALLET_FORBIDDEN");
  });
});
