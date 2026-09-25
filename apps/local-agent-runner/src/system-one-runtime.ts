import { createHash } from "node:crypto";

import type { JevThresholdPolicyV1 } from "@agent-market/shared-contracts";

import type { SystemOneShadowConfig } from "./config";
import { createJevDecisionAdapter, type JevDecisionAdapter, type JevDecisionAdapterConfig } from "./jev-decision-adapter";
import { createLayaDecisionAdapter, type LayaDecisionAdapter, type LayaDecisionAdapterConfig } from "./laya-decision-adapter";
import type { SystemOneDecisionProvider, SystemOneDecisionResult } from "./system-one-decision-provider";
import { createSystemOneShadowCoordinator, type SystemOneShadowCoordinator, type SystemOneShadowEvidence } from "./system-one-shadow-coordinator";

export const SYSTEM_ONE_SHADOW_POLICY: JevThresholdPolicyV1 = {
  schemaVersion: 1,
  policyVersion: "system_one_dual_shadow_v1",
  mode: "shadow",
  calibrated: false,
  match: { minConfidence: 0.8, minMargin: 0.2 },
  quality: { minConfidence: 0.8, minMargin: 0.2 },
  dispute: { minConfidence: 0.9, minMargin: 0.3 },
};

export type SystemOneRuntimeReadiness = {
  provider: "laya" | "jev";
  status: "disabled" | "idle" | "loading" | "ready" | "fallback" | "closing" | "closed";
};

export type SystemOneRuntime = {
  coordinator: SystemOneShadowCoordinator | undefined;
  readiness(): SystemOneRuntimeReadiness[];
  close(): Promise<void>;
};

export type SystemOneRuntimeDependencies = {
  sink: (evidence: SystemOneShadowEvidence) => Promise<void>;
  createLaya?: (config: LayaDecisionAdapterConfig) => LayaDecisionAdapter;
  createJev?: (config: JevDecisionAdapterConfig) => JevDecisionAdapter;
};

export function createSystemOneRuntime(
  config: SystemOneShadowConfig,
  dependencies: SystemOneRuntimeDependencies,
): SystemOneRuntime {
  if (config.mode === "off") return disabledRuntime();

  const laya = (dependencies.createLaya ?? createLayaDecisionAdapter)({
    enabled: true,
    modelDir: config.laya.modelDir,
    revision: config.laya.revision,
    hashes: config.laya.hashes,
    timeoutMs: config.laya.timeoutMs,
    policy: SYSTEM_ONE_SHADOW_POLICY,
    allowUncalibratedShadowObservation: true,
  });
  const jevConfigured = config.jev.enabled && config.jev.apiKey !== undefined;
  const rawJev = jevConfigured && config.jev.sampleRate > 0 && config.jev.maxRequests > 0
    ? (dependencies.createJev ?? createJevDecisionAdapter)({
        enabled: true,
        apiKey: config.jev.apiKey,
        timeoutMs: config.jev.timeoutMs,
        policy: SYSTEM_ONE_SHADOW_POLICY,
        allowUncalibratedShadowObservation: true,
      })
    : undefined;
  const jevGate = rawJev === undefined ? undefined : gateJevProvider(rawJev, config.jev.sampleRate, config.jev.maxRequests);
  const jev = jevGate?.provider;
  const providers = jev === undefined ? [laya] : [laya, jev];
  let closing: Promise<void> | undefined;
  let closed = false;

  const coordinator = createSystemOneShadowCoordinator({
    providers,
    sink: dependencies.sink,
    providerTimeoutMs: Math.max(config.laya.timeoutMs, config.jev.timeoutMs) + 250,
    sinkTimeoutMs: 500,
  });

  return {
    coordinator,
    readiness: () => [
      { provider: "laya", status: laya.readiness().status },
      ...(config.jev.enabled ? [{
        provider: "jev" as const,
        status: jevGate?.isEnabled() === true ? "ready" as const : "disabled" as const,
      }] : []),
    ],
    close() {
      if (closed) return Promise.resolve();
      if (closing) return closing;
      closing = coordinator.flush().then(() => laya.close()).then(() => {
        closed = laya.readiness().status === "closed" || laya.readiness().status === "disabled";
      }).finally(() => { closing = undefined; });
      return closing;
    },
  };
}

function gateJevProvider(
  provider: JevDecisionAdapter,
  sampleRate: number,
  maxRequests: number,
): { provider: SystemOneDecisionProvider; isEnabled(): boolean } {
  let requests = 0;
  const invoke = async (
    decision: Parameters<SystemOneDecisionProvider["match"]>[0]
      | Parameters<SystemOneDecisionProvider["scoreQuality"]>[0]
      | Parameters<SystemOneDecisionProvider["routeDispute"]>[0],
    execute: () => Promise<SystemOneDecisionResult>,
  ): Promise<SystemOneDecisionResult> => {
    const sampleDigest = createHash("sha256").update(decision.decisionId).digest("hex");
    const sample = Number.parseInt(sampleDigest.slice(0, 8), 16) / 0xffff_ffff;
    if (requests >= maxRequests || !Number.isFinite(sample) || sample >= sampleRate) {
      return {
        provider: "jev",
        status: "fallback",
        decisionType: decision.decisionType,
        decisionId: decision.decisionId,
        reason: "disabled",
      };
    }
    requests += 1;
    return execute();
  };
  return {
    isEnabled: () => sampleRate > 0 && requests < maxRequests,
    provider: {
      provider: "jev",
      match: (decision) => invoke(decision, () => provider.match(decision)),
      scoreQuality: (decision) => invoke(decision, () => provider.scoreQuality(decision)),
      routeDispute: (decision) => invoke(decision, () => provider.routeDispute(decision)),
      ...(provider.close ? { close: () => provider.close!() } : {}),
    },
  };
}

function disabledRuntime(): SystemOneRuntime {
  return {
    coordinator: undefined,
    readiness: () => [],
    close: async () => undefined,
  };
}
