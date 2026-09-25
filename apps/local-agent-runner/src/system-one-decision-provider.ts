import type {
  AgentMatchDecisionV1,
  AgentQualityDecisionV1,
  DisputeRouteDecisionV1,
  JevDecisionType,
  JevFallbackReason,
} from "@agent-market/shared-contracts";

export type SystemOneProviderName = "laya" | "jev";

export type SystemOneDecisionFallback = {
  status: "fallback";
  provider: SystemOneProviderName;
  decisionType: JevDecisionType;
  decisionId: string;
  reason: JevFallbackReason;
};

export type SystemOneDecisionObserved = {
  status: "observed";
  provider: SystemOneProviderName;
  decisionType: JevDecisionType;
  decisionId: string;
  value: string | number;
  confidence: number;
  probabilities: Record<string, number>;
  margin: number;
  model: string;
  usage: { inputTokens: number; outputTokens?: number };
  latencyMs: number;
};

export type SystemOneDecisionResult = SystemOneDecisionFallback | SystemOneDecisionObserved;

export type SystemOneDecisionProvider = {
  provider: SystemOneProviderName;
  match(decision: AgentMatchDecisionV1): Promise<SystemOneDecisionResult>;
  scoreQuality(decision: AgentQualityDecisionV1): Promise<SystemOneDecisionResult>;
  routeDispute(decision: DisputeRouteDecisionV1): Promise<SystemOneDecisionResult>;
  /** Waits for underlying work that may outlive a timeout returned to the coordinator. */
  waitForIdle?(): Promise<void>;
  close?(): Promise<void>;
};

export function probabilityMargin(probabilities: Record<string, number>): number {
  const sorted = Object.values(probabilities).sort((left, right) => right - left);
  return Math.max(0, (sorted[0] ?? 0) - (sorted[1] ?? 0));
}

export function validateChoiceAnswer(
  probabilities: Record<string, number>,
  allowedKeys: ReadonlySet<string>,
  selectedKey: string,
): boolean {
  const entries = Object.entries(probabilities);
  if (entries.length === 0 || entries.some(([key, value]) => !allowedKeys.has(key) || !isProbability(value))) {
    return false;
  }
  const selected = probabilities[selectedKey];
  if (selected === undefined) return false;
  if (!sumsToOne(entries)) return false;
  return selected >= Math.max(...entries.map(([, probability]) => probability));
}

export function validateScoreAnswer(probabilities: Record<string, number>, score: number): boolean {
  if (!Number.isFinite(score) || score < 0 || score > 4) return false;
  const expected = new Set(["0", "1", "2", "3", "4"]);
  const entries = Object.entries(probabilities);
  if (entries.length !== expected.size) return false;
  if (entries.some(([key, value]) => !expected.has(key) || !isProbability(value))) return false;
  if (!sumsToOne(entries)) return false;

  const probabilityTotal = entries.reduce((sum, [, probability]) => sum + probability, 0);
  const expectedScore = entries.reduce((sum, [level, probability]) => sum + Number(level) * probability, 0)
    / probabilityTotal;
  return Math.abs(score - expectedScore) <= 0.01;
}

function sumsToOne(entries: Array<[string, number]>): boolean {
  const roundingTolerance = Number.EPSILON * entries.length;
  return Math.abs(entries.reduce((sum, [, value]) => sum + value, 0) - 1) <= 0.01 + roundingTolerance;
}

function isProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
