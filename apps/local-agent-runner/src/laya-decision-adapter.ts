import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";

import {
  AgentMatchDecisionV1Schema,
  AgentQualityDecisionV1Schema,
  DisputeRouteDecisionV1Schema,
  JevThresholdPolicyV1Schema,
  type AgentMatchDecisionV1,
  type AgentQualityDecisionV1,
  type DisputeRouteDecisionV1,
  type JevDecisionType,
  type JevFallbackReason,
  type JevThresholdPolicyV1,
} from "@agent-market/shared-contracts";
import { z } from "zod";

import {
  probabilityMargin,
  validateChoiceAnswer,
  validateScoreAnswer,
  type SystemOneDecisionFallback,
  type SystemOneDecisionObserved,
  type SystemOneDecisionProvider,
} from "./system-one-decision-provider";

const ChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string().min(1).max(128),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});
const ScoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number().min(0).max(4),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
  legend: z.record(z.string(), z.string()).optional(),
});

export type LayaSession = {
  systemOne(state: unknown, questions: Record<string, unknown>): Promise<{
    answers: Record<string, unknown>;
    usage?: { input_tokens?: number };
  }>;
  close(): Promise<void>;
};

export type LayaDecisionAdapterConfig = {
  enabled: boolean;
  modelDir: string;
  revision: string;
  hashes: { "laya.onnx": string; "laya.onnx.data": string };
  policy: JevThresholdPolicyV1;
  /** Set only when this adapter is consumed as a non-authoritative shadow observation. */
  allowUncalibratedShadowObservation?: boolean;
  timeoutMs: number;
  loadSession?: (options: { modelDir: string; executionProviders: ["cpu"] }) => Promise<LayaSession>;
};

export type LayaReadiness =
  | { status: "disabled" | "idle" | "loading" | "ready" | "closing" | "closed" }
  | { status: "fallback"; reason: JevFallbackReason };

export type LayaDecisionAdapter = SystemOneDecisionProvider & {
  provider: "laya";
  readiness(): LayaReadiness;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
};

export function createLayaDecisionAdapter(config: LayaDecisionAdapterConfig): LayaDecisionAdapter {
  const policy = JevThresholdPolicyV1Schema.parse(config.policy);
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 10_000) {
    throw new Error("Laya timeout must be an integer from 100 to 10000 milliseconds");
  }
  const loadSession = config.loadSession ?? defaultLoadSession;
  let session: LayaSession | undefined;
  let sessionPromise: Promise<LayaSession> | undefined;
  let readiness: LayaReadiness = { status: config.enabled ? "idle" : "disabled" };
  let closed = false;
  let loadGeneration = 0;
  let closing: Promise<void> | undefined;
  let sessionClosing: Promise<void> | undefined;
  const activeInferences = new Set<Promise<void>>();

  async function waitForIdle(): Promise<void> {
    while (activeInferences.size > 0) await Promise.all([...activeInferences]);
  }

  const preflight = (decisionType: JevDecisionType, decisionId: string): SystemOneDecisionFallback | undefined => {
    if (!config.enabled) return fallback(decisionType, decisionId, "disabled");
    if (closed) return fallback(decisionType, decisionId, "server_error");
    if (policy.mode === "shadow" && !policy.calibrated && config.allowUncalibratedShadowObservation !== true) {
      return fallback(decisionType, decisionId, "uncalibrated");
    }
    return undefined;
  };

  async function getSession(): Promise<LayaSession> {
    if (session) return session;
    if (sessionPromise === undefined) {
      readiness = { status: "loading" };
      const generation = ++loadGeneration;
      sessionPromise = (async () => {
        await verifyModelAssets(config.modelDir, config.hashes);
        if (closed || generation !== loadGeneration) throw new LayaClosedError();
        const loaded = await loadSession({ modelDir: config.modelDir, executionProviders: ["cpu"] });
        if (closed || generation !== loadGeneration) {
          if (closed) {
            session = loaded;
            try {
              await closeLoadedSession();
            } catch {
              // closeLoadedSession restores the session and exposes the failure in readiness.
            }
          } else {
            await Promise.resolve().then(() => loaded.close());
          }
          throw new LayaClosedError();
        }
        session = loaded;
        readiness = { status: "ready" };
        return loaded;
      })().catch((error) => {
        if (!closed && generation === loadGeneration) {
          const reason: JevFallbackReason = error instanceof LayaAssetError ? "invalid_response" : "server_error";
          readiness = { status: "fallback", reason };
        }
        throw error;
      }).finally(() => {
        if (session === undefined && generation === loadGeneration) sessionPromise = undefined;
        if (closed && session === undefined && sessionClosing === undefined && activeInferences.size === 0) {
          readiness = { status: "closed" };
        }
      });
    }
    return withTimeout(sessionPromise, config.timeoutMs);
  }

  async function invoke(
    decisionType: JevDecisionType,
    decisionId: string,
    state: unknown,
    questions: Record<string, unknown>,
  ): Promise<{ status: "ok"; answers: Record<string, unknown>; usage?: { input_tokens?: number }; latencyMs: number } | SystemOneDecisionFallback> {
    let active: LayaSession;
    try {
      active = await getSession();
    } catch (error) {
      return fallback(decisionType, decisionId, error instanceof LayaAssetError
        ? "invalid_response"
        : error instanceof LayaTimeoutError
          ? "timeout"
          : "server_error");
    }
    if (closed) return fallback(decisionType, decisionId, "server_error");
    const startedAt = Date.now();
    let operation: Promise<{ answers: Record<string, unknown>; usage?: { input_tokens?: number } }>;
    try {
      operation = Promise.resolve(active.systemOne(state, questions));
    } catch (error) {
      operation = Promise.reject(error);
    }
    const settled = operation.then(() => undefined, () => undefined);
    activeInferences.add(settled);
    void settled.then(() => {
      activeInferences.delete(settled);
      if (closed && activeInferences.size === 0) void closeLoadedSession().catch(() => undefined);
    });
    try {
      const result = await withTimeout(operation, config.timeoutMs);
      return { status: "ok", ...result, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return fallback(decisionType, decisionId, error instanceof LayaTimeoutError ? "timeout" : "server_error");
    }
  }

  return {
    provider: "laya",
    readiness: () => readiness,
    waitForIdle,
    async match(input: AgentMatchDecisionV1) {
      const decision = AgentMatchDecisionV1Schema.parse(input);
      const unavailable = preflight(decision.decisionType, decision.decisionId);
      if (unavailable) return unavailable;
      if (decision.candidates.length === 0) return fallback(decision.decisionType, decision.decisionId, "out_of_pool");
      const criteria = Object.fromEntries([
        ...decision.candidates.map((candidate, index) => [
          candidate.candidateRef,
          `Eligible candidate ${index + 1} described only by the supplied bucketed state`,
        ]),
        ["abstain", "No supplied candidate is a clear fit"],
      ]);
      const response = await invoke(decision.decisionType, decision.decisionId, decision, {
        selection: {
          type: "choice",
          instructions: "Select the best eligible candidate reference, or abstain",
          criteria,
        },
      });
      if (response.status === "fallback") return response;
      const answer = ChoiceAnswerSchema.safeParse(response.answers.selection);
      if (!answer.success) return fallback(decision.decisionType, decision.decisionId, "invalid_response");
      const allowed = new Set([...decision.candidates.map((candidate) => candidate.candidateRef), "abstain"]);
      if (!allowed.has(answer.data.choice)) return fallback(decision.decisionType, decision.decisionId, "out_of_pool");
      if (!validateChoiceAnswer(answer.data.probabilities, allowed, answer.data.choice)) {
        return fallback(decision.decisionType, decision.decisionId, "invalid_response");
      }
      if (answer.data.choice === "abstain") return fallback(decision.decisionType, decision.decisionId, "uncalibrated");
      if (!passesThreshold(policy, "match", answer.data)) return fallback(decision.decisionType, decision.decisionId, "below_threshold");
      return observed(decision, answer.data, response, config.revision);
    },
    async scoreQuality(input: AgentQualityDecisionV1) {
      const decision = AgentQualityDecisionV1Schema.parse(input);
      const unavailable = preflight(decision.decisionType, decision.decisionId);
      if (unavailable) return unavailable;
      const response = await invoke(decision.decisionType, decision.decisionId, decision, {
        quality: {
          type: "score",
          instructions: "Rate the task result quality using only the supplied outcome buckets",
          criteria: ["unusable", "poor", "mixed", "good", "excellent"],
        },
      });
      if (response.status === "fallback") return response;
      const answer = ScoreAnswerSchema.safeParse(response.answers.quality);
      if (!answer.success || !validateScoreAnswer(answer.data.probabilities, answer.data.score)) {
        return fallback(decision.decisionType, decision.decisionId, "invalid_response");
      }
      if (!passesThreshold(policy, "quality", answer.data)) return fallback(decision.decisionType, decision.decisionId, "below_threshold");
      return observed(decision, answer.data, response, config.revision);
    },
    async routeDispute(input: DisputeRouteDecisionV1) {
      const decision = DisputeRouteDecisionV1Schema.parse(input);
      const unavailable = preflight(decision.decisionType, decision.decisionId);
      if (unavailable) return unavailable;
      const criteria = Object.fromEntries([
        ...decision.permittedRoutes.map((route) => [route, `Host-permitted ${route} workflow route`]),
        ["abstain", "The supplied evidence is insufficient to recommend a route"],
      ]);
      const response = await invoke(decision.decisionType, decision.decisionId, decision, {
        route: {
          type: "choice",
          instructions: "Recommend one host-permitted AI workflow route, or abstain",
          criteria,
        },
      });
      if (response.status === "fallback") return response;
      const answer = ChoiceAnswerSchema.safeParse(response.answers.route);
      if (!answer.success) return fallback(decision.decisionType, decision.decisionId, "invalid_response");
      const allowed = new Set<string>([...decision.permittedRoutes, "abstain"]);
      if (!allowed.has(answer.data.choice)) return fallback(decision.decisionType, decision.decisionId, "out_of_pool");
      if (!validateChoiceAnswer(answer.data.probabilities, allowed, answer.data.choice)) {
        return fallback(decision.decisionType, decision.decisionId, "invalid_response");
      }
      if (answer.data.choice === "abstain") return fallback(decision.decisionType, decision.decisionId, "uncalibrated");
      if (!passesThreshold(policy, "dispute", answer.data)) return fallback(decision.decisionType, decision.decisionId, "below_threshold");
      return observed(decision, answer.data, response, config.revision);
    },
    close() {
      if (closing) return closing;
      closing = closeSession().finally(() => { closing = undefined; });
      return closing;
    },
  };

  async function closeSession(): Promise<void> {
    if (!closed) {
      closed = true;
      loadGeneration += 1;
    }
    const deadline = Date.now() + config.timeoutMs;
    readiness = activeInferences.size > 0
      || session !== undefined
      || sessionClosing !== undefined
      || (session === undefined && sessionPromise !== undefined)
      ? { status: "closing" }
      : { status: "closed" };
    try {
      await withTimeout(waitForIdle(), Math.max(1, deadline - Date.now()));
    } catch (error) {
      if (!(error instanceof LayaTimeoutError)) throw error;
      readiness = { status: "closing" };
      void waitForIdle().then(closeLoadedSession).catch(() => undefined);
      return;
    }
    try {
      await withTimeout(closeLoadedSession(), Math.max(1, deadline - Date.now()));
    } catch (error) {
      if (!(error instanceof LayaTimeoutError)) throw error;
      readiness = { status: "closing" };
      void sessionClosing?.catch(() => undefined);
    }
  }

  function closeLoadedSession(): Promise<void> {
    if (sessionClosing) return sessionClosing;
    const loaded = session;
    session = undefined;
    if (loaded === undefined) {
      if (sessionPromise === undefined) readiness = { status: "closed" };
      else readiness = { status: "closing" };
      return Promise.resolve();
    }
    readiness = { status: "closing" };
    sessionClosing = Promise.resolve().then(() => loaded.close()).then(
      () => { readiness = { status: "closed" }; },
      (error: unknown) => {
        session = loaded;
        sessionClosing = undefined;
        readiness = { status: "fallback", reason: "server_error" };
        throw error;
      },
    );
    return sessionClosing;
  }
}

class LayaClosedError extends Error {}

type ParsedDecision = AgentMatchDecisionV1 | AgentQualityDecisionV1 | DisputeRouteDecisionV1;
type ParsedAnswer = z.infer<typeof ChoiceAnswerSchema> | z.infer<typeof ScoreAnswerSchema>;

function observed(
  decision: ParsedDecision,
  answer: ParsedAnswer,
  response: { usage?: { input_tokens?: number }; latencyMs: number },
  revision: string,
): SystemOneDecisionObserved {
  return {
    status: "observed",
    provider: "laya",
    decisionType: decision.decisionType,
    decisionId: decision.decisionId,
    value: answer.type === "choice" ? answer.choice : answer.score,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
    margin: probabilityMargin(answer.probabilities),
    model: `laya@${revision}`,
    usage: { inputTokens: response.usage?.input_tokens ?? 0 },
    latencyMs: response.latencyMs,
  };
}

function fallback(decisionType: JevDecisionType, decisionId: string, reason: JevFallbackReason): SystemOneDecisionFallback {
  return { status: "fallback", provider: "laya", decisionType, decisionId, reason };
}

function passesThreshold(
  policy: JevThresholdPolicyV1,
  kind: "match" | "quality" | "dispute",
  answer: ParsedAnswer,
): boolean {
  if (policy.mode === "synthetic-only") return true;
  const threshold = policy[kind];
  return answer.confidence >= threshold.minConfidence && probabilityMargin(answer.probabilities) >= threshold.minMargin;
}

async function verifyModelAssets(
  modelDir: string,
  hashes: { "laya.onnx": string; "laya.onnx.data": string },
): Promise<void> {
  for (const file of ["laya.onnx", "laya.onnx.data"] as const) {
    let actual: string;
    try {
      actual = await hashFile(join(modelDir, file));
    } catch {
      throw new LayaAssetError(`Missing Laya asset: ${file}`);
    }
    if (actual !== hashes[file]) throw new LayaAssetError(`Invalid Laya asset hash: ${file}`);
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function defaultLoadSession(options: { modelDir: string; executionProviders: ["cpu"] }): Promise<LayaSession> {
  const { Laya } = await import("@receptron/laya");
  return Laya.load({ modelDir: options.modelDir, executionProviders: options.executionProviders });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LayaTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class LayaAssetError extends Error {}
class LayaTimeoutError extends Error {}
