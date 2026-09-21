import { describe, expect, it } from "vitest";

import {
  AgentMatchDecisionV1Schema,
  AgentQualityDecisionV1Schema,
  DisputeRouteDecisionV1Schema,
  EligibilityDecisionV1Schema,
  JevDecisionEvidenceV1Schema,
  JevThresholdPolicyV1Schema,
} from "./jev-decisions";

const hash = "a".repeat(64);

describe("Jev decision contracts", () => {
  it("accepts an allowlisted match snapshot with opaque candidates", () => {
    const decision = AgentMatchDecisionV1Schema.parse({
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
    });

    expect(decision.candidates[0]?.candidateRef).toBe("candidate_opaque_01");
  });

  it("rejects extra raw prompt and local-path fields", () => {
    const base = {
      schemaVersion: 1,
      decisionType: "agent_match",
      decisionId: "decision_match_01",
      taskRefHmac: hash,
      requiredCapabilityCodes: ["typescript"],
      candidates: [],
    };

    expect(() => AgentMatchDecisionV1Schema.parse({ ...base, rawPrompt: "private" })).toThrow();
    expect(() => AgentMatchDecisionV1Schema.parse({ ...base, localPath: "/Users/example/repo" })).toThrow();
  });

  it("keeps implemented and required eligibility gates distinct", () => {
    expect(EligibilityDecisionV1Schema.parse({
      schemaVersion: 1,
      decisionType: "eligibility",
      decisionId: "eligibility_01",
      candidateRef: "candidate_opaque_01",
      passedImplementedGates: true,
      passedAllRequiredGates: false,
      implementedGateCodes: ["capability", "availability"],
      missingRequiredGateCodes: ["permission_boundary"],
    }).passedAllRequiredGates).toBe(false);

    expect(() => EligibilityDecisionV1Schema.parse({
      schemaVersion: 1,
      decisionType: "eligibility",
      decisionId: "eligibility_02",
      candidateRef: "candidate_opaque_02",
      passedImplementedGates: false,
      passedAllRequiredGates: true,
      implementedGateCodes: [],
      missingRequiredGateCodes: [],
    })).toThrow();
  });

  it("accepts quality evidence without output or identity fields", () => {
    const decision = AgentQualityDecisionV1Schema.parse({
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
    });

    expect(decision.completionStatus).toBe("completed");
    expect(() => AgentQualityDecisionV1Schema.parse({ ...decision, rawOutput: "secret" })).toThrow();
  });

  it("limits dispute choices to existing AI workflow routes", () => {
    const decision = DisputeRouteDecisionV1Schema.parse({
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
    });

    expect(decision.permittedRoutes).not.toContain("platform_arbiter_human_review");
    expect(() => DisputeRouteDecisionV1Schema.parse({
      ...decision,
      permittedRoutes: ["onchain_resolution_transaction"],
    })).toThrow();
  });

  it("requires explicit uncalibrated synthetic policy and typed evidence", () => {
    const policy = JevThresholdPolicyV1Schema.parse({
      schemaVersion: 1,
      policyVersion: "jev_policy_v1_synthetic",
      mode: "synthetic-only",
      calibrated: false,
      match: { minConfidence: 0.8, minMargin: 0.2 },
      quality: { minConfidence: 0.8, minMargin: 0.2 },
      dispute: { minConfidence: 0.9, minMargin: 0.3 },
    });
    expect(policy.calibrated).toBe(false);

    const evidence = JevDecisionEvidenceV1Schema.parse({
      schemaVersion: 1,
      decisionType: "agent_match",
      decisionId: "decision_match_01",
      correlationHmac: hash,
      inputShapeHmac: "b".repeat(64),
      policyVersion: policy.policyVersion,
      modelVersion: "jev-test-double",
      status: "observed",
      resultRefHash: "c".repeat(64),
      confidence: 0.91,
      margin: 0.42,
      latencyMs: 7,
      usage: { inputTokens: 12, outputTokens: 2 },
    });
    expect(evidence.status).toBe("observed");

    expect(() => JevDecisionEvidenceV1Schema.parse({
      schemaVersion: 1,
      decisionType: "agent_match",
      decisionId: "decision_match_01",
      correlationHmac: hash,
      inputShapeHmac: "b".repeat(64),
      policyVersion: policy.policyVersion,
      modelVersion: "jev-test-double",
      status: "observed",
      latencyMs: 7,
      usage: { inputTokens: 12, outputTokens: 2 },
    })).toThrow();

    expect(() => JevDecisionEvidenceV1Schema.parse({
      schemaVersion: 1,
      decisionType: "agent_match",
      decisionId: "decision_match_01",
      correlationHmac: hash,
      inputShapeHmac: "b".repeat(64),
      policyVersion: policy.policyVersion,
      modelVersion: "not-called",
      status: "fallback",
      fallbackReason: "disabled",
      resultRefHash: "c".repeat(64),
      confidence: 1,
      margin: 1,
      latencyMs: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    })).toThrow();
  });
});
