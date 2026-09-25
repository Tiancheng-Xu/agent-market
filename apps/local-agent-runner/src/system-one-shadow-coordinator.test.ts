import { describe, expect, it, vi } from "vitest";
import type {
  AgentMatchDecisionV1,
  AgentQualityDecisionV1,
  DisputeRouteDecisionV1,
} from "@agent-market/shared-contracts";

import { createSystemOneShadowCoordinator, type SystemOneShadowEvidence } from "./system-one-shadow-coordinator";
import type { SystemOneDecisionProvider, SystemOneDecisionResult } from "./system-one-decision-provider";

const hash = "a".repeat(64);
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

describe("System-One shadow coordinator", () => {
  it("records agreement and returns the exact match baseline object", async () => {
    const evidence: SystemOneShadowEvidence[] = [];
    const baseline = { autoSelectedAgentId: "candidate_opaque_01", privateValue: "never-record" };
    const coordinator = createSystemOneShadowCoordinator({
      providers: [provider("laya", observed("laya", "agent_match", "decision_match_01", "candidate_opaque_01")), provider("jev", observed("jev", "agent_match", "decision_match_01", "candidate_opaque_01"))],
      sink: async (record) => { evidence.push(record); },
    });

    await expect(coordinator.observeMatch(baseline, matchDecision)).resolves.toBe(baseline);
    await coordinator.flush();
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ decisionType: "agent_match", agreement: "all" });
    expect(JSON.stringify(evidence[0])).not.toContain("never-record");
    expect(JSON.stringify(evidence[0])).not.toContain("taskRefHmac");
  });

  it("records disagreement without changing a fractional quality baseline", async () => {
    const sink = vi.fn(async (_record: SystemOneShadowEvidence) => undefined);
    const coordinator = createSystemOneShadowCoordinator({
      providers: [provider("laya", observed("laya", "agent_quality", "quality_01", 3.183)), provider("jev", observed("jev", "agent_quality", "quality_01", 3.97))],
      sink,
    });

    await expect(coordinator.observeQuality(0.91, qualityDecision)).resolves.toBe(0.91);
    await coordinator.flush();
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ agreement: "none" }));
  });

  it("isolates fallback, timeout, and thrown providers from a dispute baseline", async () => {
    const diagnostics = vi.fn();
    const sink = vi.fn(async (_record: SystemOneShadowEvidence) => undefined);
    const throwing = provider("jev", observed("jev", "dispute_route", "dispute_01", "repair"));
    throwing.routeDispute = async () => { throw new Error("provider failed"); };
    const coordinator = createSystemOneShadowCoordinator({
      providers: [provider("laya", fallback("laya", "dispute_route", "dispute_01", "timeout")), throwing],
      sink,
      onDiagnostic: diagnostics,
    });
    const baseline = { branch: "red_team", immutable: true };

    await expect(coordinator.observeDispute(baseline, disputeDecision)).resolves.toBe(baseline);
    await coordinator.flush();
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ agreement: "insufficient" }));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ type: "provider_error", provider: "jev" }));
  });

  it("returns the baseline before a bounded shadow provider settles and drains on flush", async () => {
    const calls = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const late = provider("laya", observed("laya", "agent_match", "decision_match_01", "candidate_opaque_01"));
    late.match = async () => {
      calls();
      await gate;
      return observed("laya", "agent_match", "decision_match_01", "candidate_opaque_01");
    };
    const baseline = ["candidate_opaque_01"];
    const sink = vi.fn(async () => undefined);
    const coordinator = createSystemOneShadowCoordinator({ providers: [late], sink });

    await expect(coordinator.observeMatch(baseline, matchDecision)).resolves.toBe(baseline);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(sink).not.toHaveBeenCalled();
    release();
    await coordinator.flush();
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("swallows Evidence sink failure and reports only a diagnostic", async () => {
    const diagnostics = vi.fn();
    const baseline = { branch: "repair" };
    const coordinator = createSystemOneShadowCoordinator({
      providers: [provider("laya", observed("laya", "dispute_route", "dispute_01", "repair"))],
      sink: async () => { throw new Error("sink offline"); },
      onDiagnostic: diagnostics,
    });

    await expect(coordinator.observeDispute(baseline, disputeDecision)).resolves.toBe(baseline);
    await coordinator.flush();
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ type: "sink_error" }));
  });

  it("bounds a provider that never resolves", async () => {
    const hanging = provider("laya", fallback("laya", "agent_match", "decision_match_01", "timeout"));
    hanging.match = async () => new Promise(() => undefined);
    const evidence: SystemOneShadowEvidence[] = [];
    const baseline = { selected: "candidate_opaque_01" };
    const coordinator = createSystemOneShadowCoordinator({
      providers: [hanging],
      providerTimeoutMs: 20,
      sink: async (record) => { evidence.push(record); },
    });

    await expect(coordinator.observeMatch(baseline, matchDecision)).resolves.toBe(baseline);
    await coordinator.flush();
    expect(evidence[0]?.observations[0]).toMatchObject({ status: "fallback", fallbackReason: "timeout" });
  });

  it("caps unresolved provider work and records capacity-limited observations as skipped", async () => {
    const calls = vi.fn();
    const hanging = provider("laya", observed("laya", "agent_match", "decision_match_01", "candidate_opaque_01"));
    hanging.match = async () => {
      calls();
      return new Promise(() => undefined);
    };
    const evidence: SystemOneShadowEvidence[] = [];
    const coordinator = createSystemOneShadowCoordinator({
      providers: [hanging],
      providerTimeoutMs: 20,
      maxConcurrentPerProvider: 1,
      sink: async (record) => { evidence.push(record); },
    });

    const firstBaseline = { sequence: 1 };
    const secondBaseline = { sequence: 2 };
    await expect(coordinator.observeMatch(firstBaseline, matchDecision)).resolves.toBe(firstBaseline);
    await expect(coordinator.observeMatch(secondBaseline, { ...matchDecision, decisionId: "decision_match_02" })).resolves.toBe(secondBaseline);
    await coordinator.flush();

    expect(calls).toHaveBeenCalledTimes(1);
    expect(evidence.flatMap((item) => item.observations)).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "laya", status: "fallback", fallbackReason: "timeout" }),
      expect.objectContaining({ provider: "laya", status: "skipped", skipReason: "capacity_limited" }),
    ]));
  });

  it("holds a provider slot after its result times out until underlying work becomes idle", async () => {
    const calls = vi.fn();
    let release!: () => void;
    let becomeIdle!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const idle = new Promise<void>((resolve) => { becomeIdle = resolve; });
    const evidence: SystemOneShadowEvidence[] = [];
    const laya = provider("laya", fallback("laya", "agent_match", "decision_match_01", "timeout"));
    laya.match = async () => {
      calls();
      return fallback("laya", "agent_match", "decision_match_01", "timeout");
    };
    laya.waitForIdle = async () => { await gate; becomeIdle(); };
    const coordinator = createSystemOneShadowCoordinator({
      providers: [laya],
      providerTimeoutMs: 20,
      sink: async (record) => { evidence.push(record); },
    });

    await coordinator.observeMatch({}, matchDecision);
    await vi.waitFor(() => expect(evidence).toHaveLength(1));
    await coordinator.observeMatch({}, { ...matchDecision, decisionId: "decision_match_02" });
    await coordinator.flush();

    expect(calls).toHaveBeenCalledTimes(1);
    expect(evidence[1]?.observations[0]).toMatchObject({ status: "skipped", skipReason: "capacity_limited" });
    release();
    await idle;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await coordinator.observeMatch({}, { ...matchDecision, decisionId: "decision_match_03" });
    await coordinator.flush();
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("drops new observations when the pending Evidence capacity is full", async () => {
    const diagnostics = vi.fn();
    const calls = vi.fn();
    let releaseSink!: () => void;
    const sinkGate = new Promise<void>((resolve) => { releaseSink = resolve; });
    const laya = provider("laya", observed("laya", "agent_match", "decision_match_01", "candidate_opaque_01"));
    laya.match = async () => {
      calls();
      return observed("laya", "agent_match", "decision_match_01", "candidate_opaque_01");
    };
    const coordinator = createSystemOneShadowCoordinator({
      providers: [laya],
      maxPendingObservations: 1,
      sinkTimeoutMs: 1_000,
      sink: async () => { await sinkGate; },
      onDiagnostic: diagnostics,
    });

    await coordinator.observeMatch({ sequence: 1 }, matchDecision);
    await coordinator.observeMatch({ sequence: 2 }, { ...matchDecision, decisionId: "decision_match_02" });

    expect(calls).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveBeenCalledWith({ type: "observation_dropped", reason: "pending_capacity" });
    releaseSink();
    await coordinator.flush();
  });

  it("rejects configured capacities above the hard limits", () => {
    const base = { providers: [], sink: async () => undefined };

    expect(() => createSystemOneShadowCoordinator({ ...base, maxConcurrentPerProvider: 17 })).toThrow(
      "maxConcurrentPerProvider must be an integer from 1 to 16",
    );
    expect(() => createSystemOneShadowCoordinator({ ...base, maxPendingObservations: 1_025 })).toThrow(
      "maxPendingObservations must be an integer from 1 to 1024",
    );
  });

  it("bounds a sink that never resolves", async () => {
    const diagnostics = vi.fn();
    const baseline = { branch: "repair" };
    const coordinator = createSystemOneShadowCoordinator({
      providers: [provider("laya", observed("laya", "dispute_route", "dispute_01", "repair"))],
      sink: async () => new Promise(() => undefined),
      sinkTimeoutMs: 20,
      onDiagnostic: diagnostics,
    });

    await expect(coordinator.observeDispute(baseline, disputeDecision)).resolves.toBe(baseline);
    await coordinator.flush();
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ type: "sink_error" }));
  });

  it("does no asynchronous provider or sink work when disabled", async () => {
    const sink = vi.fn();
    const baseline = { selected: "candidate_opaque_01" };
    const coordinator = createSystemOneShadowCoordinator({ providers: [], sink });

    await expect(coordinator.observeMatch(baseline, matchDecision)).resolves.toBe(baseline);
    expect(sink).not.toHaveBeenCalled();
  });
});

function provider(name: "laya" | "jev", result: SystemOneDecisionResult): SystemOneDecisionProvider {
  return {
    provider: name,
    match: async () => result,
    scoreQuality: async () => result,
    routeDispute: async () => result,
  };
}

function observed(
  providerName: "laya" | "jev",
  decisionType: "agent_match" | "agent_quality" | "dispute_route",
  decisionId: string,
  value: string | number,
): SystemOneDecisionResult {
  return {
    status: "observed",
    provider: providerName,
    decisionType,
    decisionId,
    value,
    confidence: 0.9,
    probabilities: { selected: 0.9, other: 0.1 },
    margin: 0.8,
    model: `${providerName}-test`,
    usage: { inputTokens: 1 },
    latencyMs: 2,
  };
}

function fallback(
  providerName: "laya" | "jev",
  decisionType: "agent_match" | "agent_quality" | "dispute_route",
  decisionId: string,
  reason: "timeout" | "disabled",
): SystemOneDecisionResult {
  return { status: "fallback", provider: providerName, decisionType, decisionId, reason };
}
