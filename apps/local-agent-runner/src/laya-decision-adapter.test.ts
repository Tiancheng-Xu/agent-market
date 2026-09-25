import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentMatchDecisionV1,
  AgentQualityDecisionV1,
  DisputeRouteDecisionV1,
  JevThresholdPolicyV1,
} from "@agent-market/shared-contracts";

import { createLayaDecisionAdapter, type LayaSession } from "./laya-decision-adapter";

const hash = "a".repeat(64);
const revision = "68f27dfe5a27a54fb2b1fefc432f43f972e90868";
const policy: JevThresholdPolicyV1 = {
  schemaVersion: 1,
  policyVersion: "system_one_synthetic_v1",
  mode: "synthetic-only",
  calibrated: false,
  match: { minConfidence: 0.8, minMargin: 0.2 },
  quality: { minConfidence: 0.8, minMargin: 0.2 },
  dispute: { minConfidence: 0.9, minMargin: 0.3 },
};
const matchDecision: AgentMatchDecisionV1 = {
  schemaVersion: 1,
  decisionType: "agent_match",
  decisionId: "decision_match_01",
  taskRefHmac: hash,
  requiredCapabilityCodes: ["typescript"],
  candidates: [{
    candidateRef: "candidate_opaque_01",
    passedImplementedGates: true,
    passedAllRequiredGates: false,
    capabilityMatch: true,
    health: "online",
    costBucket: "low",
    latencyBucket: "fast",
    qualityBucket: 4,
    newcomer: false,
    allowedRiskCodes: [],
  }],
};
const qualityDecision: AgentQualityDecisionV1 = {
  schemaVersion: 1,
  decisionType: "agent_quality",
  decisionId: "quality_01",
  taskRefHmac: hash,
  candidateRef: "candidate_opaque_01",
  completionStatus: "completed",
  retryBucket: "none",
  latencyBucket: "fast",
  costBucket: "low",
  evidenceCompleteness: "complete",
  reasonCodes: ["tests_passed"],
};
const disputeDecision: DisputeRouteDecisionV1 = {
  schemaVersion: 1,
  decisionType: "dispute_route",
  decisionId: "dispute_01",
  taskRefHmac: hash,
  riskLevel: "high",
  judgeOutcome: "needs_revision",
  retryBucket: "one",
  evidenceCompleteness: "partial",
  highRiskPolicyLocked: true,
  permittedRoutes: ["red_team", "repair", "ai_final_arbiter_review"],
  reasonCodes: ["high_risk"],
};

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Laya decision adapter", () => {
  it("does not touch files or load a session when disabled", async () => {
    const loadSession = vi.fn<() => Promise<LayaSession>>();
    const adapter = createLayaDecisionAdapter(baseConfig("/missing", loadSession, false));

    await expect(adapter.match(matchDecision)).resolves.toMatchObject({ status: "fallback", reason: "disabled" });
    expect(loadSession).not.toHaveBeenCalled();
  });

  it("verifies both hashes, loads once, reuses the session, and closes idempotently", async () => {
    const model = await modelDirectory();
    const close = vi.fn(async () => undefined);
    const session = fakeSession([
      { selection: choice("candidate_opaque_01", 0.94) },
      { quality: score(3.183) },
      { route: choice("red_team", 0.95, { red_team: 0.95, repair: 0.05 }) },
    ], close);
    const loadSession = vi.fn(async () => session);
    const adapter = createLayaDecisionAdapter(baseConfig(model.path, loadSession, true, model.hashes));

    await expect(adapter.match(matchDecision)).resolves.toMatchObject({ status: "observed", value: "candidate_opaque_01" });
    await expect(adapter.scoreQuality(qualityDecision)).resolves.toMatchObject({ status: "observed", value: 3.183 });
    await expect(adapter.routeDispute(disputeDecision)).resolves.toMatchObject({ status: "observed", value: "red_team" });
    expect(loadSession).toHaveBeenCalledTimes(1);
    expect(loadSession).toHaveBeenCalledWith({ modelDir: model.path, executionProviders: ["cpu"] });

    await adapter.close?.();
    await adapter.close?.();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("never touches a network sentinel during verification, load, or inference", async () => {
    const model = await modelDirectory();
    const network = vi.fn(() => { throw new Error("network forbidden"); });
    const loadSession = vi.fn(async () => fakeSession([{ quality: score(3.5) }], vi.fn(), network));
    const adapter = createLayaDecisionAdapter(baseConfig(model.path, loadSession, true, model.hashes));

    await expect(adapter.scoreQuality(qualityDecision)).resolves.toMatchObject({ status: "observed", value: 3.5 });
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "/missing", undefined],
    ["corrupt", "temporary", { "laya.onnx": "0".repeat(64), "laya.onnx.data": "1".repeat(64) }],
  ] as const)("falls back for %s local assets without loading", async (_name, pathKind, overrideHashes) => {
    const model = pathKind === "temporary" ? await modelDirectory() : undefined;
    const loadSession = vi.fn<() => Promise<LayaSession>>();
    const adapter = createLayaDecisionAdapter(baseConfig(model?.path ?? pathKind, loadSession, true, overrideHashes ?? model?.hashes));

    await expect(adapter.match(matchDecision)).resolves.toMatchObject({ status: "fallback", reason: "invalid_response" });
    expect(loadSession).not.toHaveBeenCalled();
  });

  it("falls back on load failure and timeout", async () => {
    const model = await modelDirectory();
    const failed = createLayaDecisionAdapter(baseConfig(model.path, async () => { throw new Error("load failed"); }, true, model.hashes));
    await expect(failed.match(matchDecision)).resolves.toMatchObject({ status: "fallback", reason: "server_error" });

    const timedOut = createLayaDecisionAdapter({
      ...baseConfig(model.path, async () => fakeSession([], vi.fn(), undefined, true), true, model.hashes),
      timeoutMs: 100,
    });
    await expect(timedOut.match(matchDecision)).resolves.toMatchObject({ status: "fallback", reason: "timeout" });

    const loadNever = vi.fn(async () => new Promise<LayaSession>(() => undefined));
    const loadTimedOut = createLayaDecisionAdapter({
      ...baseConfig(model.path, loadNever, true, model.hashes),
      timeoutMs: 100,
    });
    await expect(loadTimedOut.match(matchDecision)).resolves.toMatchObject({ status: "fallback", reason: "timeout" });
    await expect(loadTimedOut.match(matchDecision)).resolves.toMatchObject({ status: "fallback", reason: "timeout" });
    expect(loadTimedOut.readiness()).toEqual({ status: "loading" });
    expect(loadNever).toHaveBeenCalledTimes(1);
  });

  it("closes a session that finishes loading after adapter shutdown without resurrection", async () => {
    const model = await modelDirectory();
    const close = vi.fn(async () => undefined);
    const loaded = fakeSession([], close);
    let resolveLoad!: (session: LayaSession) => void;
    const loadSession = vi.fn(() => new Promise<LayaSession>((resolve) => { resolveLoad = resolve; }));
    const adapter = createLayaDecisionAdapter(baseConfig(model.path, loadSession, true, model.hashes));
    const pending = adapter.match(matchDecision);
    await vi.waitFor(() => expect(loadSession).toHaveBeenCalledTimes(1));

    await adapter.close();
    resolveLoad(loaded);

    await expect(pending).resolves.toMatchObject({ status: "fallback", reason: "server_error" });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(adapter.readiness()).toEqual({ status: "closed" });
  });

  it("tracks and retries a late-loaded session whose close throws synchronously", async () => {
    const model = await modelDirectory();
    const close = vi.fn<() => Promise<void>>()
      .mockImplementationOnce(() => { throw new Error("native close threw"); })
      .mockResolvedValueOnce(undefined);
    const loaded = fakeSession([], close);
    let resolveLoad!: (session: LayaSession) => void;
    const loadSession = vi.fn(() => new Promise<LayaSession>((resolve) => { resolveLoad = resolve; }));
    const adapter = createLayaDecisionAdapter(baseConfig(model.path, loadSession, true, model.hashes));
    const pending = adapter.match(matchDecision);
    await vi.waitFor(() => expect(loadSession).toHaveBeenCalledTimes(1));

    await adapter.close();
    resolveLoad(loaded);
    await expect(pending).resolves.toMatchObject({ status: "fallback", reason: "server_error" });
    await vi.waitFor(() => expect(adapter.readiness()).toEqual({ status: "fallback", reason: "server_error" }));
    expect(close).toHaveBeenCalledTimes(1);

    await expect(adapter.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
    expect(adapter.readiness()).toEqual({ status: "closed" });
  });

  it("does not close the ONNX session while timed-out inference is still running", async () => {
    const model = await modelDirectory();
    let release!: () => void;
    let started!: () => void;
    let releaseClose!: () => void;
    const inferenceStarted = new Promise<void>((resolve) => { started = resolve; });
    const inferenceGate = new Promise<void>((resolve) => { release = resolve; });
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const close = vi.fn(async () => { await closeGate; });
    const session: LayaSession = {
      async systemOne() {
        started();
        await inferenceGate;
        return { answers: { selection: choice("candidate_opaque_01", 0.95) } };
      },
      close,
    };
    const adapter = createLayaDecisionAdapter({
      ...baseConfig(model.path, async () => session, true, model.hashes),
      timeoutMs: 100,
    });

    const decision = adapter.match(matchDecision);
    await inferenceStarted;
    await expect(decision).resolves.toMatchObject({ status: "fallback", reason: "timeout" });
    let closed = false;
    const closing = adapter.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(close).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(adapter.readiness()).toEqual({ status: "closing" });
    releaseClose();
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
    expect(closed).toBe(true);
  });

  it("bounds shutdown when inference stays stuck and closes the session if it later settles", async () => {
    const model = await modelDirectory();
    let release!: () => void;
    const inferenceGate = new Promise<void>((resolve) => { release = resolve; });
    const close = vi.fn(async () => undefined);
    const session: LayaSession = {
      async systemOne() {
        await inferenceGate;
        return { answers: { selection: choice("candidate_opaque_01", 0.95) } };
      },
      close,
    };
    const adapter = createLayaDecisionAdapter({
      ...baseConfig(model.path, async () => session, true, model.hashes),
      timeoutMs: 100,
    });

    const decision = adapter.match(matchDecision);
    await expect(decision).resolves.toMatchObject({ status: "fallback", reason: "timeout" });
    await expect(adapter.close()).resolves.toBeUndefined();
    expect(close).not.toHaveBeenCalled();
    expect(adapter.readiness()).toEqual({ status: "closing" });

    release();
    await adapter.waitForIdle();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(adapter.readiness()).toEqual({ status: "closed" }));
  });

  it("reports a session-close failure and allows a later close retry", async () => {
    const model = await modelDirectory();
    const close = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("native session close failed"))
      .mockResolvedValueOnce(undefined);
    const adapter = createLayaDecisionAdapter({
      ...baseConfig(model.path, async () => fakeSession([{ selection: choice("candidate_opaque_01", 0.95) }], close), true, model.hashes),
      timeoutMs: 500,
    });

    await expect(adapter.match(matchDecision)).resolves.toMatchObject({ status: "observed" });
    await expect(adapter.close()).rejects.toThrow("native session close failed");
    expect(adapter.readiness()).toEqual({ status: "fallback", reason: "server_error" });
    await expect(adapter.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
    expect(adapter.readiness()).toEqual({ status: "closed" });
  });

  it("keeps readiness at closing during a retried native session close", async () => {
    const model = await modelDirectory();
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const close = vi.fn(async () => { await closeGate; });
    const adapter = createLayaDecisionAdapter({
      ...baseConfig(model.path, async () => fakeSession([{ selection: choice("candidate_opaque_01", 0.95) }], close), true, model.hashes),
      timeoutMs: 100,
    });

    await expect(adapter.match(matchDecision)).resolves.toMatchObject({ status: "observed" });
    await expect(adapter.close()).resolves.toBeUndefined();
    expect(adapter.readiness()).toEqual({ status: "closing" });

    const retriedClose = adapter.close();
    expect(adapter.readiness()).toEqual({ status: "closing" });
    releaseClose();
    await retriedClose;
    expect(close).toHaveBeenCalledTimes(1);
    expect(adapter.readiness()).toEqual({ status: "closed" });
  });

  it("rejects malformed distributions and out-of-pool choices", async () => {
    const model = await modelDirectory();
    const session = fakeSession([
      { quality: score(2.5, { "0": 0.1, "1": 0.1, "2": 0.1, "3": 0.1, "4": 0.1 }) },
      { selection: choice("candidate_outside", 1, { candidate_outside: 1 }) },
    ]);
    const adapter = createLayaDecisionAdapter(baseConfig(model.path, async () => session, true, model.hashes));

    await expect(adapter.scoreQuality(qualityDecision)).resolves.toMatchObject({ status: "fallback", reason: "invalid_response" });
    await expect(adapter.match(matchDecision)).resolves.toMatchObject({ status: "fallback", reason: "out_of_pool" });
  });

  it("rejects a quality score that disagrees with its distribution", async () => {
    const model = await modelDirectory();
    const session = fakeSession([
      { quality: score(3.5, { "0": 0.02, "1": 0.03, "2": 0.05, "3": 0.7, "4": 0.2 }) },
    ]);
    const adapter = createLayaDecisionAdapter(baseConfig(model.path, async () => session, true, model.hashes));

    await expect(adapter.scoreQuality(qualityDecision)).resolves.toMatchObject({
      status: "fallback",
      reason: "invalid_response",
    });
  });

  it("observes valid shadow results before calibration without granting authority", async () => {
    const model = await modelDirectory();
    const session = fakeSession([{ selection: choice("candidate_opaque_01", 0.99, { candidate_opaque_01: 0.92, abstain: 0.08 }) }]);
    const adapter = createLayaDecisionAdapter({
      ...baseConfig(model.path, async () => session, true, model.hashes),
      policy: { ...policy, mode: "shadow", calibrated: false },
      allowUncalibratedShadowObservation: true,
    });

    await expect(adapter.match(matchDecision)).resolves.toMatchObject({
      status: "observed",
      value: "candidate_opaque_01",
    });
    expect(adapter.readiness()).toEqual({ status: "ready" });
  });

  it("applies shadow confidence and margin thresholds while uncalibrated", async () => {
    const model = await modelDirectory();
    const session = fakeSession([{ selection: choice("candidate_opaque_01", 0.51, { candidate_opaque_01: 0.51, abstain: 0.49 }) }]);
    const adapter = createLayaDecisionAdapter({
      ...baseConfig(model.path, async () => session, true, model.hashes),
      policy: { ...policy, mode: "shadow", calibrated: false },
      allowUncalibratedShadowObservation: true,
    });

    await expect(adapter.match(matchDecision)).resolves.toMatchObject({ status: "fallback", reason: "below_threshold" });
  });
});

function baseConfig(
  modelDir: string,
  loadSession: (options: { modelDir: string; executionProviders: ["cpu"] }) => Promise<LayaSession>,
  enabled: boolean,
  hashes = { "laya.onnx": "0".repeat(64), "laya.onnx.data": "1".repeat(64) },
) {
  return { enabled, modelDir, revision, hashes, policy, timeoutMs: 500, loadSession };
}

async function modelDirectory() {
  const path = await mkdtemp(join(tmpdir(), "agent-market-laya-"));
  temporaryDirectories.push(path);
  const graph = "graph";
  const data = "data";
  await writeFile(join(path, "laya.onnx"), graph);
  await writeFile(join(path, "laya.onnx.data"), data);
  return {
    path,
    hashes: {
      "laya.onnx": createHash("sha256").update(graph).digest("hex"),
      "laya.onnx.data": createHash("sha256").update(data).digest("hex"),
    },
  };
}

function fakeSession(
  answers: Array<Record<string, unknown>>,
  close: () => Promise<void> = vi.fn(async () => undefined),
  _networkSentinel?: () => never,
  neverResolve = false,
): LayaSession {
  return {
    async systemOne() {
      if (neverResolve) return new Promise(() => undefined);
      return { answers: answers.shift() ?? {}, usage: { input_tokens: 11 } };
    },
    close,
  };
}

function choice(
  value: string,
  confidence: number,
  probabilities: Record<string, number> = { [value]: confidence, abstain: 1 - confidence },
) {
  return { type: "choice", choice: value, confidence, probabilities, rl_agent: { act_probability: 0.9 } };
}

function score(
  value: number,
  probabilities?: Record<string, number>,
) {
  const scoreProbabilities = probabilities ?? { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0 };
  if (!probabilities) {
    const lower = Math.floor(value);
    const upper = Math.ceil(value);
    if (lower === upper) {
      scoreProbabilities[String(lower)] = 1;
    } else {
      scoreProbabilities[String(lower)] = upper - value;
      scoreProbabilities[String(upper)] = value - lower;
    }
  }
  return { type: "score", score: value, confidence: 0.9, probabilities: scoreProbabilities, rl_agent: { act_probability: 0.9 } };
}
