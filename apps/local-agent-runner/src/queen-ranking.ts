import type { AgentCandidate, TaskNodeType } from "@agent-market/shared-contracts";

const OLD_MODEL_DAYS = 7;
const HARD_QUALITY_FLOOR = 0.35;
const OLD_MODEL_QUALITY_FLOOR = 0.45;
const NEW_MODEL_QUALITY_FLOOR = 0.7;
const NEW_MODEL_BOOST = 40;

export type RankAgentCandidatesInput = {
  nodeType: TaskNodeType;
  requiredCapabilities: string[];
  now: Date;
  candidates: AgentCandidate[];
};

export type RankedAgentCandidate = AgentCandidate & {
  rankingScore: number;
  rankingReasons: string[];
};

export function rankAgentCandidates(input: RankAgentCandidatesInput): RankedAgentCandidate[] {
  return input.candidates
    .filter((candidate) => isAgentEligible(candidate, input))
    .map((candidate) => scoreCandidate(candidate, input))
    .sort((left, right) => right.rankingScore - left.rankingScore || left.agentId.localeCompare(right.agentId));
}

export function isAgentEligible(
  candidate: AgentCandidate,
  input: Pick<RankAgentCandidatesInput, "requiredCapabilities" | "now">,
): boolean {
  if (candidate.status === "offline") return false;
  if (!input.requiredCapabilities.every((capability) => candidate.capabilities.includes(capability))) return false;
  if (candidate.qualityScore < HARD_QUALITY_FLOOR) return false;
  if (candidate.qualityScore < OLD_MODEL_QUALITY_FLOOR && modelAgeDays(candidate, input.now) > OLD_MODEL_DAYS) return false;
  return true;
}

function scoreCandidate(candidate: AgentCandidate, input: RankAgentCandidatesInput): RankedAgentCandidate {
  const availabilityScore = candidate.status === "online" ? 500 : 200;
  const costPenalty = candidate.costPer1kTokensUsd * 100_000;
  const latencyPenalty = (candidate.latencyMs ?? 1_000) / 10;
  const qualityScore = candidate.qualityScore * 100;
  const protectionBoost = isProtectedNewModel(candidate, input.now) ? NEW_MODEL_BOOST : 0;
  const rankingScore = 10_000 - costPenalty + availabilityScore - latencyPenalty + qualityScore + protectionBoost;
  const rankingReasons = [
    "capability-match",
    `cost:${candidate.costPer1kTokensUsd}`,
    `status:${candidate.status}`,
    `quality:${candidate.qualityScore}`,
    ...(protectionBoost > 0 ? ["new-model-protection"] : []),
  ];

  return { ...candidate, rankingScore, rankingReasons };
}

function isProtectedNewModel(candidate: AgentCandidate, now: Date): boolean {
  return candidate.qualityScore >= NEW_MODEL_QUALITY_FLOOR && modelAgeDays(candidate, now) <= OLD_MODEL_DAYS;
}

function modelAgeDays(candidate: AgentCandidate, now: Date): number {
  if (candidate.firstSeenAt === undefined) return Number.POSITIVE_INFINITY;
  const firstSeenAt = new Date(candidate.firstSeenAt);
  const ageMs = now.getTime() - firstSeenAt.getTime();
  return ageMs / 86_400_000;
}
