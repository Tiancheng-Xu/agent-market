import {
  AgentDepositAllocationSchema,
  AgentDepositNodeSchema,
  AtomicAmountSchema,
  RiskAssessmentSchema,
  RiskAssessorResultSchema,
  RiskQuoteSchema,
  RiskScoreSchema,
  type AgentDepositAllocation,
  type AgentDepositNode,
  type RiskAssessment,
  type RiskAssessorResult,
  type RiskQuote,
  type RiskQuotePhase,
  type RiskTier,
} from "@agent-market/shared-contracts";

const RISK_WEIGHTS = {
  complexity: 20,
  acceptanceAmbiguity: 15,
  externalDependency: 10,
  dataSensitivity: 15,
  financialRisk: 15,
  irreversibility: 10,
  deadlineRisk: 5,
  agentUncertainty: 10,
} as const;

export interface RiskPolicyDecision {
  riskTier: RiskTier;
  depositRateBps: number;
  manualReviewRequired: boolean;
}

export function riskPolicyForScore(rawRiskScore: number): RiskPolicyDecision {
  const riskScore = RiskScoreSchema.parse(rawRiskScore);
  if (riskScore <= 20) return { riskTier: "R1", depositRateBps: 500, manualReviewRequired: false };
  if (riskScore <= 40) return { riskTier: "R2", depositRateBps: 1_000, manualReviewRequired: false };
  if (riskScore <= 60) return { riskTier: "R3", depositRateBps: 1_500, manualReviewRequired: false };
  if (riskScore <= 80) return { riskTier: "R4", depositRateBps: 2_500, manualReviewRequired: false };
  return { riskTier: "R5", depositRateBps: 4_000, manualReviewRequired: true };
}

export function assessRisk(rawResult: RiskAssessorResult): RiskAssessment {
  const result = RiskAssessorResultSchema.parse(rawResult);
  const weightedTotal = Object.entries(RISK_WEIGHTS).reduce(
    (total, [factor, weight]) => total + result.factors[factor as keyof typeof RISK_WEIGHTS] * weight,
    0,
  );
  const riskScore = Math.round(weightedTotal / 100);
  return RiskAssessmentSchema.parse({
    ...result,
    riskScore,
    ...riskPolicyForScore(riskScore),
  });
}

const ceilBps = (amount: bigint, rateBps: number): bigint => {
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new Error("RISK_RATE_BPS_INVALID");
  }
  const numerator = amount * BigInt(rateBps);
  return (numerator + 9_999n) / 10_000n;
};

interface WeightedAgent {
  agentId: string;
  weight: bigint;
}

export function allocateAgentTeamDeposit(
  rawAgentTeamDeposit: string,
  rawNodes: readonly AgentDepositNode[],
): AgentDepositAllocation[] {
  const agentTeamDeposit = BigInt(AtomicAmountSchema.parse(rawAgentTeamDeposit));
  const nodes = rawNodes.map((node) => AgentDepositNodeSchema.parse(node));
  if (nodes.length === 0) throw new Error("RISK_AGENT_NODES_REQUIRED");

  const aggregated = new Map<string, bigint>();
  for (const node of nodes) {
    const weight = BigInt(node.shareBps)
      * BigInt(node.nodeRiskMultiplierBps)
      * BigInt(node.reputationRiskMultiplierBps);
    aggregated.set(node.agentId, (aggregated.get(node.agentId) ?? 0n) + weight);
  }

  const weightedAgents: WeightedAgent[] = [...aggregated.entries()].map(([agentId, weight]) => ({ agentId, weight }));
  const totalWeight = weightedAgents.reduce((total, agent) => total + agent.weight, 0n);
  if (totalWeight <= 0n) throw new Error("RISK_AGENT_WEIGHT_REQUIRED");

  const provisional = weightedAgents.map((agent) => {
    const numerator = agentTeamDeposit * agent.weight;
    return {
      agentId: agent.agentId,
      amount: numerator / totalWeight,
      remainder: numerator % totalWeight,
    };
  });
  const allocatedBase = provisional.reduce((total, agent) => total + agent.amount, 0n);
  const remainderUnits = Number(agentTeamDeposit - allocatedBase);
  const remainderOrder = [...provisional].sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return left.agentId.localeCompare(right.agentId);
  });
  for (let index = 0; index < remainderUnits; index += 1) {
    remainderOrder[index]!.amount += 1n;
  }

  return provisional
    .sort((left, right) => left.agentId.localeCompare(right.agentId))
    .map(({ agentId, amount }) => AgentDepositAllocationSchema.parse({ agentId, amountAtomic: amount.toString() }));
}

export interface CreateRiskQuoteInput {
  phase: RiskQuotePhase;
  policyVersion: string;
  taskFingerprint: string;
  budgetAtomic: string;
  serviceFeeBps: number;
  assessment: RiskAssessment;
  expiresAt: string;
  agentNodes?: readonly AgentDepositNode[];
}

export function createRiskQuote(input: CreateRiskQuoteInput): RiskQuote {
  const assessment = RiskAssessmentSchema.parse(input.assessment);
  const P = BigInt(AtomicAmountSchema.parse(input.budgetAtomic));
  if (P <= 0n) throw new Error("RISK_BUDGET_REQUIRED");

  const A = ceilBps(P, assessment.depositRateBps);
  const B = ceilBps(P, input.serviceFeeBps);
  const nodes = input.agentNodes ?? [];
  if (input.phase === "preliminary" && nodes.length > 0) {
    throw new Error("RISK_PRELIMINARY_ALLOCATION_FORBIDDEN");
  }
  if (input.phase === "final" && nodes.length === 0) {
    throw new Error("RISK_FINAL_ALLOCATION_REQUIRED");
  }

  return RiskQuoteSchema.parse({
    phase: input.phase,
    policyVersion: input.policyVersion,
    taskFingerprint: input.taskFingerprint,
    riskScore: assessment.riskScore,
    riskTier: assessment.riskTier,
    depositRateBps: assessment.depositRateBps,
    serviceFeeBps: input.serviceFeeBps,
    manualReviewRequired: assessment.manualReviewRequired,
    reasonCodes: assessment.reasonCodes,
    P: P.toString(),
    A: A.toString(),
    B: B.toString(),
    publisherTotal: (P + A + B).toString(),
    agentTeamDeposit: A.toString(),
    agentAllocations: input.phase === "final" ? allocateAgentTeamDeposit(A.toString(), nodes) : [],
    expiresAt: input.expiresAt,
  });
}
