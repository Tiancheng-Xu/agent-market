import { describe, expect, it } from "vitest";

import type {
  AgentMatchDecisionV1,
  AgentQualityDecisionV1,
  DisputeRouteDecisionV1,
  JevThresholdPolicyV1,
} from "@agent-market/shared-contracts";

import { parseJevShadowConfig } from "./config";
import { createJevDecisionAdapter, type JevFetch } from "./jev-decision-adapter";

const hash = "a".repeat(64);
const policy: JevThresholdPolicyV1 = {
  schemaVersion: 1,
  policyVersion: "jev_policy_v1_synthetic",
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

describe("Jev decision adapter", () => {
  it("defaults shadow mode to disabled", () => {
    expect(parseJevShadowConfig({})).toEqual({
      enabled: false,
      apiKey: undefined,
      timeoutMs: 1_500,
      sampleRate: 0.1,
      maxRequests: 100,
    });
  });

  it("does not call transport when disabled", async () => {
    let calls = 0;
    const adapter = createJevDecisionAdapter({
      enabled: false,
      apiKey: undefined,
      policy,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("unexpected");
      },
    });

    await expect(adapter.match(matchDecision)).resolves.toMatchObject({
      status: "fallback",
      reason: "disabled",
    });
    expect(calls).toBe(0);
  });

  it("does not call transport without a key", async () => {
    let calls = 0;
    const adapter = createJevDecisionAdapter({
      enabled: true,
      apiKey: undefined,
      policy,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("unexpected");
      },
    });

    await expect(adapter.match(matchDecision)).resolves.toMatchObject({
      status: "fallback",
      reason: "missing_key",
    });
    expect(calls).toBe(0);
  });

  it("returns observed match, quality, and dispute outputs in synthetic mode", async () => {
    const responses = [
      jevResponse({
        selection: {
          type: "choice",
          choice: "candidate_opaque_01",
          confidence: 0.94,
          probabilities: { candidate_opaque_01: 0.94, abstain: 0.06 },
        },
      }),
      jevResponse({
        quality: {
          type: "score",
          score: 3,
          confidence: 0.9,
          probabilities: { "0": 0, "1": 0, "2": 0, "3": 1, "4": 0 },
          legend: { "0": "unusable", "1": "poor", "2": "mixed", "3": "good", "4": "excellent" },
        },
      }),
      jevResponse({
        route: {
          type: "choice",
          choice: "red_team",
          confidence: 0.95,
          probabilities: { red_team: 0.95, repair: 0.05 },
        },
      }),
    ];
    const adapter = createJevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      policy,
      fetchImpl: async () => responses.shift() ?? jevResponse({}),
    });

    await expect(adapter.match(matchDecision)).resolves.toMatchObject({
      status: "observed",
      value: "candidate_opaque_01",
      confidence: 0.94,
    });
    await expect(adapter.scoreQuality(qualityDecision)).resolves.toMatchObject({
      status: "observed",
      value: 3,
      confidence: 0.9,
    });
    await expect(adapter.routeDispute(disputeDecision)).resolves.toMatchObject({
      status: "observed",
      value: "red_team",
      confidence: 0.95,
    });
  });

  it("preserves a fractional quality score from a valid live response", async () => {
    const adapter = createJevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      policy,
      fetchImpl: async () => jevResponse({
        quality: {
          type: "score",
          score: 3.97,
          confidence: 0.98,
          probabilities: { "0": 0, "1": 0, "2": 0, "3": 0.03, "4": 0.97 },
          legend: { "0": "unusable", "1": "poor", "2": "mixed", "3": "good", "4": "excellent" },
        },
      }),
    });

    await expect(adapter.scoreQuality(qualityDecision)).resolves.toMatchObject({
      status: "observed",
      value: 3.97,
    });
  });

  it("rejects a score distribution whose probabilities do not sum to one", async () => {
    const adapter = createJevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      policy,
      fetchImpl: async () => jevResponse({
        quality: {
          type: "score",
          score: 3.2,
          confidence: 0.7,
          probabilities: { "0": 0, "1": 0, "2": 0.1, "3": 0.3, "4": 0.3 },
          legend: { "0": "unusable", "1": "poor", "2": "mixed", "3": "good", "4": "excellent" },
        },
      }),
    });

    await expect(adapter.scoreQuality(qualityDecision)).resolves.toMatchObject({
      status: "fallback",
      reason: "invalid_response",
    });
  });

  it("rejects a score that disagrees with a valid distribution", async () => {
    const adapter = createJevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      policy,
      fetchImpl: async () => jevResponse({
        quality: {
          type: "score",
          score: 3.5,
          confidence: 0.7,
          probabilities: { "0": 0.02, "1": 0.03, "2": 0.05, "3": 0.7, "4": 0.2 },
          legend: { "0": "unusable", "1": "poor", "2": "mixed", "3": "good", "4": "excellent" },
        },
      }),
    });

    await expect(adapter.scoreQuality(qualityDecision)).resolves.toMatchObject({
      status: "fallback",
      reason: "invalid_response",
    });
  });

  it("falls back when a choice is outside the host-computed pool", async () => {
    const adapter = createJevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      policy,
      fetchImpl: async () => jevResponse({
        selection: {
          type: "choice",
          choice: "candidate_not_allowed",
          confidence: 1,
          probabilities: { candidate_not_allowed: 1 },
        },
      }),
    });

    await expect(adapter.match(matchDecision)).resolves.toMatchObject({
      status: "fallback",
      reason: "out_of_pool",
    });
  });

  it("keeps direct uncalibrated shadow decisions closed unless explicitly observation-only", async () => {
    let calls = 0;
    const adapter = createJevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      policy: { ...policy, mode: "shadow" },
      fetchImpl: async () => {
        calls += 1;
        return jevResponse({});
      },
    });

    await expect(adapter.match(matchDecision)).resolves.toMatchObject({ status: "fallback", reason: "uncalibrated" });
    expect(calls).toBe(0);
  });

  it("observes valid shadow results before calibration in explicit observation-only mode", async () => {
    let calls = 0;
    const adapter = createJevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      policy: { ...policy, mode: "shadow" },
      allowUncalibratedShadowObservation: true,
      fetchImpl: async () => {
        calls += 1;
        return jevResponse({
          selection: {
            type: "choice",
            choice: "candidate_opaque_01",
            confidence: 0.99,
            probabilities: { candidate_opaque_01: 0.92, abstain: 0.08 },
          },
        });
      },
    });

    await expect(adapter.match(matchDecision)).resolves.toMatchObject({
      status: "observed",
      value: "candidate_opaque_01",
    });
    expect(calls).toBe(1);
  });

  it("falls back when calibrated shadow confidence or margin is below policy", async () => {
    const adapter = createJevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      policy: { ...policy, mode: "shadow", calibrated: true },
      fetchImpl: async () => jevResponse({
        selection: {
          type: "choice",
          choice: "candidate_opaque_01",
          confidence: 0.79,
          probabilities: { candidate_opaque_01: 0.55, abstain: 0.45 },
        },
      }),
    });

    await expect(adapter.match(matchDecision)).resolves.toMatchObject({
      status: "fallback",
      reason: "below_threshold",
    });
  });

  it("rejects a probability distribution whose selected option is not the top allowed option", async () => {
    const adapter = createJevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      policy,
      fetchImpl: async () => jevResponse({
        selection: {
          type: "choice",
          choice: "candidate_opaque_01",
          confidence: 0.99,
          probabilities: { candidate_opaque_01: 0.01, unknown_candidate: 0.99 },
        },
      }),
    });

    await expect(adapter.match(matchDecision)).resolves.toMatchObject({
      status: "fallback",
      reason: "invalid_response",
    });
  });

  it.each([
    [401, "unauthorized"],
    [429, "rate_limited"],
    [500, "server_error"],
  ] as const)("maps HTTP %i to %s without retry", async (status, reason) => {
    let calls = 0;
    const adapter = createJevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      policy,
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status });
      },
    });

    await expect(adapter.match(matchDecision)).resolves.toMatchObject({
      status: "fallback",
      reason,
    });
    expect(calls).toBe(1);
  });

  it("falls back on timeout and malformed responses", async () => {
    const timedOut = createJevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      policy,
      fetchImpl: async () => { throw new DOMException("timed out", "TimeoutError"); },
    });
    await expect(timedOut.match(matchDecision)).resolves.toMatchObject({
      status: "fallback",
      reason: "timeout",
    });

    const malformed = createJevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      policy,
      fetchImpl: async () => new Response(JSON.stringify({ answers: { selection: { choice: 42 } } })),
    });
    await expect(malformed.match(matchDecision)).resolves.toMatchObject({
      status: "fallback",
      reason: "invalid_response",
    });
  });

  it("rejects forbidden extra input before transport", async () => {
    let calls = 0;
    const adapter = createJevDecisionAdapter({
      enabled: true,
      apiKey: "test-only",
      policy,
      fetchImpl: async () => {
        calls += 1;
        return jevResponse({});
      },
    });

    await expect(adapter.match({ ...matchDecision, rawPrompt: "private" } as never)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("sends one bounded official System One request without raw identity fields", async () => {
    let capturedBody = "";
    let capturedAuthorization = "";
    const fetchImpl: JevFetch = async (input, init) => {
      expect(input).toBe("https://api.typesafe.ai/v1/systemone");
      capturedBody = String(init?.body);
      capturedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return jevResponse({
        selection: {
          type: "choice",
          choice: "candidate_opaque_01",
          confidence: 1,
          probabilities: { candidate_opaque_01: 1 },
        },
      });
    };
    const adapter = createJevDecisionAdapter({ enabled: true, apiKey: "test-only", policy, fetchImpl });

    await adapter.match(matchDecision);

    expect(capturedAuthorization).toBe("Bearer test-only");
    expect(JSON.parse(capturedBody)).toMatchObject({ model: "jev-latest" });
    expect(capturedBody).not.toMatch(/rawPrompt|wallet|\/Users\//i);
  });
});

function jevResponse(answers: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    model: "jev-test-double",
    answers,
    usage: { input_tokens: 12, output_tokens: 3 },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
