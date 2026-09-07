import {
  ReputationReviewSchema,
  type ReputationReview,
} from "@agent-market/shared-contracts";
import type { Sql } from "postgres";

import type { ReputationStore, ReviewEligibility } from "./reputation-service.js";

type DatabaseRow = Record<string, unknown>;
const WALLET = /^0x[0-9a-f]{40}$/u;

const iso = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  throw new Error("REPUTATION_V2_TIMESTAMP_INVALID");
};

const wallet = (value: unknown, code: string): string => {
  const parsed = String(value).toLowerCase();
  if (!WALLET.test(parsed)) throw new Error(code);
  return parsed;
};

const reasonCodes = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("REPUTATION_V2_REASON_CODES_INVALID");
  }
  return value as string[];
};

const unitScore = (value: unknown, code: string): number => {
  if (value === null || value === undefined || value === "") throw new Error(code);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
};

export function reputationReviewFromDatabase(row: DatabaseRow): ReputationReview {
  return ReputationReviewSchema.parse({
    reviewId: row.review_id,
    orderId: row.order_id,
    agentId: row.agent_id,
    reviewerWallet: wallet(row.reviewer_wallet, "REPUTATION_V2_REVIEWER_WALLET_MISSING"),
    agentOwnerWallet: wallet(row.agent_owner_wallet, "REPUTATION_V2_AGENT_WALLET_MISSING"),
    qualityScore: unitScore(row.quality_score, "REPUTATION_V2_QUALITY_SCORE_MISSING"),
    timelinessScore: unitScore(row.timeliness_score, "REPUTATION_V2_TIMELINESS_SCORE_MISSING"),
    communicationScore: unitScore(row.communication_score, "REPUTATION_V2_COMMUNICATION_SCORE_MISSING"),
    outcome: row.outcome,
    disputeAttribution: row.dispute_attribution,
    orderValueAtomic: String(row.order_value_atomic ?? ""),
    occurredAt: iso(row.occurred_at),
    reasonCodes: reasonCodes(row.reason_codes),
  });
}

function eligibilityFromDatabase(row: DatabaseRow): ReviewEligibility & { orderValueAtomic: string } {
  const owner = wallet(row.agent_owner_wallet, "REPUTATION_V2_AGENT_WALLET_MISSING");
  const currentOwner = wallet(row.current_agent_owner_wallet, "REPUTATION_V2_CURRENT_AGENT_WALLET_MISSING");
  if (owner !== currentOwner || row.agent_status !== "published") {
    throw new Error("REPUTATION_V2_AGENT_AUTHORITY_CONFLICT");
  }
  const orderValueAtomic = String(row.order_value_atomic ?? "");
  if (!/^[1-9][0-9]*$/u.test(orderValueAtomic)) throw new Error("REPUTATION_V2_ORDER_VALUE_MISSING");
  if (!(["available", "consumed", "revoked"] as const).includes(row.status as never)) {
    throw new Error("REPUTATION_V2_ELIGIBILITY_STATUS_INVALID");
  }
  return {
    orderId: String(row.order_id),
    taskId: String(row.task_id),
    agentId: String(row.agent_id),
    publisherWallet: wallet(row.publisher_wallet, "REPUTATION_V2_PUBLISHER_WALLET_MISSING"),
    agentOwnerWallet: owner,
    status: row.status as ReviewEligibility["status"],
    orderValueAtomic,
  };
}

export class PostgresReputationV2Store implements ReputationStore {
  constructor(private readonly sql: Sql) {}

  async findEligibility(orderId: string): Promise<ReviewEligibility | null> {
    const rows = await this.sql<DatabaseRow[]>`
      SELECT
        eligibility.order_id,
        eligibility.task_id,
        eligibility.agent_id,
        eligibility.publisher_wallet,
        eligibility.agent_owner_wallet,
        eligibility.order_value_atomic::text AS order_value_atomic,
        eligibility.status,
        agent.owner_wallet AS current_agent_owner_wallet,
        agent.status AS agent_status
      FROM agent_market.reputation_v2_review_eligibilities eligibility
      LEFT JOIN agent_market.agents agent ON agent.id = eligibility.agent_id
      WHERE eligibility.order_id = ${orderId}
    `;
    return rows[0] ? eligibilityFromDatabase(rows[0]) : null;
  }

  async findEligibilityForTaskAgent(taskId: string, agentId: string): Promise<ReviewEligibility | null> {
    const rows = await this.sql<DatabaseRow[]>`
      SELECT
        eligibility.order_id,
        eligibility.task_id,
        eligibility.agent_id,
        eligibility.publisher_wallet,
        eligibility.agent_owner_wallet,
        eligibility.order_value_atomic::text AS order_value_atomic,
        eligibility.status,
        agent.owner_wallet AS current_agent_owner_wallet,
        agent.status AS agent_status
      FROM agent_market.reputation_v2_review_eligibilities eligibility
      LEFT JOIN agent_market.agents agent ON agent.id = eligibility.agent_id
      WHERE eligibility.task_id = ${taskId} AND eligibility.agent_id = ${agentId}
    `;
    return rows[0] ? eligibilityFromDatabase(rows[0]) : null;
  }

  async findReview(orderId: string): Promise<ReputationReview | null> {
    const rows = await this.sql<DatabaseRow[]>`
      SELECT review_id, order_id, agent_id, reviewer_wallet, agent_owner_wallet,
        quality_score, timeliness_score, communication_score, outcome,
        dispute_attribution, order_value_atomic::text AS order_value_atomic,
        reason_codes, occurred_at
      FROM agent_market.reputation_v2_reviews
      WHERE order_id = ${orderId}
    `;
    return rows[0] ? reputationReviewFromDatabase(rows[0]) : null;
  }

  async listReviews(agentId: string): Promise<ReputationReview[]> {
    const rows = await this.sql<DatabaseRow[]>`
      SELECT review_id, order_id, agent_id, reviewer_wallet, agent_owner_wallet,
        quality_score, timeliness_score, communication_score, outcome,
        dispute_attribution, order_value_atomic::text AS order_value_atomic,
        reason_codes, occurred_at
      FROM agent_market.reputation_v2_reviews
      WHERE agent_id = ${agentId}
      ORDER BY occurred_at DESC
      LIMIT 20
    `;
    return rows.map(reputationReviewFromDatabase);
  }

  async linkedWallets(ownerWallet: string): Promise<string[]> {
    const normalized = wallet(ownerWallet, "REPUTATION_V2_AGENT_WALLET_MISSING");
    const rows = await this.sql<DatabaseRow[]>`
      SELECT CASE
        WHEN lower(owner_wallet) = ${normalized} THEN lower(linked_wallet)
        ELSE lower(owner_wallet)
      END AS linked_wallet
      FROM agent_market.reputation_wallet_links
      WHERE lower(owner_wallet) = ${normalized} OR lower(linked_wallet) = ${normalized}
    `;
    return [...new Set(rows.map((row) => wallet(row.linked_wallet, "REPUTATION_V2_LINKED_WALLET_INVALID")))];
  }

  async saveReview(input: ReputationReview): Promise<void> {
    const review = ReputationReviewSchema.parse(input);
    await this.sql.begin(async (transaction) => {
      const eligibilityRows = await transaction<DatabaseRow[]>`
        SELECT
          eligibility.order_id,
          eligibility.task_id,
          eligibility.agent_id,
          eligibility.publisher_wallet,
          eligibility.agent_owner_wallet,
          eligibility.order_value_atomic::text AS order_value_atomic,
          eligibility.status,
          agent.owner_wallet AS current_agent_owner_wallet,
          agent.status AS agent_status
        FROM agent_market.reputation_v2_review_eligibilities eligibility
        LEFT JOIN agent_market.agents agent ON agent.id = eligibility.agent_id
        WHERE eligibility.order_id = ${review.orderId}
        FOR UPDATE OF eligibility
      `;
      const eligibility = eligibilityRows[0] ? eligibilityFromDatabase(eligibilityRows[0]) : null;
      if (!eligibility || eligibility.status !== "available") throw new Error("REVIEW_NOT_ELIGIBLE");
      if (eligibility.agentId !== review.agentId) throw new Error("REVIEW_AGENT_CONFLICT");
      if (eligibility.publisherWallet !== review.reviewerWallet) throw new Error("REVIEW_PUBLISHER_FORBIDDEN");
      if (eligibility.agentOwnerWallet !== review.agentOwnerWallet) throw new Error("REVIEW_OWNER_CONFLICT");
      if (eligibility.orderValueAtomic !== review.orderValueAtomic) throw new Error("REVIEW_ORDER_VALUE_CONFLICT");

      const inserted = await transaction<DatabaseRow[]>`
        INSERT INTO agent_market.reputation_v2_reviews (
          review_id, order_id, task_id, agent_id, reviewer_wallet, agent_owner_wallet,
          quality_score, timeliness_score, communication_score, outcome,
          dispute_attribution, order_value_atomic, reason_codes, occurred_at
        )
        SELECT
          ${review.reviewId}, eligibility.order_id, eligibility.task_id, ${review.agentId},
          ${review.reviewerWallet}, ${review.agentOwnerWallet}, ${review.qualityScore},
          ${review.timelinessScore}, ${review.communicationScore}, ${review.outcome},
          ${review.disputeAttribution}, ${review.orderValueAtomic}::numeric,
          ${review.reasonCodes}, ${review.occurredAt}::timestamptz
        FROM agent_market.reputation_v2_review_eligibilities eligibility
        WHERE eligibility.order_id = ${review.orderId}
        ON CONFLICT (task_id, agent_id) DO NOTHING
        RETURNING review_id
      `;
      if (!inserted[0]) throw new Error("REVIEW_ALREADY_EXISTS");

      const consumed = await transaction<DatabaseRow[]>`
        UPDATE agent_market.reputation_v2_review_eligibilities
        SET status = 'consumed', consumed_at = ${review.occurredAt}::timestamptz
        WHERE order_id = ${review.orderId} AND status = 'available'
        RETURNING order_id
      `;
      if (!consumed[0]) throw new Error("REVIEW_ELIGIBILITY_CONFLICT");
    });
  }
}
