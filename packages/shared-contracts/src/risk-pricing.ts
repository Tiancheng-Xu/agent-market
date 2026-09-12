import { z } from "zod";

export const RiskFactorScoresSchema = z.object({
  complexity: z.number().int().min(0).max(100),
  acceptanceAmbiguity: z.number().int().min(0).max(100),
  externalDependency: z.number().int().min(0).max(100),
  dataSensitivity: z.number().int().min(0).max(100),
  financialRisk: z.number().int().min(0).max(100),
  irreversibility: z.number().int().min(0).max(100),
  deadlineRisk: z.number().int().min(0).max(100),
  agentUncertainty: z.number().int().min(0).max(100),
}).strict();

export type RiskFactorScores = z.infer<typeof RiskFactorScoresSchema>;

export const RiskAssessmentInputSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(4_000),
  requirements: z.array(z.string().trim().min(1).max(1_000)).min(1).max(32),
  declaredPermissions: z.array(z.string().trim().min(1).max(160)).max(32),
  durationHours: z.number().positive().max(24 * 365),
  dependencyClasses: z.array(z.string().trim().min(1).max(160)).max(32),
}).strict();

export type RiskAssessmentInput = z.infer<typeof RiskAssessmentInputSchema>;

export const RiskReasonCodeSchema = z.string().trim().regex(/^[a-z][a-z0-9_]{1,79}$/u);

const uniqueReasonCodes = z.array(RiskReasonCodeSchema).min(1).max(32).superRefine((codes, context) => {
  if (new Set(codes).size !== codes.length) {
    context.addIssue({ code: "custom", message: "RISK_REASON_CODES_DUPLICATED" });
  }
});

export const RiskAssessorResultSchema = z.object({
  factors: RiskFactorScoresSchema,
  reasonCodes: uniqueReasonCodes,
}).strict();

export type RiskAssessorResult = z.infer<typeof RiskAssessorResultSchema>;

export const RiskScoreSchema = z.number().int().min(0).max(100);
export const RiskTierSchema = z.enum(["R1", "R2", "R3", "R4", "R5"]);
export type RiskTier = z.infer<typeof RiskTierSchema>;

const policyForScore = (riskScore: number) => {
  if (riskScore <= 20) return { riskTier: "R1" as const, depositRateBps: 500, manualReviewRequired: false };
  if (riskScore <= 40) return { riskTier: "R2" as const, depositRateBps: 1_000, manualReviewRequired: false };
  if (riskScore <= 60) return { riskTier: "R3" as const, depositRateBps: 1_500, manualReviewRequired: false };
  if (riskScore <= 80) return { riskTier: "R4" as const, depositRateBps: 2_500, manualReviewRequired: false };
  return { riskTier: "R5" as const, depositRateBps: 4_000, manualReviewRequired: true };
};

export const RiskAssessmentSchema = RiskAssessorResultSchema.extend({
  riskScore: RiskScoreSchema,
  riskTier: RiskTierSchema,
  depositRateBps: z.number().int().min(0).max(10_000),
  manualReviewRequired: z.boolean(),
}).strict().superRefine((assessment, context) => {
  const expected = policyForScore(assessment.riskScore);
  if (
    assessment.riskTier !== expected.riskTier
    || assessment.depositRateBps !== expected.depositRateBps
    || assessment.manualReviewRequired !== expected.manualReviewRequired
  ) {
    context.addIssue({ code: "custom", message: "RISK_POLICY_MISMATCH" });
  }
});

export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

export const RiskQuotePhaseSchema = z.enum(["preliminary", "final"]);
export type RiskQuotePhase = z.infer<typeof RiskQuotePhaseSchema>;

export const TaskFingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export const AtomicAmountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/u);

export const RiskQuoteRequestSchema = z.object({
  taskFingerprint: TaskFingerprintSchema,
}).strict();

export type RiskQuoteRequest = z.infer<typeof RiskQuoteRequestSchema>;

export const AgentDepositNodeSchema = z.object({
  agentId: z.string().trim().min(1).max(160),
  shareBps: z.number().int().positive().max(10_000),
  nodeRiskMultiplierBps: z.number().int().positive().max(100_000),
  reputationRiskMultiplierBps: z.number().int().positive().max(100_000),
}).strict();

export type AgentDepositNode = z.infer<typeof AgentDepositNodeSchema>;

export const AgentDepositAllocationSchema = z.object({
  agentId: z.string().trim().min(1).max(160),
  amountAtomic: AtomicAmountSchema,
}).strict();

export type AgentDepositAllocation = z.infer<typeof AgentDepositAllocationSchema>;

export const RiskAssetIdSchema = z.string().regex(/^eip155:[1-9][0-9]{0,15}\/erc20:0x[0-9a-f]{40}$/u)
  .refine(value => !value.endsWith('0x' + '0'.repeat(40)), 'RISK_ASSET_ZERO_ADDRESS');

const RiskQuoteBaseSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  assetId: RiskAssetIdSchema.optional(),
  phase: RiskQuotePhaseSchema,
  policyVersion: z.string().trim().min(1).max(80),
  taskFingerprint: TaskFingerprintSchema,
  riskScore: RiskScoreSchema,
  riskTier: RiskTierSchema,
  depositRateBps: z.number().int().min(0).max(10_000),
  serviceFeeBps: z.number().int().min(0).max(10_000),
  manualReviewRequired: z.boolean(),
  reasonCodes: uniqueReasonCodes,
  P: AtomicAmountSchema,
  A: AtomicAmountSchema,
  B: AtomicAmountSchema,
  publisherTotal: AtomicAmountSchema,
  agentTeamDeposit: AtomicAmountSchema,
  agentAllocations: z.array(AgentDepositAllocationSchema).max(256),
  expiresAt: z.string().datetime(),
}).strict();

export const RiskQuoteSchema = RiskQuoteBaseSchema.superRefine((quote, context) => {
  if ((quote.schemaVersion === 2 && !quote.assetId) || (quote.schemaVersion !== 2 && quote.assetId !== undefined)) {
    context.addIssue({ code: 'custom', message: 'RISK_QUOTE_ASSET_VERSION_INVALID' });
  }
  const expected = policyForScore(quote.riskScore);
  if (
    quote.riskTier !== expected.riskTier
    || quote.depositRateBps !== expected.depositRateBps
    || quote.manualReviewRequired !== expected.manualReviewRequired
  ) {
    context.addIssue({ code: "custom", message: "RISK_QUOTE_POLICY_MISMATCH" });
  }

  if (BigInt(quote.publisherTotal) !== BigInt(quote.P) + BigInt(quote.A) + BigInt(quote.B)) {
    context.addIssue({ code: "custom", message: "RISK_QUOTE_PUBLISHER_TOTAL_MISMATCH" });
  }
  if (quote.agentTeamDeposit !== quote.A) {
    context.addIssue({ code: "custom", message: "RISK_QUOTE_SYMMETRIC_DEPOSIT_REQUIRED" });
  }

  if (quote.phase === "preliminary" && quote.agentAllocations.length !== 0) {
    context.addIssue({ code: "custom", message: "RISK_QUOTE_PRELIMINARY_ALLOCATION_FORBIDDEN" });
  }
  if (quote.phase === "final" && quote.agentAllocations.length === 0) {
    context.addIssue({ code: "custom", message: "RISK_QUOTE_FINAL_ALLOCATION_REQUIRED" });
  }

  const agentIds = quote.agentAllocations.map(({ agentId }) => agentId);
  if (new Set(agentIds).size !== agentIds.length) {
    context.addIssue({ code: "custom", message: "RISK_QUOTE_AGENT_ALLOCATION_DUPLICATED" });
  }
  const allocated = quote.agentAllocations.reduce((total, allocation) => total + BigInt(allocation.amountAtomic), 0n);
  if (quote.phase === "final" && allocated !== BigInt(quote.A)) {
    context.addIssue({ code: "custom", message: "RISK_QUOTE_AGENT_ALLOCATION_MISMATCH" });
  }
});

export type RiskQuote = z.infer<typeof RiskQuoteSchema>;
