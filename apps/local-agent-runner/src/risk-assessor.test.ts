import { describe, expect, it, vi } from "vitest";

import {
  assessTaskRisk,
  assessTaskRiskWithFallback,
  conservativeRiskFallback,
  type RiskAssessorExecutionRequest,
} from "./risk-assessor";

const input = {
  taskId: "11111111-1111-4111-8111-111111111111",
  title: "Review a deployment",
  description: "Review a multi-agent deployment with a payment boundary.",
  requirements: ["Do not expose credentials"],
  declaredPermissions: ["read:repository"],
  durationHours: 12,
  dependencyClasses: ["provider-api"],
};

const factors = {
  complexity: 60,
  acceptanceAmbiguity: 30,
  externalDependency: 60,
  dataSensitivity: 40,
  financialRisk: 70,
  irreversibility: 50,
  deadlineRisk: 50,
  agentUncertainty: 40,
};

describe("Risk Assessor", () => {
  it("returns all eight factors without monetary authority", async () => {
    const execute = vi.fn(async (_request: RiskAssessorExecutionRequest) =>
      JSON.stringify({ factors, reasonCodes: ["external_payment_boundary"] }));
    const result = await assessTaskRisk(input, execute);
    expect(result).toEqual({ factors, reasonCodes: ["external_payment_boundary"] });
    expect(result).not.toHaveProperty("depositRateBps");
    expect(result).not.toHaveProperty("riskTier");
    expect(execute.mock.calls[0]?.[0].role).toBe("risk_assessor");
  });

  it("fails closed on malformed or assessor-controlled output", async () => {
    await expect(assessTaskRisk(input, async () => "not-json")).rejects.toThrow("RISK_ASSESSMENT_INVALID");
    await expect(assessTaskRisk(input, async () => JSON.stringify({
      factors,
      reasonCodes: ["external_payment_boundary"],
      depositRateBps: 1,
    }))).rejects.toThrow("RISK_ASSESSMENT_INVALID");
  });

  it("redacts private material before the model boundary", async () => {
    const execute = vi.fn(async (_request: RiskAssessorExecutionRequest) =>
      JSON.stringify({ factors, reasonCodes: ["sensitive_input_redacted"] }));
    await assessTaskRisk({
      ...input,
      description: "Use sk-secret12345678 from /Users/private/project/config",
    }, execute);
    const prompt = execute.mock.calls[0]?.[0].messages[1]?.content ?? "";
    expect(prompt).toContain("[redacted-secret]");
    expect(prompt).toContain("[redacted-local-path]");
    expect(prompt).not.toContain("sk-secret12345678");
  });

  it("uses a conservative deterministic fallback that cannot silently return R1", async () => {
    const first = conservativeRiskFallback(input);
    const second = await assessTaskRiskWithFallback(input, async () => "offline");
    expect(second).toEqual(first);
    expect(Object.values(first.factors).every((score) => score >= 30)).toBe(true);
    expect(first.reasonCodes).toEqual(["assessor_unavailable_conservative_fallback"]);
  });
});
