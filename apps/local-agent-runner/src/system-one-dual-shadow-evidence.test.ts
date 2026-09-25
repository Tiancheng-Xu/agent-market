import { readFileSync } from "node:fs";

import type {
  AgentMatchDecisionV1,
  AgentQualityDecisionV1,
  DisputeRouteDecisionV1,
  JevDecisionType,
  JevFallbackReason,
} from "@agent-market/shared-contracts";
import { describe, expect, it } from "vitest";

import type { SystemOneDecisionProvider, SystemOneDecisionResult, SystemOneProviderName } from "./system-one-decision-provider";
import { createSystemOneShadowCoordinator, type SystemOneShadowEvidence } from "./system-one-shadow-coordinator";

const casesSource = readFileSync(new URL("../evaluation/system-one-dual-shadow-cases.json", import.meta.url), "utf8");
const evidenceSource = readFileSync(new URL("../../../docs/evidence/testing/2026-09-21-system-one-dual-shadow-eval.json", import.meta.url), "utf8");

type Outcome =
  | { status: "observed"; value: string | number; fakeTransportCalls?: number; sessionCalls?: number }
  | { status: "fallback"; reason: JevFallbackReason; fakeTransportCalls?: number; sessionCalls?: number };
type SyntheticCase = {
  id: string;
  decisionType: JevDecisionType;
  laya: Outcome;
  jev: Outcome;
};
type Dataset = { schemaVersion: 1; datasetId: string; frozenAt: string; scope: "synthetic-only"; cases: SyntheticCase[] };

describe("System-One dual-shadow evidence", () => {
  it("executes all frozen cases with zero authority and zero real remote requests", async () => {
    const dataset = JSON.parse(casesSource) as Dataset;
    const evidenceRecords: SystemOneShadowEvidence[] = [];
    let fakeJevProviderCalls = 0;
    let fakeLayaProviderCalls = 0;
    let networkSentinelCalls = 0;
    let authorityMutations = 0;
    let hardFilterViolations = 0;

    for (const testCase of dataset.cases) {
      const decision = decisionFor(testCase);
      const coordinator = createSystemOneShadowCoordinator({
        providers: [
          providerFor("laya", testCase.laya, () => { fakeLayaProviderCalls += testCase.laya.sessionCalls ?? 1; }),
          providerFor("jev", testCase.jev, () => { fakeJevProviderCalls += testCase.jev.fakeTransportCalls ?? 0; }),
        ],
        sink: async (record) => { evidenceRecords.push(record); },
      });
      const baseline = Object.freeze({ authority: "deterministic-host", selected: "candidate_a" });
      const returned = testCase.decisionType === "agent_match"
        ? await coordinator.observeMatch(baseline, decision as AgentMatchDecisionV1)
        : testCase.decisionType === "agent_quality"
          ? await coordinator.observeQuality(baseline, decision as AgentQualityDecisionV1)
          : await coordinator.observeDispute(baseline, decision as DisputeRouteDecisionV1);
      await coordinator.flush();
      if (returned !== baseline) authorityMutations += 1;
      if (testCase.decisionType === "agent_match") {
        const allowed = new Set((decision as AgentMatchDecisionV1).candidates.map((candidate) => candidate.candidateRef));
        for (const outcome of [testCase.laya, testCase.jev]) {
          if (outcome.status === "observed" && typeof outcome.value === "string" && !allowed.has(outcome.value)) {
            hardFilterViolations += 1;
          }
        }
      }
    }

    const callsBeforeReconnect = fakeJevProviderCalls;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const generated = {
      schemaVersion: 1,
      datasetId: dataset.datasetId,
      generatedFrom: dataset.frozenAt,
      status: {
        deterministicAuthority: "host-only",
        laya: "synthetic-provider-fixture",
        jev: "synthetic-provider-fixture",
        providerAuthority: "prohibited",
      },
      metrics: {
        caseCount: dataset.cases.length,
        agreementCounts: countBy(evidenceRecords.map((record) => record.agreement)),
        fallbackCounts: countBy(evidenceRecords.flatMap((record) => record.observations
          .filter((observation) => observation.status === "fallback")
          .map((observation) => observation.fallbackReason ?? "unknown"))),
        fakeLayaProviderCalls,
        fakeJevProviderCalls,
        realTypeSafeRequests: networkSentinelCalls,
        deferredRemoteReplays: fakeJevProviderCalls - callsBeforeReconnect,
        hardFilterViolations,
        authorityMutations,
      },
      portableTestBoundary: {
        realAdaptersExecuted: false,
        networkIsolation: "not-measured",
        modelAndPackageDownloads: "not-measured",
        releaseGateRequired: "hash-pinned-laya-with-network-denied",
      },
    };

    expect(generated.metrics).toMatchObject({
      caseCount: 13,
      realTypeSafeRequests: 0,
      deferredRemoteReplays: 0,
      hardFilterViolations: 0,
      authorityMutations: 0,
    });
    expect(generated).toEqual(JSON.parse(evidenceSource));
  });

  it("contains no raw prompts, outputs, secrets, wallets, or local paths", () => {
    expect(`${casesSource}\n${evidenceSource}`).not.toMatch(/rawPrompt|rawOutput|wallet|private[_-]?key|api[_-]?key|bearer\s|\/Users\/|TYPESAFE_API_KEY/i);
  });
});

function providerFor(provider: SystemOneProviderName, outcome: Outcome, onCall: () => void): SystemOneDecisionProvider {
  const execute = async (decision: { decisionType: JevDecisionType; decisionId: string }): Promise<SystemOneDecisionResult> => {
    onCall();
    if (outcome.status === "fallback") {
      return { provider, status: "fallback", decisionType: decision.decisionType, decisionId: decision.decisionId, reason: outcome.reason };
    }
    return {
      provider,
      status: "observed",
      decisionType: decision.decisionType,
      decisionId: decision.decisionId,
      value: outcome.value,
      confidence: 0.95,
      probabilities: { [String(outcome.value)]: 0.95, abstain: 0.05 },
      margin: 0.9,
      model: `${provider}-synthetic-fixture`,
      usage: { inputTokens: 1 },
      latencyMs: 1,
    };
  };
  return { provider, match: execute, scoreQuality: execute, routeDispute: execute };
}

function decisionFor(testCase: SyntheticCase): AgentMatchDecisionV1 | AgentQualityDecisionV1 | DisputeRouteDecisionV1 {
  const common = { schemaVersion: 1 as const, decisionId: `case_${testCase.id.replace(/-/g, "_")}`, taskRefHmac: "a".repeat(64) };
  if (testCase.decisionType === "agent_match") {
    return {
      ...common,
      decisionType: "agent_match",
      requiredCapabilityCodes: ["completion"],
      candidates: ["candidate_a", "candidate_b"].map((candidateRef) => ({
        candidateRef,
        passedImplementedGates: true as const,
        passedAllRequiredGates: true,
        capabilityMatch: true as const,
        health: "online" as const,
        costBucket: "low" as const,
        latencyBucket: "fast" as const,
        qualityBucket: 4,
        newcomer: false,
        allowedRiskCodes: [],
      })),
    };
  }
  if (testCase.decisionType === "agent_quality") {
    return {
      ...common,
      decisionType: "agent_quality",
      candidateRef: "candidate_a",
      completionStatus: "completed",
      retryBucket: "none",
      latencyBucket: "fast",
      costBucket: "low",
      evidenceCompleteness: "complete",
      reasonCodes: ["tests_passed"],
    };
  }
  return {
    ...common,
    decisionType: "dispute_route",
    riskLevel: "high",
    judgeOutcome: "needs_revision",
    retryBucket: "one",
    evidenceCompleteness: "partial",
    highRiskPolicyLocked: true,
    permittedRoutes: ["red_team", "repair", "ai_final_arbiter_review"],
    reasonCodes: ["high_risk"],
  };
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}
