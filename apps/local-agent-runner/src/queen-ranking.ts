import { createHash } from "node:crypto";

import type { AgentCandidate, TaskNodeType } from "@agent-market/shared-contracts";

const OLD_MODEL_DAYS = 7;
const HARD_QUALITY_FLOOR = 0.35;
const OLD_MODEL_QUALITY_FLOOR = 0.45;
const NEW_MODEL_QUALITY_FLOOR = 0.7;
const NEW_MODEL_BOOST = 40;
const INITIAL_AGENT_SCORE = 0.3;
const SCORE_WINDOW_EVENTS = 20;
const SCORE_WINDOW_DAYS = 90;
const SCORE_HALF_LIFE_DAYS = 30;
const MILLISECONDS_PER_DAY = 86_400_000;

export type RankAgentCandidatesInput = {
  nodeType: TaskNodeType;
  category?: string;
  requiredTags?: string[];
  requiredCapabilities: string[];
  callerScope?: "public" | "owner";
  now: Date;
  candidates: AgentCandidate[];
  selectionPolicy?: {
    taskId: string;
    matchingRound: number;
    policyVersion: string;
    disableColdStart?: boolean;
  };
};

export type RankedAgentCandidate = AgentCandidate & {
  effectiveQualityScore: number;
  rankingScore: number;
  rankingReasons: string[];
};

export type QueenSelectionAudit = {
  policyVersion: string;
  eligibleCount: number;
  historyCount: number;
  coldStartCount: number;
  selectedIds: string[];
  selectionReasons: Array<"history-rank" | "history-fallback" | "cold-start-exploration">;
  seedHash: string;
};

export function rankAgentCandidates(input: RankAgentCandidatesInput): RankedAgentCandidate[] {
  const ranked = input.candidates
    .filter((candidate) => isAgentEligible(candidate, input))
    .map((candidate) => scoreCandidate(candidate, input))
    .sort((left, right) => right.rankingScore - left.rankingScore || left.agentId.localeCompare(right.agentId));
  const seenModels = new Set<string>();
  return ranked.filter((candidate) => {
    const modelKey = candidate.modelTag.toLowerCase();
    if (seenModels.has(modelKey)) return false;
    seenModels.add(modelKey);
    return true;
  });
}

export function selectThreeFromFour(input: RankAgentCandidatesInput): RankedAgentCandidate[] {
  return selectThreeWithAudit(input).candidates;
}

export function selectThreeWithAudit(input: RankAgentCandidatesInput): {
  candidates: RankedAgentCandidate[];
  audit: QueenSelectionAudit;
} {
  const eligible = rankAgentCandidates(input);
  const policy = input.selectionPolicy ?? {
    taskId: `legacy:${input.nodeType}`,
    matchingRound: 0,
    policyVersion: "legacy-compatible-v1",
    disableColdStart: false,
  };
  const seedContract = `${policy.taskId}\u0000${policy.matchingRound}\u0000${policy.policyVersion}`;
  const seedHash = createHash("sha256").update(seedContract).digest("hex");
  const history = eligible.filter((candidate) => !isNewWithoutHistory(candidate));
  const coldStart = eligible.filter(isNewWithoutHistory);
  const selected = history.slice(0, policy.disableColdStart ? 3 : 2);
  const selectionReasons: QueenSelectionAudit["selectionReasons"] = selected.map(() => "history-rank");
  const seenModels = new Set(selected.map((candidate) => candidate.modelTag.toLowerCase()));

  if (!policy.disableColdStart && selected.length < 3) {
    for (const candidate of seededShuffle(coldStart, seedHash)) {
      if (selected.length === 3) break;
      const modelKey = candidate.modelTag.toLowerCase();
      if (seenModels.has(modelKey)) continue;
      selected.push(candidate);
      selectionReasons.push("cold-start-exploration");
      seenModels.add(modelKey);
    }
  }
  if (selected.length < 3) {
    for (const candidate of history) {
      if (selected.length === 3) break;
      const modelKey = candidate.modelTag.toLowerCase();
      if (seenModels.has(modelKey) || selected.some((item) => item.agentId === candidate.agentId)) continue;
      selected.push(candidate);
      selectionReasons.push("history-fallback");
      seenModels.add(modelKey);
    }
  }

  return {
    candidates: selected,
    audit: {
      policyVersion: policy.policyVersion,
      eligibleCount: eligible.length,
      historyCount: history.length,
      coldStartCount: coldStart.length,
      selectedIds: selected.map((candidate) => candidate.agentId),
      selectionReasons,
      seedHash,
    },
  };
}

function seededShuffle<T extends { agentId: string }>(values: readonly T[], seedHash: string): T[] {
  const result = [...values].sort((left, right) => Buffer.compare(
    Buffer.from(left.agentId, "utf8"),
    Buffer.from(right.agentId, "utf8"),
  ));
  let state = Number.parseInt(seedHash.slice(0, 8), 16) || 1;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    const other = Number((BigInt(state) * BigInt(index + 1)) >> 32n);
    [result[index], result[other]] = [result[other]!, result[index]!];
  }
  return result;
}

export function computeDecayedQualityScore(candidate: AgentCandidate, now: Date): number {
  if (candidate.scoreEvents === undefined) return candidate.qualityScore;
  if (candidate.scoreEvents.length === 0) return INITIAL_AGENT_SCORE;

  const earliest = now.getTime() - SCORE_WINDOW_DAYS * MILLISECONDS_PER_DAY;
  const events = candidate.scoreEvents
    .filter((event) => {
      const occurredAt = new Date(event.occurredAt).getTime();
      return Number.isFinite(occurredAt) && occurredAt >= earliest && occurredAt <= now.getTime();
    })
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, SCORE_WINDOW_EVENTS);
  if (events.length === 0) return INITIAL_AGENT_SCORE;

  let weightedScore = 0;
  let totalWeight = 0;
  for (const event of events) {
    const ageDays = (now.getTime() - new Date(event.occurredAt).getTime()) / MILLISECONDS_PER_DAY;
    const weight = Math.pow(0.5, ageDays / SCORE_HALF_LIFE_DAYS);
    weightedScore += event.score * weight;
    totalWeight += weight;
  }

  return totalWeight === 0 ? INITIAL_AGENT_SCORE : weightedScore / totalWeight;
}

export function isAgentEligible(candidate: AgentCandidate, input: RankAgentCandidatesInput): boolean {
  if (candidate.status === "offline") return false;
  if (candidate.selectableBy === "owner-only" && input.callerScope !== "owner") return false;
  if (!input.requiredCapabilities.every((capability) => includesNormalized(candidate.capabilities, capability))) return false;
  if (input.category !== undefined && !includesNormalized(candidate.categories ?? [], input.category)) return false;
  if (!(input.requiredTags ?? []).every((tag) => includesNormalized(candidate.tags, tag))) return false;

  const qualityScore = computeDecayedQualityScore(candidate, input.now);
  if (isNewWithoutHistory(candidate) && modelAgeDays(candidate, input.now) <= OLD_MODEL_DAYS) return true;
  if (qualityScore < HARD_QUALITY_FLOOR) return false;
  if (qualityScore < OLD_MODEL_QUALITY_FLOOR && modelAgeDays(candidate, input.now) > OLD_MODEL_DAYS) return false;
  return true;
}

function scoreCandidate(candidate: AgentCandidate, input: RankAgentCandidatesInput): RankedAgentCandidate {
  const availabilityScore = candidate.status === "online" ? 500 : 200;
  const costPenalty = candidate.costPer1kTokensUsd * 100_000;
  const latencyPenalty = (candidate.latencyMs ?? 1_000) / 10;
  const effectiveQualityScore = computeDecayedQualityScore(candidate, input.now);
  const qualityScore = effectiveQualityScore * 100;
  const protectionBoost = isProtectedNewModel(candidate, input.now) ? NEW_MODEL_BOOST : 0;
  const baselineExplorationBoost = isNewWithoutHistory(candidate) && modelAgeDays(candidate, input.now) <= OLD_MODEL_DAYS ? NEW_MODEL_BOOST : 0;
  const rankingScore = 10_000 - costPenalty + availabilityScore - latencyPenalty + qualityScore + protectionBoost + baselineExplorationBoost;
  const rankingReasons = [
    "capability-match",
    "model-pool-draw",
    ...(input.category === undefined ? [] : [`category:${input.category}`]),
    ...((input.requiredTags?.length ?? 0) === 0 ? [] : [`required-tags:${input.requiredTags!.join("|")}`]),
    `cost:${candidate.costPer1kTokensUsd}`,
    `status:${candidate.status}`,
    `quality:${effectiveQualityScore.toFixed(4)}`,
    ...(candidate.scoreEvents === undefined ? ["quality-source:legacy"] : [`quality-source:decayed-window-${Math.min(candidate.scoreEvents.length, SCORE_WINDOW_EVENTS)}`]),
    ...(candidate.tags.length > 0 ? [`tags:${candidate.tags.join("|")}`] : []),
    ...(candidate.license !== undefined ? [`license:${candidate.license}`] : []),
    ...(protectionBoost > 0 ? ["new-model-protection"] : []),
    ...(baselineExplorationBoost > 0 ? ["new-model-exploration"] : []),
  ];

  return { ...candidate, effectiveQualityScore, rankingScore, rankingReasons };
}

function isProtectedNewModel(candidate: AgentCandidate, now: Date): boolean {
  const qualityScore = computeDecayedQualityScore(candidate, now);
  return (qualityScore >= NEW_MODEL_QUALITY_FLOOR || isNewWithoutHistory(candidate)) && modelAgeDays(candidate, now) <= OLD_MODEL_DAYS;
}

function isNewWithoutHistory(candidate: AgentCandidate): boolean {
  return candidate.scoreEvents?.length === 0 || (candidate.scoreEvents === undefined && candidate.qualityScore === 0);
}

function modelAgeDays(candidate: AgentCandidate, now: Date): number {
  if (candidate.firstSeenAt === undefined) return Number.POSITIVE_INFINITY;
  const firstSeenAt = new Date(candidate.firstSeenAt);
  const ageMs = now.getTime() - firstSeenAt.getTime();
  return ageMs / MILLISECONDS_PER_DAY;
}

function includesNormalized(values: string[], expected: string): boolean {
  const normalized = expected.trim().toLowerCase();
  return values.some((value) => value.trim().toLowerCase() === normalized);
}
