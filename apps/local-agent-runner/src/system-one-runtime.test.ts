import type { AgentMatchDecisionV1 } from "@agent-market/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  PINNED_LAYA_MODEL_HASHES,
  PINNED_LAYA_MODEL_REVISION,
  type SystemOneShadowConfig,
} from "./config";
import type { JevDecisionAdapterConfig } from "./jev-decision-adapter";
import type { LayaDecisionAdapter } from "./laya-decision-adapter";
import type { SystemOneDecisionProvider } from "./system-one-decision-provider";
import { createSystemOneRuntime, SYSTEM_ONE_SHADOW_POLICY } from "./system-one-runtime";

const matchDecision: AgentMatchDecisionV1 = {
  schemaVersion: 1,
  decisionType: "agent_match",
  decisionId: "runtime_match_01",
  taskRefHmac: "a".repeat(64),
  requiredCapabilityCodes: ["completion"],
  candidates: [],
};

describe("System-One runtime composition", () => {
  it("keeps provider authority gated while explicitly enabling shadow-only observation", () => {
    expect(SYSTEM_ONE_SHADOW_POLICY.calibrated).toBe(false);
  });

  it("creates no providers in off mode", () => {
    const createLaya = vi.fn();
    const createJev = vi.fn();

    const runtime = createSystemOneRuntime({ mode: "off" }, {
      createLaya,
      createJev,
      sink: vi.fn(),
    });

    expect(runtime.coordinator).toBeUndefined();
    expect(runtime.readiness()).toEqual([]);
    expect(createLaya).not.toHaveBeenCalled();
    expect(createJev).not.toHaveBeenCalled();
  });

  it("creates Laya once and omits Jev when remote comparison is disabled", () => {
    const laya = layaProvider();
    const createLaya = vi.fn(() => laya);
    const createJev = vi.fn();

    const runtime = createSystemOneRuntime(dualShadow(false), {
      createLaya,
      createJev,
      sink: vi.fn(),
    });

    expect(createLaya).toHaveBeenCalledTimes(1);
    expect(createJev).not.toHaveBeenCalled();
    expect(runtime.readiness()).toEqual([
      { provider: "laya", status: "idle" },
    ]);
  });

  it("creates Jev only when explicitly enabled with a key", () => {
    const policies: Array<{ calibrated: boolean; observationOnly: boolean }> = [];
    const createJev = vi.fn((config: JevDecisionAdapterConfig) => {
      policies.push({
        calibrated: config.policy.calibrated,
        observationOnly: config.allowUncalibratedShadowObservation === true,
      });
      return provider("jev");
    });

    createSystemOneRuntime(dualShadow(true, "test-key"), {
      createLaya: () => layaProvider(),
      createJev,
      sink: vi.fn(),
    });
    createSystemOneRuntime(dualShadow(true), {
      createLaya: () => layaProvider(),
      createJev,
      sink: vi.fn(),
    });

    expect(createJev).toHaveBeenCalledTimes(1);
    expect(policies).toEqual([{ calibrated: false, observationOnly: true }]);
  });

  it("enforces deterministic Jev sampling and a per-process request budget", async () => {
    const remote = vi.fn(async (decision: AgentMatchDecisionV1) => ({
      provider: "jev" as const,
      status: "fallback" as const,
      decisionType: decision.decisionType,
      decisionId: decision.decisionId,
      reason: "server_error" as const,
    }));
    const runtime = createSystemOneRuntime({
      ...dualShadow(true, "test-key"),
      jev: { enabled: true, apiKey: "test-key", timeoutMs: 1_500, sampleRate: 1, maxRequests: 1 },
    }, {
      createLaya: () => layaProvider(),
      createJev: () => provider("jev", remote),
      sink: vi.fn(),
    });

    await runtime.coordinator!.observeMatch({}, matchDecision);
    await runtime.coordinator!.observeMatch({}, { ...matchDecision, decisionId: "runtime_match_02" });

    expect(remote).toHaveBeenCalledTimes(1);
    expect(runtime.readiness()).toContainEqual({ provider: "jev", status: "disabled" });
  });

  it("does not construct Jev when its sample rate or request budget is zero", () => {
    const createJev = vi.fn(() => provider("jev"));
    const runtime = createSystemOneRuntime({
      ...dualShadow(true, "test-key"),
      jev: { enabled: true, apiKey: "test-key", timeoutMs: 1_500, sampleRate: 0, maxRequests: 0 },
    }, {
      createLaya: () => layaProvider(),
      createJev,
      sink: vi.fn(),
    });

    expect(createJev).not.toHaveBeenCalled();
    expect(runtime.readiness()).toContainEqual({ provider: "jev", status: "disabled" });
  });

  it("keeps Laya and the deterministic baseline usable when Jev is unreachable without replay", async () => {
    let remoteCalls = 0;
    const unreachable = provider("jev", async () => {
      remoteCalls += 1;
      throw new Error("offline");
    });
    const runtime = createSystemOneRuntime(dualShadow(true, "test-key"), {
      createLaya: () => layaProvider(),
      createJev: () => unreachable,
      sink: vi.fn(),
    });
    const baseline = { selectedAgentId: "deterministic-agent" };

    const returned = await runtime.coordinator!.observeMatch(baseline, matchDecision);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(returned).toBe(baseline);
    expect(remoteCalls).toBe(1);
  });

  it("closes loaded providers through one idempotent path", async () => {
    const close = vi.fn(async () => undefined);
    const runtime = createSystemOneRuntime(dualShadow(false), {
      createLaya: () => layaProvider(close),
      createJev: () => provider("jev"),
      sink: vi.fn(),
    });

    await Promise.all([runtime.close(), runtime.close(), runtime.close()]);

    expect(close).toHaveBeenCalledTimes(1);
    expect(runtime.readiness()).toEqual([{ provider: "laya", status: "closed" }]);
  });

  it("allows runtime shutdown to retry after the provider close fails", async () => {
    const close = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("native session close failed"))
      .mockResolvedValueOnce(undefined);
    const runtime = createSystemOneRuntime(dualShadow(false), {
      createLaya: () => layaProvider(close),
      sink: vi.fn(),
    });

    await expect(runtime.close()).rejects.toThrow("native session close failed");
    await expect(runtime.close()).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(2);
    expect(runtime.readiness()).toEqual([{ provider: "laya", status: "closed" }]);
  });

  it("drains pending shadow evidence before closing the local model", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const close = vi.fn(async () => undefined);
    const laya = layaProvider(close);
    laya.match = async () => {
      await gate;
      return {
        provider: "laya",
        status: "fallback",
        decisionType: "agent_match",
        decisionId: matchDecision.decisionId,
        reason: "disabled",
      };
    };
    const runtime = createSystemOneRuntime(dualShadow(false), {
      createLaya: () => laya,
      sink: vi.fn(async () => undefined),
    });

    const observation = runtime.coordinator!.observeMatch({}, matchDecision);
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await Promise.all([observation, closing]);

    expect(close).toHaveBeenCalledTimes(1);
    expect(closed).toBe(true);
  });
});

function dualShadow(
  jevEnabled: boolean,
  apiKey?: string,
): Extract<SystemOneShadowConfig, { mode: "dual-shadow" }> {
  return {
    mode: "dual-shadow",
    referenceHmacKey: "test-only-reference-key-32-characters",
    laya: {
      modelDir: "/opt/agent-market/laya",
      revision: PINNED_LAYA_MODEL_REVISION,
      hashes: PINNED_LAYA_MODEL_HASHES,
      timeoutMs: 2_000,
    },
    jev: { enabled: jevEnabled, apiKey, timeoutMs: 1_500, sampleRate: 1, maxRequests: 100 },
  };
}

function layaProvider(close: () => Promise<void> = vi.fn(async () => undefined)): LayaDecisionAdapter {
  let status: "idle" | "closed" = "idle";
  return {
    ...provider("laya"),
    provider: "laya",
    readiness: () => ({ status }),
    waitForIdle: async () => undefined,
    close: async () => { await close(); status = "closed"; },
  };
}

function provider(
  providerName: "laya" | "jev",
  match: SystemOneDecisionProvider["match"] = async (decision) => ({
    provider: providerName,
    status: "fallback",
    decisionType: decision.decisionType,
    decisionId: decision.decisionId,
    reason: "disabled",
  }),
): SystemOneDecisionProvider {
  return {
    provider: providerName,
    match,
    scoreQuality: async (decision) => ({
      provider: providerName,
      status: "fallback",
      decisionType: decision.decisionType,
      decisionId: decision.decisionId,
      reason: "disabled",
    }),
    routeDispute: async (decision) => ({
      provider: providerName,
      status: "fallback",
      decisionType: decision.decisionType,
      decisionId: decision.decisionId,
      reason: "disabled",
    }),
  };
}
