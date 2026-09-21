import { readFileSync } from "node:fs";

import {
  AgentMatchDecisionV1Schema,
  AgentQualityDecisionV1Schema,
  DisputeRouteDecisionV1Schema,
} from "@agent-market/shared-contracts";
import { describe, expect, it } from "vitest";

import { createJevDecisionAdapter, type JevShadowResult } from "./jev-decision-adapter";
import { evaluateFrozenRoutingDataset, type FrozenRoutingDataset } from "./routing-evaluation";

const casesUrl = new URL("../evaluation/jev-routing-cases.json", import.meta.url);
const evidenceUrl = new URL("../../../docs/evidence/testing/2026-09-21-jev-shadow-synthetic-eval.json", import.meta.url);
const baselineUrl = new URL("../evaluation/frozen-routing-cases.json", import.meta.url);
const casesSource = readFileSync(casesUrl, "utf8");
const evidenceSource = readFileSync(evidenceUrl, "utf8");
const baselineDataset = JSON.parse(readFileSync(baselineUrl, "utf8")) as FrozenRoutingDataset;

type SyntheticCase = {
  id: string;
  decisionType: "agent_match" | "agent_quality" | "dispute_route";
  decision: unknown;
  adapter: {
    enabled: boolean;
    policyMode: "synthetic-only" | "shadow";
    calibrated: boolean;
  };
  response?: unknown;
  expected: {
    status: "observed" | "fallback";
    value?: string | number;
    reason?: string;
    networkCalls: number;
    baselinePreserved: true;
  };
};

type SyntheticDataset = {
  schemaVersion: 1;
  datasetId: string;
  cases: SyntheticCase[];
};

describe("Jev synthetic evidence", () => {
  it("executes every frozen case and derives the recorded synthetic metrics", async () => {
    const dataset = JSON.parse(casesSource) as SyntheticDataset;
    expect(dataset.datasetId).toBe("agent-market-jev-synthetic-v1");
    expect(new Set(dataset.cases.map((item) => item.decisionType))).toEqual(new Set([
      "agent_match",
      "agent_quality",
      "dispute_route",
    ]));

    const baselineBefore = evaluateFrozenRoutingDataset(baselineDataset);
    const results: Array<{ testCase: SyntheticCase; result: JevShadowResult; networkCalls: number }> = [];
    for (const testCase of dataset.cases) {
      const execution = await executeSyntheticCase(testCase);
      expect(execution.result.status).toBe(testCase.expected.status);
      if (testCase.expected.value !== undefined) {
        expect(execution.result).toMatchObject({ value: testCase.expected.value });
      }
      if (testCase.expected.reason !== undefined) {
        expect(execution.result).toMatchObject({ reason: testCase.expected.reason });
      }
      expect(execution.networkCalls).toBe(testCase.expected.networkCalls);
      results.push({ testCase, ...execution });
    }

    const baselineAfter = evaluateFrozenRoutingDataset(baselineDataset);
    expect(baselineAfter).toEqual(baselineBefore);

    const evidence = JSON.parse(evidenceSource) as {
      metrics: Record<string, unknown>;
    };
    const fallbackCounts = countBy(results.filter((item) => item.result.status === "fallback").map((item) =>
      item.result.status === "fallback" ? item.result.reason : "unreachable"));
    const observedCounts = countBy(results.filter((item) => item.result.status === "observed").map((item) => item.testCase.decisionType));
    const outOfPoolObservedChoices = results.filter((item) => {
      if (item.testCase.decisionType !== "agent_match" || item.result.status !== "observed") return false;
      const decision = AgentMatchDecisionV1Schema.parse(item.testCase.decision);
      const observedValue = item.result.value;
      return !decision.candidates.some((candidate) => candidate.candidateRef === observedValue);
    }).length;

    expect(evidence.metrics).toMatchObject({
      caseCount: results.length,
      fallbackCounts,
      observedCounts,
      hardFilterViolations: 0,
      outOfPoolObservedChoices,
      baselineMutations: 0,
      realTypeSafeRequests: 0,
      reputationWrites: 0,
      chainTransactions: 0,
    });
  });

  it("records truthful synthetic-only rollout status and zero authority changes", () => {
    const evidence = JSON.parse(evidenceSource) as Record<string, unknown>;

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      datasetId: "agent-market-jev-synthetic-v1",
      status: {
        deterministicBaseline: "implemented-local",
        jevAdapter: "synthetic-verified",
        jevQueenShadowProduction: "not-started",
        jevGoMatcherShadow: "not-designed",
        jevProductionAuthority: "prohibited",
      },
      metrics: {
        caseCount: 6,
        hardFilterViolations: 0,
        outOfPoolObservedChoices: 0,
        baselineMutations: 0,
        realTypeSafeRequests: 0,
        reputationWrites: 0,
        chainTransactions: 0,
      },
    });
  });

  it("contains no raw prompts, secrets, wallets, local paths, or agent output", () => {
    const source = `${casesSource}\n${evidenceSource}`;
    expect(source).not.toMatch(/rawPrompt|rawOutput|wallet|private[_-]?key|api[_-]?key|bearer\s|\/Users\/|TYPESAFE_API_KEY/i);
  });
});

async function executeSyntheticCase(testCase: SyntheticCase): Promise<{
  result: JevShadowResult;
  networkCalls: number;
}> {
  let networkCalls = 0;
  const adapter = createJevDecisionAdapter({
    enabled: testCase.adapter.enabled,
    apiKey: testCase.adapter.enabled ? "synthetic-test-only" : undefined,
    policy: {
      schemaVersion: 1,
      policyVersion: "jev_policy_v1_synthetic",
      mode: testCase.adapter.policyMode,
      calibrated: testCase.adapter.calibrated,
      match: { minConfidence: 0.8, minMargin: 0.2 },
      quality: { minConfidence: 0.8, minMargin: 0.2 },
      dispute: { minConfidence: 0.9, minMargin: 0.3 },
    },
    fetchImpl: async () => {
      networkCalls += 1;
      if (testCase.response === undefined) throw new Error("Synthetic response missing");
      return new Response(JSON.stringify(testCase.response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  if (testCase.decisionType === "agent_match") {
    return { result: await adapter.match(AgentMatchDecisionV1Schema.parse(testCase.decision)), networkCalls };
  }
  if (testCase.decisionType === "agent_quality") {
    return { result: await adapter.scoreQuality(AgentQualityDecisionV1Schema.parse(testCase.decision)), networkCalls };
  }
  return { result: await adapter.routeDispute(DisputeRouteDecisionV1Schema.parse(testCase.decision)), networkCalls };
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}
