import {
  ReputationSnapshotSchema,
  RiskAssessmentSchema,
  RiskQuoteSchema,
  type ReputationSnapshot,
  type RiskAssessment,
  type RiskQuote,
} from "@agent-market/shared-contracts";

export type RiskPricingLocale = "zh-CN" | "en";

export type RiskQuoteViewModel = RiskQuote & {
  quoteId: string;
  manualApprovedAt?: string | null;
};

export type QuoteConfirmationIntent = {
  quoteId: string;
  taskFingerprint: string;
};

export type RiskQuoteStatus = "preliminary" | "manual_review" | "expired" | "ready";

const factorOrder = [
  "complexity",
  "acceptanceAmbiguity",
  "externalDependency",
  "dataSensitivity",
  "financialRisk",
  "irreversibility",
  "deadlineRisk",
  "agentUncertainty",
] as const;

const factorLabels = {
  en: {
    complexity: "Complexity",
    acceptanceAmbiguity: "Acceptance ambiguity",
    externalDependency: "External dependency",
    dataSensitivity: "Data sensitivity",
    financialRisk: "Financial risk",
    irreversibility: "Irreversibility",
    deadlineRisk: "Deadline risk",
    agentUncertainty: "Agent uncertainty",
  },
  "zh-CN": {
    complexity: "任务复杂度",
    acceptanceAmbiguity: "验收歧义",
    externalDependency: "外部依赖",
    dataSensitivity: "数据敏感性",
    financialRisk: "资金风险",
    irreversibility: "不可逆性",
    deadlineRisk: "期限风险",
    agentUncertainty: "Agent 不确定性",
  },
} as const;

const reputationLabels = {
  en: {
    deliveryReliability: "Delivery reliability",
    qualityFeedback: "Quality feedback",
    communicationExperience: "Communication",
    disputeOutcome: "Dispute outcome",
    experience: "Experience",
  },
  "zh-CN": {
    deliveryReliability: "交付可靠性",
    qualityFeedback: "质量反馈",
    communicationExperience: "沟通体验",
    disputeOutcome: "争议结果",
    experience: "历史经验",
  },
} as const;

function parseQuoteViewModel(input: RiskQuoteViewModel) {
  const { quoteId, manualApprovedAt, ...rawQuote } = input;
  if (!quoteId.trim()) throw new Error("RISK_QUOTE_ID_REQUIRED");
  if (manualApprovedAt != null && !Number.isFinite(Date.parse(manualApprovedAt))) {
    throw new Error("RISK_QUOTE_MANUAL_APPROVAL_TIME_INVALID");
  }
  return {
    quote: RiskQuoteSchema.parse(rawQuote),
    quoteId,
    manualApprovedAt: manualApprovedAt ?? null,
  };
}

function formatAtomic(value: string, locale: RiskPricingLocale) {
  return `${new Intl.NumberFormat(locale).format(BigInt(value))} atomic`;
}

function sameReasonCodes(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((code, index) => code === right[index]);
}

function requireMatchingAssessment(quote: RiskQuote, assessment: RiskAssessment) {
  if (
    quote.riskScore !== assessment.riskScore
    || quote.riskTier !== assessment.riskTier
    || quote.depositRateBps !== assessment.depositRateBps
    || quote.manualReviewRequired !== assessment.manualReviewRequired
    || !sameReasonCodes(quote.reasonCodes, assessment.reasonCodes)
  ) {
    throw new Error("RISK_QUOTE_ASSESSMENT_MISMATCH");
  }
}

export function presentRiskQuote(
  input: RiskQuoteViewModel,
  rawAssessment: RiskAssessment,
  locale: RiskPricingLocale,
  now = new Date().toISOString(),
) {
  const { quote, quoteId, manualApprovedAt } = parseQuoteViewModel(input);
  const assessment = RiskAssessmentSchema.parse(rawAssessment);
  requireMatchingAssessment(quote, assessment);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("RISK_QUOTE_PRESENTATION_TIME_INVALID");

  const expired = Date.parse(quote.expiresAt) <= nowMs;
  const manualApprovalMissing = quote.manualReviewRequired && manualApprovedAt === null;
  const status: RiskQuoteStatus = expired
    ? "expired"
    : manualApprovalMissing
        ? "manual_review"
        : quote.phase === "preliminary"
          ? "preliminary"
          : "ready";
  const confirmable = !expired && !manualApprovalMissing;
  const fundingReady = status === "ready";

  return {
    quoteId,
    taskFingerprint: quote.taskFingerprint,
    riskTier: quote.riskTier,
    riskScore: quote.riskScore,
    depositRate: `${(quote.depositRateBps / 100).toFixed(2)}%`,
    serviceFeeRate: `${(quote.serviceFeeBps / 100).toFixed(2)}%`,
    phase: quote.phase.toUpperCase(),
    policyVersion: quote.policyVersion,
    expiresAt: quote.expiresAt,
    expired,
    manualReviewRequired: quote.manualReviewRequired,
    manualApproved: manualApprovedAt !== null,
    status,
    confirmable,
    fundingReady,
    ready: fundingReady,
    yieldMode: "SIMULATION_ONLY" as const,
    reasonCodes: [...quote.reasonCodes],
    factors: factorOrder.map((key) => ({
      key,
      label: factorLabels[locale][key],
      score: assessment.factors[key],
    })),
    money: {
      P: formatAtomic(quote.P, locale),
      A: formatAtomic(quote.A, locale),
      B: formatAtomic(quote.B, locale),
      publisherTotal: formatAtomic(quote.publisherTotal, locale),
      agentTeamDeposit: formatAtomic(quote.agentTeamDeposit, locale),
    },
    agentAllocations: quote.agentAllocations.map(({ agentId, amountAtomic }) => ({
      agentId,
      amount: formatAtomic(amountAtomic, locale),
    })),
  };
}

export function createQuoteConfirmationIntent(input: RiskQuoteViewModel): QuoteConfirmationIntent {
  const { quote, quoteId } = parseQuoteViewModel(input);
  return { quoteId, taskFingerprint: quote.taskFingerprint };
}

export function presentReputationV2(input: ReputationSnapshot, locale: RiskPricingLocale) {
  const snapshot = ReputationSnapshotSchema.parse(input);
  return {
    score: snapshot.score.toFixed(1),
    sampleCount: snapshot.sampleCount,
    confidence: snapshot.confidence,
    confidencePercent: `${Math.round(snapshot.confidenceValue * 100)}%`,
    dimensions: (Object.keys(snapshot.dimensions) as Array<keyof typeof snapshot.dimensions>).map((key) => ({
      key,
      label: reputationLabels[locale][key],
      score: snapshot.dimensions[key],
    })),
    windowDays: snapshot.windowDays,
    maxEvents: snapshot.maxEvents,
    halfLifeDays: snapshot.halfLifeDays,
    calculatedAt: snapshot.calculatedAt,
    formulaVersion: snapshot.formulaVersion,
  };
}
