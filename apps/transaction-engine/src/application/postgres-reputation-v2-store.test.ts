import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import type { ReputationReview } from "@agent-market/shared-contracts";
import { PostgresReputationV2Store } from "./postgres-reputation-v2-store";

const orderId = "11111111-1111-4111-8111-111111111111";
const taskId = "44444444-4444-4444-8444-444444444444";
const agentId = "22222222-2222-4222-8222-222222222222";
const publisher = "0x1111111111111111111111111111111111111111";
const owner = "0x2222222222222222222222222222222222222222";

function fakeSql(responses: unknown[][]) {
  let begins = 0;
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join("?"), values });
    return responses.shift() ?? [];
  }) as unknown as Sql;
  Object.assign(tag, {
    begin: async (callback: (transaction: Sql) => Promise<unknown>) => {
      begins += 1;
      return callback(tag);
    },
  });
  return { sql: tag, begins: () => begins, queries };
}

const eligibility = (overrides: Record<string, unknown> = {}) => ({
  order_id: orderId,
  task_id: taskId,
  agent_id: agentId,
  publisher_wallet: publisher,
  agent_owner_wallet: owner,
  current_agent_owner_wallet: owner,
  agent_status: "published",
  order_value_atomic: "100000",
  status: "available",
  ...overrides,
});

const reviewRow = (overrides: Record<string, unknown> = {}) => ({
  review_id: "33333333-3333-4333-8333-333333333333",
  order_id: orderId,
  agent_id: agentId,
  reviewer_wallet: publisher,
  agent_owner_wallet: owner,
  quality_score: "0.9",
  timeliness_score: "0.8",
  communication_score: "0.7",
  outcome: "accepted",
  dispute_attribution: "none",
  order_value_atomic: "100000",
  reason_codes: ["accepted_delivery"],
  occurred_at: "2026-09-01T12:00:00.000Z",
  ...overrides,
});

const review: ReputationReview = {
  reviewId: "33333333-3333-4333-8333-333333333333",
  orderId,
  agentId,
  reviewerWallet: publisher,
  agentOwnerWallet: owner,
  qualityScore: 0.9,
  timelinessScore: 0.8,
  communicationScore: 0.7,
  outcome: "accepted",
  disputeAttribution: "none",
  orderValueAtomic: "100000",
  occurredAt: "2026-09-01T12:00:00.000Z",
  reasonCodes: ["accepted_delivery"],
};

describe("PostgresReputationV2Store", () => {
  it("reads an exact team-order eligibility with current Agent authority", async () => {
    const database = fakeSql([[eligibility()]]);
    await expect(new PostgresReputationV2Store(database.sql).findEligibility(orderId)).resolves.toEqual({
      orderId,
      taskId,
      agentId,
      publisherWallet: publisher,
      agentOwnerWallet: owner,
      status: "available",
      orderValueAtomic: "100000",
    });
  });

  it("hands off a Team eligibility through stable task and Agent keys", async () => {
    const database = fakeSql([[eligibility()]]);
    await expect(new PostgresReputationV2Store(database.sql).findEligibilityForTaskAgent(taskId, agentId)).resolves.toMatchObject({
      orderId,
      taskId,
      agentId,
      status: "available",
    });
    expect(database.queries[0]?.text).toContain("WHERE eligibility.task_id = ? AND eligibility.agent_id = ?");
    expect(database.queries[0]?.values).toEqual([taskId, agentId]);
  });

  it("strictly rejects a historical row missing a V2 field", async () => {
    const database = fakeSql([[reviewRow({ communication_score: null })]]);
    await expect(new PostgresReputationV2Store(database.sql).listReviews(agentId)).rejects.toThrow();
  });

  it("stores a complete V2 review and consumes eligibility in one transaction", async () => {
    const database = fakeSql([[eligibility()], [{ review_id: review.reviewId }], [{ order_id: orderId }]]);
    await expect(new PostgresReputationV2Store(database.sql).saveReview(review)).resolves.toBeUndefined();
    expect(database.begins()).toBe(1);
  });

  it("rejects a second review for the same Team order and Agent", async () => {
    const database = fakeSql([[eligibility()], []]);
    await expect(new PostgresReputationV2Store(database.sql).saveReview(review)).rejects.toThrow(
      "REVIEW_ALREADY_EXISTS",
    );
    expect(database.begins()).toBe(1);
  });

  it.each([
    ["missing wallet", { current_agent_owner_wallet: null }, "REPUTATION_V2_CURRENT_AGENT_WALLET_MISSING"],
    ["inactive Agent", { agent_status: "paused" }, "REPUTATION_V2_AGENT_AUTHORITY_CONFLICT"],
    ["missing amount", { order_value_atomic: null }, "REPUTATION_V2_ORDER_VALUE_MISSING"],
  ])("fails closed for %s", async (_label, override, code) => {
    const database = fakeSql([[eligibility(override)]]);
    await expect(new PostgresReputationV2Store(database.sql).findEligibility(orderId)).rejects.toThrow(code);
  });

  it("rejects a review whose amount differs from the immutable eligibility snapshot", async () => {
    const database = fakeSql([[eligibility({ order_value_atomic: "99999" })]]);
    await expect(new PostgresReputationV2Store(database.sql).saveReview(review)).rejects.toThrow(
      "REVIEW_ORDER_VALUE_CONFLICT",
    );
  });

  it("loads every V2 review using all five reputation dimensions", async () => {
    const database = fakeSql([[reviewRow()]]);
    await expect(new PostgresReputationV2Store(database.sql).listReviews(agentId)).resolves.toEqual([review]);
  });
});
