import { z } from "zod";

const WalletSchema = z.string().regex(/^0x[0-9a-f]{40}$/u);
const UnitScoreSchema = z.number().min(0).max(1);
const AtomicAmountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/u);

export const DisputeAttributionSchema = z.enum([
  "none",
  "agent",
  "publisher",
  "shared",
  "unresolved",
]);

export const ReputationReviewSchema = z.strictObject({
  reviewId: z.string().uuid(),
  orderId: z.string().uuid(),
  agentId: z.string().uuid(),
  reviewerWallet: WalletSchema,
  agentOwnerWallet: WalletSchema,
  qualityScore: UnitScoreSchema,
  timelinessScore: UnitScoreSchema,
  communicationScore: UnitScoreSchema,
  outcome: z.enum(["accepted", "refunded", "disputed"]),
  disputeAttribution: DisputeAttributionSchema,
  orderValueAtomic: AtomicAmountSchema,
  occurredAt: z.string().datetime(),
  reasonCodes: z.array(z.string().min(1).max(80)).max(12),
});

export type ReputationReview = z.infer<typeof ReputationReviewSchema>;

export const ReputationDimensionsSchema = z.strictObject({
  deliveryReliability: z.number().min(0).max(100),
  qualityFeedback: z.number().min(0).max(100),
  communicationExperience: z.number().min(0).max(100),
  disputeOutcome: z.number().min(0).max(100),
  experience: z.number().min(0).max(100),
});

export const ReputationSnapshotSchema = z.strictObject({
  agentId: z.string().uuid(),
  score: z.number().min(0).max(100),
  rawScore: z.number().min(0).max(100),
  dimensions: ReputationDimensionsSchema,
  sampleCount: z.number().int().nonnegative(),
  effectiveSampleWeight: z.number().nonnegative(),
  confidenceValue: z.number().min(0).max(1),
  confidence: z.enum(["low", "medium", "high"]),
  acceptanceRate: z.number().min(0).max(1),
  refundRate: z.number().min(0).max(1),
  disputeRate: z.number().min(0).max(1),
  windowDays: z.literal(90),
  maxEvents: z.literal(20),
  halfLifeDays: z.literal(30),
  priorScore: z.literal(30),
  formulaVersion: z.literal("reputation-v2"),
  calculatedAt: z.string().datetime(),
});

export type ReputationSnapshot = z.infer<typeof ReputationSnapshotSchema>;

const DAY_MS = 86_400_000;
const PRIOR_SCORE = 30;
const EXPERIENCE_ORDER_CAP = 20;
const EXPERIENCE_EARNINGS_CAP_ATOMIC = 1_000_000_000_000_000_000_000_000n;

function weightedAverage(
  reviews: readonly ReputationReview[],
  now: number,
  signal: (review: ReputationReview) => number,
): number {
  let weightedTotal = 0;
  let totalWeight = 0;
  for (const review of reviews) {
    const ageDays = Math.max(0, (now - Date.parse(review.occurredAt)) / DAY_MS);
    const weight = 0.5 ** (ageDays / 30);
    weightedTotal += signal(review) * weight;
    totalWeight += weight;
  }
  return totalWeight === 0 ? 0 : weightedTotal / totalWeight;
}

function log1pBigInt(value: bigint): number {
  if (value <= BigInt(Number.MAX_SAFE_INTEGER)) return Math.log1p(Number(value));
  const digits = value.toString();
  const significantDigits = 15;
  const leading = Number(digits.slice(0, significantDigits));
  return Math.log(leading) + (digits.length - significantDigits) * Math.LN10;
}

function experienceScore(reviews: readonly ReputationReview[]): number {
  const accepted = reviews.filter((review) => review.outcome === "accepted");
  if (accepted.length === 0) return 0;
  const orderSignal = Math.min(1, Math.log1p(accepted.length) / Math.log1p(EXPERIENCE_ORDER_CAP));
  const earnings = accepted.reduce((total, review) => total + BigInt(review.orderValueAtomic), 0n);
  const earningsSignal = Math.min(
    1,
    log1pBigInt(earnings) / log1pBigInt(EXPERIENCE_EARNINGS_CAP_ATOMIC),
  );
  return 100 * (orderSignal + earningsSignal) / 2;
}

export function computeReputationSnapshot(
  agentId: string,
  rawReviews: readonly ReputationReview[],
  calculatedAt: string,
): ReputationSnapshot {
  const now = Date.parse(calculatedAt);
  if (!Number.isFinite(now)) throw new Error("REPUTATION_TIME_INVALID");
  const reviews = rawReviews
    .map((review) => ReputationReviewSchema.parse(review))
    .filter((review) => review.agentId === agentId)
    .filter((review) => {
      const occurredAt = Date.parse(review.occurredAt);
      return occurredAt <= now && now - occurredAt <= 90 * DAY_MS;
    })
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
    .slice(0, 20);

  const dimensions = {
    deliveryReliability: 100 * weightedAverage(
      reviews,
      now,
      (review) => review.outcome === "accepted" ? 0.7 + 0.3 * review.timelinessScore : 0,
    ),
    qualityFeedback: 100 * weightedAverage(reviews, now, (review) => review.qualityScore),
    communicationExperience: 100 * weightedAverage(
      reviews,
      now,
      (review) => review.communicationScore,
    ),
    disputeOutcome: 100 * weightedAverage(reviews, now, (review) => {
      if (review.disputeAttribution === "agent") return 0;
      if (review.disputeAttribution === "shared") return 0.5;
      return 1;
    }),
    experience: experienceScore(reviews),
  };

  const rawScore = 0.35 * dimensions.deliveryReliability
    + 0.25 * dimensions.qualityFeedback
    + 0.10 * dimensions.communicationExperience
    + 0.15 * dimensions.disputeOutcome
    + 0.15 * dimensions.experience;
  const count = reviews.length;
  const confidenceValue = count / (count + 10);
  const score = PRIOR_SCORE + confidenceValue * (rawScore - PRIOR_SCORE);
  const outcomes = (outcome: ReputationReview["outcome"]) =>
    count === 0 ? 0 : reviews.filter((review) => review.outcome === outcome).length / count;
  const effectiveSampleWeight = reviews.reduce((total, review) => {
    const ageDays = Math.max(0, (now - Date.parse(review.occurredAt)) / DAY_MS);
    return total + 0.5 ** (ageDays / 30);
  }, 0);

  return ReputationSnapshotSchema.parse({
    agentId,
    score,
    rawScore,
    dimensions,
    sampleCount: count,
    effectiveSampleWeight,
    confidenceValue,
    confidence: count < 5 ? "low" : count < 15 ? "medium" : "high",
    acceptanceRate: outcomes("accepted"),
    refundRate: outcomes("refunded"),
    disputeRate: outcomes("disputed"),
    windowDays: 90,
    maxEvents: 20,
    halfLifeDays: 30,
    priorScore: 30,
    formulaVersion: "reputation-v2",
    calculatedAt,
  });
}
