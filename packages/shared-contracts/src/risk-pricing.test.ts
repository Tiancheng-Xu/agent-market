import { describe, expect, it } from "vitest";

import {
  RiskAssessorResultSchema,
  RiskQuoteRequestSchema,
  RiskQuoteSchema,
} from "./risk-pricing";

const zeroFactors = {
  complexity: 0,
  acceptanceAmbiguity: 0,
  externalDependency: 0,
  dataSensitivity: 0,
  financialRisk: 0,
  irreversibility: 0,
  deadlineRisk: 0,
  agentUncertainty: 0,
};

describe("risk pricing contracts", () => {
  it("limits the Risk Assessor to factors and reason codes", () => {
    expect(
      RiskAssessorResultSchema.parse({
        factors: zeroFactors,
        reasonCodes: ["low_complexity"],
      }),
    ).toEqual({ factors: zeroFactors, reasonCodes: ["low_complexity"] });

    expect(() =>
      RiskAssessorResultSchema.parse({
        factors: zeroFactors,
        reasonCodes: ["low_complexity"],
        depositRateBps: 500,
      }),
    ).toThrow();
  });

  it("rejects browser-supplied rates and deposits", () => {
    const request = {
      taskFingerprint: `sha256:${"a".repeat(64)}`,
    };
    expect(RiskQuoteRequestSchema.parse(request)).toEqual(request);
    expect(() => RiskQuoteRequestSchema.parse({ ...request, depositRateBps: 500 })).toThrow();
    expect(() => RiskQuoteRequestSchema.parse({ ...request, A: "500" })).toThrow();
  });

  it("enforces exact quote money and allocation invariants", () => {
    const finalQuote = {
      phase: "final",
      policyVersion: "risk-pricing-v1",
      taskFingerprint: `sha256:${"b".repeat(64)}`,
      riskScore: 40,
      riskTier: "R2",
      depositRateBps: 1_000,
      serviceFeeBps: 600,
      manualReviewRequired: false,
      reasonCodes: ["external_dependency"],
      P: "1000",
      A: "100",
      B: "60",
      publisherTotal: "1160",
      agentTeamDeposit: "100",
      agentAllocations: [
        { agentId: "agent-a", amountAtomic: "67" },
        { agentId: "agent-b", amountAtomic: "33" },
      ],
      expiresAt: "2026-09-02T12:00:00.000Z",
    };

    expect(RiskQuoteSchema.parse(finalQuote)).toEqual(finalQuote);
    expect(() => RiskQuoteSchema.parse({ ...finalQuote, publisherTotal: "1159" })).toThrow();
    expect(() => RiskQuoteSchema.parse({ ...finalQuote, agentTeamDeposit: "99" })).toThrow();
    expect(() =>
      RiskQuoteSchema.parse({
        ...finalQuote,
        agentAllocations: [{ agentId: "agent-a", amountAtomic: "99" }],
      }),
    ).toThrow();
    expect(() => RiskQuoteSchema.parse({ ...finalQuote, A: "100.0" })).toThrow();
    expect(() => RiskQuoteSchema.parse({ ...finalQuote, B: "060" })).toThrow();
  });

  it("requires R5 manual review and keeps preliminary quotes unallocated", () => {
    const base = {
      phase: "preliminary",
      policyVersion: "risk-pricing-v1",
      taskFingerprint: `sha256:${"c".repeat(64)}`,
      riskScore: 81,
      riskTier: "R5",
      depositRateBps: 4_000,
      serviceFeeBps: 600,
      manualReviewRequired: true,
      reasonCodes: ["financial_risk"],
      P: "1000",
      A: "400",
      B: "60",
      publisherTotal: "1460",
      agentTeamDeposit: "400",
      agentAllocations: [],
      expiresAt: "2026-09-02T12:00:00.000Z",
    };

    expect(RiskQuoteSchema.parse(base)).toEqual(base);
    expect(() => RiskQuoteSchema.parse({ ...base, manualReviewRequired: false })).toThrow();
    expect(() =>
      RiskQuoteSchema.parse({
        ...base,
        agentAllocations: [{ agentId: "agent-a", amountAtomic: "400" }],
      }),
    ).toThrow();
  });
});
