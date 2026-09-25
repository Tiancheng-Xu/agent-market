import { createHash } from "node:crypto";

import type {
  AgentMatchDecisionV1,
  AgentQualityDecisionV1,
  DisputeRouteDecisionV1,
  JevDecisionType,
  JevFallbackReason,
} from "@agent-market/shared-contracts";

import type {
  SystemOneDecisionProvider,
  SystemOneDecisionResult,
  SystemOneProviderName,
} from "./system-one-decision-provider";

export type SystemOneShadowObservation = {
  provider: SystemOneProviderName;
  status: "observed" | "fallback" | "skipped";
  model?: string;
  resultHash?: string;
  confidence?: number;
  margin?: number;
  latencyMs?: number;
  fallbackReason?: JevFallbackReason;
  skipReason?: "capacity_limited";
};

export type SystemOneShadowEvidence = {
  schemaVersion: 1;
  decisionType: JevDecisionType;
  decisionId: string;
  baselineResultHash: string;
  observations: SystemOneShadowObservation[];
  agreement: "all" | "partial" | "none" | "insufficient";
};

export type SystemOneShadowDiagnostic =
  | { type: "provider_error"; provider: SystemOneProviderName; message: string }
  | { type: "observation_dropped"; reason: "pending_capacity" }
  | { type: "sink_error"; message: string };

export type SystemOneShadowCoordinator = {
  observeMatch<T>(baseline: T, decision: AgentMatchDecisionV1): Promise<T>;
  observeQuality<T>(baseline: T, decision: AgentQualityDecisionV1): Promise<T>;
  observeDispute<T>(baseline: T, decision: DisputeRouteDecisionV1): Promise<T>;
  flush(): Promise<void>;
};

export function createSystemOneShadowCoordinator(options: {
  providers: readonly SystemOneDecisionProvider[];
  sink: (evidence: SystemOneShadowEvidence) => Promise<void>;
  providerTimeoutMs?: number;
  sinkTimeoutMs?: number;
  maxConcurrentPerProvider?: number;
  maxPendingObservations?: number;
  onDiagnostic?: (diagnostic: SystemOneShadowDiagnostic) => void;
}): SystemOneShadowCoordinator {
  const maxConcurrentPerProvider = options.maxConcurrentPerProvider ?? 1;
  const maxPendingObservations = options.maxPendingObservations ?? 128;
  if (!Number.isInteger(maxConcurrentPerProvider) || maxConcurrentPerProvider < 1 || maxConcurrentPerProvider > 16) {
    throw new Error("maxConcurrentPerProvider must be an integer from 1 to 16");
  }
  if (!Number.isInteger(maxPendingObservations) || maxPendingObservations < 1 || maxPendingObservations > 1_024) {
    throw new Error("maxPendingObservations must be an integer from 1 to 1024");
  }
  const providerNames = options.providers.map((provider) => provider.provider);
  if (new Set(providerNames).size !== providerNames.length) {
    throw new Error("System-One shadow providers must have unique names");
  }

  const pending = new Set<Promise<void>>();
  const activeByProvider = new Map<SystemOneProviderName, number>(providerNames.map((name) => [name, 0]));

  const record = async (
    baseline: unknown,
    decision: AgentMatchDecisionV1 | AgentQualityDecisionV1 | DisputeRouteDecisionV1,
    invoke: (provider: SystemOneDecisionProvider) => Promise<SystemOneDecisionResult>,
  ): Promise<void> => {
    const providerTimeoutMs = options.providerTimeoutMs ?? 10_000;
    const sinkTimeoutMs = options.sinkTimeoutMs ?? 500;
    const settled = await Promise.allSettled(options.providers.map(async (provider) => {
      const active = activeByProvider.get(provider.provider) ?? 0;
      if (active >= maxConcurrentPerProvider) {
        return { status: "skipped", provider: provider.provider, reason: "capacity_limited" } as const;
      }

      activeByProvider.set(provider.provider, active + 1);
      let invocation: Promise<SystemOneDecisionResult>;
      try {
        invocation = Promise.resolve(invoke(provider));
      } catch (error) {
        invocation = Promise.reject(error);
      }
      const trackedInvocation = invocation.finally(async () => {
        try {
          await provider.waitForIdle?.();
        } finally {
          activeByProvider.set(provider.provider, Math.max(0, (activeByProvider.get(provider.provider) ?? 1) - 1));
        }
      });

      try {
        return await withDeadline(trackedInvocation, providerTimeoutMs);
      } catch (error) {
        if (error instanceof ShadowTimeoutError) {
          return {
            provider: provider.provider,
            status: "fallback" as const,
            decisionType: decision.decisionType,
            decisionId: decision.decisionId,
            reason: "timeout" as const,
          };
        }
        throw error;
      }
    }));
    const observations = settled.map((result, index): SystemOneShadowObservation => {
      const provider = options.providers[index]!.provider;
      if (result.status === "rejected") {
        options.onDiagnostic?.({ type: "provider_error", provider, message: safeMessage(result.reason) });
        return { provider, status: "fallback", fallbackReason: "server_error" };
      }
      return observationFrom(result.value);
    });
    const evidence: SystemOneShadowEvidence = {
      schemaVersion: 1,
      decisionType: decision.decisionType,
      decisionId: decision.decisionId,
      baselineResultHash: hashNormalized(baseline),
      observations,
      agreement: agreementFor(observations, options.providers.length),
    };
    try {
      await withDeadline(options.sink(evidence), sinkTimeoutMs);
    } catch (error) {
      options.onDiagnostic?.({ type: "sink_error", message: safeMessage(error) });
    }
  };

  const observe = <T>(
    baseline: T,
    decision: AgentMatchDecisionV1 | AgentQualityDecisionV1 | DisputeRouteDecisionV1,
    invoke: (provider: SystemOneDecisionProvider) => Promise<SystemOneDecisionResult>,
  ): Promise<T> => {
    if (options.providers.length === 0) return Promise.resolve(baseline);
    if (pending.size >= maxPendingObservations) {
      options.onDiagnostic?.({ type: "observation_dropped", reason: "pending_capacity" });
      return Promise.resolve(baseline);
    }
    const work = record(baseline, decision, invoke).catch(() => undefined);
    pending.add(work);
    void work.then(() => pending.delete(work));
    return Promise.resolve(baseline);
  };

  const flush = async (): Promise<void> => {
    while (pending.size > 0) await Promise.all([...pending]);
  };

  return {
    observeMatch: (baseline, decision) => observe(baseline, decision, (provider) => provider.match(decision)),
    observeQuality: (baseline, decision) => observe(baseline, decision, (provider) => provider.scoreQuality(decision)),
    observeDispute: (baseline, decision) => observe(baseline, decision, (provider) => provider.routeDispute(decision)),
    flush,
  };
}

class ShadowTimeoutError extends Error {}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ShadowTimeoutError("shadow timeout")), timeoutMs);
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

type SystemOneShadowProviderResult = SystemOneDecisionResult | {
  status: "skipped";
  provider: SystemOneProviderName;
  reason: "capacity_limited";
};

function observationFrom(result: SystemOneShadowProviderResult): SystemOneShadowObservation {
  if (result.status === "skipped") {
    return { provider: result.provider, status: "skipped", skipReason: result.reason };
  }
  if (result.status === "fallback") {
    return { provider: result.provider, status: "fallback", fallbackReason: result.reason };
  }
  return {
    provider: result.provider,
    status: "observed",
    model: result.model,
    resultHash: hashNormalized(result.value),
    confidence: result.confidence,
    margin: result.margin,
    latencyMs: result.latencyMs,
  };
}

function agreementFor(
  observations: readonly SystemOneShadowObservation[],
  providerCount: number,
): SystemOneShadowEvidence["agreement"] {
  const observed = observations.filter((item) => item.status === "observed" && item.resultHash !== undefined);
  if (observed.length < 2) return "insufficient";
  const unique = new Set(observed.map((item) => item.resultHash));
  if (unique.size > 1) return "none";
  return observed.length === providerCount ? "all" : "partial";
}

function hashNormalized(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}
