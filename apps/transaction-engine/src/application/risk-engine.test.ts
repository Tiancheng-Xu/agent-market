import { describe, expect, it } from "vitest";

import {
  allocateAgentTeamDeposit,
  assessRisk,
  createRiskQuote,
  riskPolicyForScore,
} from "./risk-engine";

const factors = (overrides: Partial<Parameters<typeof assessRisk>[0]["factors"]> = {}) => ({
  complexity: 0,
  acceptanceAmbiguity: 0,
  externalDependency: 0,
  dataSensitivity: 0,
  financialRisk: 0,
  irreversibility: 0,
  deadlineRisk: 0,
  agentUncertainty: 0,
  ...overrides,
});

describe("risk engine", () => {
  it("computes the documented weighted score", () => {
    expect(
      assessRisk({
        factors: factors({ complexity: 100, acceptanceAmbiguity: 100 }),
        reasonCodes: ["complex_task", "ambiguous_acceptance"],
      }),
    ).toEqual({
      factors: factors({ complexity: 100, acceptanceAmbiguity: 100 }),
      reasonCodes: ["complex_task", "ambiguous_acceptance"],
      riskScore: 35,
      riskTier: "R2",
      depositRateBps: 1_000,
      manualReviewRequired: false,
    });
  });

  it.each([
    [0, "R1", 500, false],
    [20, "R1", 500, false],
    [21, "R2", 1_000, false],
    [40, "R2", 1_000, false],
    [41, "R3", 1_500, false],
    [60, "R3", 1_500, false],
    [61, "R4", 2_500, false],
    [80, "R4", 2_500, false],
    [81, "R5", 4_000, true],
    [100, "R5", 4_000, true],
  ] as const)("maps score %i to %s", (riskScore, riskTier, depositRateBps, manualReviewRequired) => {
    expect(riskPolicyForScore(riskScore)).toEqual({
      riskTier,
      depositRateBps,
      manualReviewRequired,
    });
  });

  it("creates a symmetric quote with integer-only ceiling arithmetic", () => {
    const assessment = assessRisk({
      factors: factors(),
      reasonCodes: ["low_risk_baseline"],
    });
    const quote = createRiskQuote({
      phase: "preliminary",
      policyVersion: "risk-pricing-v1",
      taskFingerprint: `sha256:${"d".repeat(64)}`,
      budgetAtomic: "101",
      serviceFeeBps: 600,
      assessment,
      expiresAt: "2026-09-02T12:00:00.000Z",
    });

    expect(quote).toMatchObject({
      P: "101",
      A: "6",
      B: "7",
      publisherTotal: "114",
      agentTeamDeposit: "6",
      agentAllocations: [],
    });
  });

  it("allocates remainders deterministically and exactly", () => {
    expect(
      allocateAgentTeamDeposit("10", [
        { agentId: "agent-c", shareBps: 1, nodeRiskMultiplierBps: 10_000, reputationRiskMultiplierBps: 10_000 },
        { agentId: "agent-a", shareBps: 1, nodeRiskMultiplierBps: 10_000, reputationRiskMultiplierBps: 10_000 },
        { agentId: "agent-b", shareBps: 1, nodeRiskMultiplierBps: 10_000, reputationRiskMultiplierBps: 10_000 },
      ]),
    ).toEqual([
      { agentId: "agent-a", amountAtomic: "4" },
      { agentId: "agent-b", amountAtomic: "3" },
      { agentId: "agent-c", amountAtomic: "3" },
    ]);
  });

  it("aggregates duplicate Agent nodes before allocating the team deposit", () => {
    expect(
      allocateAgentTeamDeposit("10", [
        { agentId: "agent-a", shareBps: 2_500, nodeRiskMultiplierBps: 10_000, reputationRiskMultiplierBps: 10_000 },
        { agentId: "agent-b", shareBps: 5_000, nodeRiskMultiplierBps: 10_000, reputationRiskMultiplierBps: 10_000 },
        { agentId: "agent-a", shareBps: 2_500, nodeRiskMultiplierBps: 10_000, reputationRiskMultiplierBps: 10_000 },
      ]),
    ).toEqual([
      { agentId: "agent-a", amountAtomic: "5" },
      { agentId: "agent-b", amountAtomic: "5" },
    ]);
  });

  it("uses share and both risk multipliers in allocation weight", () => {
    expect(
      allocateAgentTeamDeposit("12", [
        { agentId: "agent-a", shareBps: 5_000, nodeRiskMultiplierBps: 20_000, reputationRiskMultiplierBps: 10_000 },
        { agentId: "agent-b", shareBps: 5_000, nodeRiskMultiplierBps: 10_000, reputationRiskMultiplierBps: 10_000 },
      ]),
    ).toEqual([
      { agentId: "agent-a", amountAtomic: "8" },
      { agentId: "agent-b", amountAtomic: "4" },
    ]);
  });

  it("creates a final quote whose aggregated allocations equal A", () => {
    const assessment = assessRisk({
      factors: factors({ financialRisk: 100, dataSensitivity: 40 }),
      reasonCodes: ["financial_risk", "sensitive_data"],
    });
    const quote = createRiskQuote({
      phase: "final",
      policyVersion: "risk-pricing-v1",
      taskFingerprint: `sha256:${"e".repeat(64)}`,
      budgetAtomic: "1000",
      serviceFeeBps: 600,
      assessment,
      expiresAt: "2026-09-02T12:00:00.000Z",
      agentNodes: [
        { agentId: "agent-a", shareBps: 6_000, nodeRiskMultiplierBps: 10_000, reputationRiskMultiplierBps: 10_000 },
        { agentId: "agent-b", shareBps: 4_000, nodeRiskMultiplierBps: 10_000, reputationRiskMultiplierBps: 10_000 },
      ],
    });

    expect(quote).toMatchObject({
      riskScore: 21,
      riskTier: "R2",
      A: "100",
      agentTeamDeposit: "100",
      agentAllocations: [
        { agentId: "agent-a", amountAtomic: "60" },
        { agentId: "agent-b", amountAtomic: "40" },
      ],
    });
  });
});
