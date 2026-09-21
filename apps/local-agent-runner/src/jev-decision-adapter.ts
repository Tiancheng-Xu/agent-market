import {
  AgentMatchDecisionV1Schema,
  AgentQualityDecisionV1Schema,
  DisputeRouteDecisionV1Schema,
  JevThresholdPolicyV1Schema,
  type AgentMatchDecisionV1,
  type AgentQualityDecisionV1,
  type DisputeRouteDecisionV1,
  type JevDecisionType,
  type JevDisputeRoute,
  type JevFallbackReason,
  type JevThresholdPolicyV1,
} from "@agent-market/shared-contracts";
import { z } from "zod";

const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_MS = 1_500;

const UsageSchema = z.strictObject({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});

const SystemOneResponseSchema = z.strictObject({
  model: z.string().min(1).max(80),
  answers: z.record(z.string(), z.unknown()),
  usage: UsageSchema,
});

const ChoiceAnswerSchema = z.strictObject({
  type: z.literal("choice"),
  choice: z.string().min(1).max(128),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});

const ScoreAnswerSchema = z.strictObject({
  type: z.literal("score"),
  score: z.number().int().min(0).max(4),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
  legend: z.record(z.string(), z.string()).optional(),
});

export type JevFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type JevShadowFallback = {
  status: "fallback";
  decisionType: JevDecisionType;
  decisionId: string;
  reason: JevFallbackReason;
};

export type JevShadowObserved = {
  status: "observed";
  decisionType: JevDecisionType;
  decisionId: string;
  value: string | number;
  confidence: number;
  probabilities: Record<string, number>;
  margin: number;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
};

export type JevShadowResult = JevShadowFallback | JevShadowObserved;

export type JevDecisionAdapter = {
  match(decision: AgentMatchDecisionV1): Promise<JevShadowResult>;
  scoreQuality(decision: AgentQualityDecisionV1): Promise<JevShadowResult>;
  routeDispute(decision: DisputeRouteDecisionV1): Promise<JevShadowResult>;
};

export type JevDecisionAdapterConfig = {
  enabled: boolean;
  apiKey: string | undefined;
  policy: JevThresholdPolicyV1;
  timeoutMs?: number;
  model?: string;
  fetchImpl?: JevFetch;
};

export function createJevDecisionAdapter(config: JevDecisionAdapterConfig): JevDecisionAdapter {
  const policy = JevThresholdPolicyV1Schema.parse(config.policy);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    throw new Error("Jev timeout must be an integer from 100 to 10000 milliseconds");
  }
  const model = config.model ?? DEFAULT_MODEL;
  const fetchImpl = config.fetchImpl ?? fetch;

  const preflight = (decisionType: JevDecisionType, decisionId: string): JevShadowFallback | undefined => {
    if (!config.enabled) return fallback(decisionType, decisionId, "disabled");
    if (config.apiKey === undefined || config.apiKey.trim() === "") {
      return fallback(decisionType, decisionId, "missing_key");
    }
    if (policy.mode === "shadow" && !policy.calibrated) {
      return fallback(decisionType, decisionId, "uncalibrated");
    }
    return undefined;
  };

  return {
    async match(input) {
      const decision = AgentMatchDecisionV1Schema.parse(input);
      const unavailable = preflight(decision.decisionType, decision.decisionId);
      if (unavailable) return unavailable;
      if (decision.candidates.length === 0) {
        return fallback(decision.decisionType, decision.decisionId, "out_of_pool");
      }

      const criteria = Object.fromEntries([
        ...decision.candidates.map((candidate, index) => [
          candidate.candidateRef,
          `Eligible candidate ${index + 1} described only by the supplied bucketed state`,
        ]),
        ["abstain", "No supplied candidate is a clear fit"],
      ]);
      const response = await postSystemOne({
        apiKey: config.apiKey!,
        decision,
        fetchImpl,
        model,
        questionName: "selection",
        question: {
          type: "choice",
          instructions: "Select the best eligible candidate reference, or abstain",
          criteria,
        },
        timeoutMs,
      });
      if (response.status === "fallback") return fallback(decision.decisionType, decision.decisionId, response.reason);

      const answer = ChoiceAnswerSchema.safeParse(response.payload.answers["selection"]);
      if (!answer.success) return fallback(decision.decisionType, decision.decisionId, "invalid_response");
      const allowedChoices = new Set([...decision.candidates.map((candidate) => candidate.candidateRef), "abstain"]);
      if (!allowedChoices.has(answer.data.choice)) {
        return fallback(decision.decisionType, decision.decisionId, "out_of_pool");
      }
      if (!hasValidDistribution(answer.data.probabilities, allowedChoices, answer.data.choice)) {
        return fallback(decision.decisionType, decision.decisionId, "invalid_response");
      }
      if (answer.data.choice === "abstain") return fallback(decision.decisionType, decision.decisionId, "uncalibrated");
      if (!passesThreshold(policy, "match", answer.data)) {
        return fallback(decision.decisionType, decision.decisionId, "below_threshold");
      }
      return observed(decision, answer.data, response);
    },

    async scoreQuality(input) {
      const decision = AgentQualityDecisionV1Schema.parse(input);
      const unavailable = preflight(decision.decisionType, decision.decisionId);
      if (unavailable) return unavailable;

      const response = await postSystemOne({
        apiKey: config.apiKey!,
        decision,
        fetchImpl,
        model,
        questionName: "quality",
        question: {
          type: "score",
          instructions: "Rate the task result quality using only the supplied outcome buckets",
          criteria: ["unusable", "poor", "mixed", "good", "excellent"],
        },
        timeoutMs,
      });
      if (response.status === "fallback") return fallback(decision.decisionType, decision.decisionId, response.reason);

      const answer = ScoreAnswerSchema.safeParse(response.payload.answers["quality"]);
      if (!answer.success) return fallback(decision.decisionType, decision.decisionId, "invalid_response");
      if (!hasValidDistribution(answer.data.probabilities, new Set(["0", "1", "2", "3", "4"]), String(answer.data.score))) {
        return fallback(decision.decisionType, decision.decisionId, "invalid_response");
      }
      if (!passesThreshold(policy, "quality", answer.data)) {
        return fallback(decision.decisionType, decision.decisionId, "below_threshold");
      }
      return observed(decision, answer.data, response);
    },

    async routeDispute(input) {
      const decision = DisputeRouteDecisionV1Schema.parse(input);
      const unavailable = preflight(decision.decisionType, decision.decisionId);
      if (unavailable) return unavailable;

      const criteria = Object.fromEntries([
        ...decision.permittedRoutes.map((route) => [route, disputeRouteDescription(route)]),
        ["abstain", "The supplied evidence is insufficient to recommend a route"],
      ]);
      const response = await postSystemOne({
        apiKey: config.apiKey!,
        decision,
        fetchImpl,
        model,
        questionName: "route",
        question: {
          type: "choice",
          instructions: "Recommend one host-permitted AI workflow route, or abstain",
          criteria,
        },
        timeoutMs,
      });
      if (response.status === "fallback") return fallback(decision.decisionType, decision.decisionId, response.reason);

      const answer = ChoiceAnswerSchema.safeParse(response.payload.answers["route"]);
      if (!answer.success) return fallback(decision.decisionType, decision.decisionId, "invalid_response");
      const allowedChoices = new Set<string>([...decision.permittedRoutes, "abstain"]);
      if (!allowedChoices.has(answer.data.choice)) {
        return fallback(decision.decisionType, decision.decisionId, "out_of_pool");
      }
      if (!hasValidDistribution(answer.data.probabilities, allowedChoices, answer.data.choice)) {
        return fallback(decision.decisionType, decision.decisionId, "invalid_response");
      }
      if (answer.data.choice === "abstain") return fallback(decision.decisionType, decision.decisionId, "uncalibrated");
      if (!passesThreshold(policy, "dispute", answer.data)) {
        return fallback(decision.decisionType, decision.decisionId, "below_threshold");
      }
      return observed(decision, answer.data, response);
    },
  };
}

type ParsedDecision = AgentMatchDecisionV1 | AgentQualityDecisionV1 | DisputeRouteDecisionV1;
type ChoiceOrScoreAnswer = z.infer<typeof ChoiceAnswerSchema> | z.infer<typeof ScoreAnswerSchema>;
type SuccessfulSystemOneResponse = {
  status: "ok";
  payload: z.infer<typeof SystemOneResponseSchema>;
  latencyMs: number;
};

async function postSystemOne(options: {
  apiKey: string;
  decision: ParsedDecision;
  fetchImpl: JevFetch;
  model: string;
  questionName: string;
  question: Record<string, unknown>;
  timeoutMs: number;
}): Promise<SuccessfulSystemOneResponse | { status: "fallback"; reason: JevFallbackReason }> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await options.fetchImpl(SYSTEM_ONE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        state: JSON.stringify(options.decision),
        model: options.model,
        questions: { [options.questionName]: options.question },
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    return {
      status: "fallback",
      reason: isTimeoutError(error) ? "timeout" : "server_error",
    };
  }

  if (!response.ok) {
    return { status: "fallback", reason: statusReason(response.status) };
  }

  try {
    const payload = SystemOneResponseSchema.parse(await response.json());
    return { status: "ok", payload, latencyMs: Date.now() - startedAt };
  } catch {
    return { status: "fallback", reason: "invalid_response" };
  }
}

function observed(
  decision: ParsedDecision,
  answer: ChoiceOrScoreAnswer,
  response: SuccessfulSystemOneResponse,
): JevShadowObserved {
  const probabilities = answer.probabilities;
  return {
    status: "observed",
    decisionType: decision.decisionType,
    decisionId: decision.decisionId,
    value: answer.type === "choice" ? answer.choice : answer.score,
    confidence: answer.confidence,
    probabilities,
    margin: probabilityMargin(probabilities),
    model: response.payload.model,
    usage: {
      inputTokens: response.payload.usage.input_tokens,
      outputTokens: response.payload.usage.output_tokens,
    },
    latencyMs: response.latencyMs,
  };
}

function probabilityMargin(probabilities: Record<string, number>): number {
  const sorted = Object.values(probabilities).sort((left, right) => right - left);
  return Math.max(0, (sorted[0] ?? 0) - (sorted[1] ?? 0));
}

function hasValidDistribution(
  probabilities: Record<string, number>,
  allowedKeys: ReadonlySet<string>,
  selectedKey: string,
): boolean {
  const entries = Object.entries(probabilities);
  if (entries.length === 0 || entries.some(([key]) => !allowedKeys.has(key))) return false;
  const selected = probabilities[selectedKey];
  if (selected === undefined) return false;
  const sum = entries.reduce((total, [, probability]) => total + probability, 0);
  if (Math.abs(sum - 1) > 0.01) return false;
  const highest = Math.max(...entries.map(([, probability]) => probability));
  return selected >= highest;
}

function passesThreshold(
  policy: JevThresholdPolicyV1,
  kind: "match" | "quality" | "dispute",
  answer: ChoiceOrScoreAnswer,
): boolean {
  if (policy.mode === "synthetic-only") return true;
  const threshold = policy[kind];
  return answer.confidence >= threshold.minConfidence && probabilityMargin(answer.probabilities) >= threshold.minMargin;
}

function fallback(decisionType: JevDecisionType, decisionId: string, reason: JevFallbackReason): JevShadowFallback {
  return { status: "fallback", decisionType, decisionId, reason };
}

function statusReason(status: number): JevFallbackReason {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  return "server_error";
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

function disputeRouteDescription(route: JevDisputeRoute): string {
  const descriptions: Record<JevDisputeRoute, string> = {
    judge: "Ask the independent AI judge to evaluate the current result",
    red_team: "Request an adversarial AI review",
    repair: "Return the task to an AI repair step",
    ai_final_arbiter_review: "Request the independent AI final arbiter review",
  };
  return descriptions[route];
}
