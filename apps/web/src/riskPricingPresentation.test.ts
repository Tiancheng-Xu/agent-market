import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ReputationSnapshot,
  RiskAssessment,
  RiskQuote,
} from "@agent-market/shared-contracts";
import { describe, expect, it, vi } from "vitest";

import { ReputationV2Panel } from "./components/ReputationV2Panel";
import { RiskQuotePanel } from "./components/RiskQuotePanel";
import {
  createQuoteConfirmationIntent,
  presentReputationV2,
  presentRiskQuote,
  type RiskQuoteViewModel,
} from "./riskPricingPresentation";

const fingerprint = `sha256:${"a".repeat(64)}`;

const assessment: RiskAssessment = {
  factors: {
    complexity: 94,
    acceptanceAmbiguity: 88,
    externalDependency: 82,
    dataSensitivity: 91,
    financialRisk: 96,
    irreversibility: 90,
    deadlineRisk: 74,
    agentUncertainty: 86,
  },
  reasonCodes: ["high_value_settlement", "irreversible_external_action"],
  riskScore: 90,
  riskTier: "R5",
  depositRateBps: 4_000,
  manualReviewRequired: true,
};

const quote: RiskQuote = {
  phase: "final",
  policyVersion: "risk-policy-v2",
  taskFingerprint: fingerprint,
  riskScore: 90,
  riskTier: "R5",
  depositRateBps: 4_000,
  serviceFeeBps: 600,
  manualReviewRequired: true,
  reasonCodes: assessment.reasonCodes,
  P: "1000",
  A: "400",
  B: "60",
  publisherTotal: "1460",
  agentTeamDeposit: "400",
  agentAllocations: [
    { agentId: "agent-alpha", amountAtomic: "240" },
    { agentId: "agent-beta", amountAtomic: "160" },
  ],
  expiresAt: "2026-09-01T13:00:00.000Z",
};

const quoteView: RiskQuoteViewModel = {
  ...quote,
  quoteId: "quote-risk-001",
  manualApprovedAt: null,
};

const reputation: ReputationSnapshot = {
  agentId: "11111111-1111-4111-8111-111111111111",
  score: 78.4,
  rawScore: 86.2,
  dimensions: {
    deliveryReliability: 92,
    qualityFeedback: 88,
    communicationExperience: 76,
    disputeOutcome: 81,
    experience: 70,
  },
  sampleCount: 12,
  effectiveSampleWeight: 8.4,
  confidenceValue: 12 / 22,
  confidence: "medium",
  acceptanceRate: 0.83,
  refundRate: 0.08,
  disputeRate: 0.09,
  windowDays: 90,
  maxEvents: 20,
  halfLifeDays: 30,
  priorScore: 30,
  formulaVersion: "reputation-v2",
  calculatedAt: "2026-09-01T12:00:00.000Z",
};

describe("risk pricing presentation", () => {
  it("shows all eight assessed factors and exact P/A/B atomic amounts", () => {
    const view = presentRiskQuote(quoteView, assessment, "en", "2026-09-01T12:00:00.000Z");

    expect(view.factors).toHaveLength(8);
    expect(view.money).toMatchObject({
      P: "1,000 atomic",
      A: "400 atomic",
      B: "60 atomic",
      publisherTotal: "1,460 atomic",
      agentTeamDeposit: "400 atomic",
    });
    expect(view.agentAllocations).toEqual([
      { agentId: "agent-alpha", amount: "240 atomic" },
      { agentId: "agent-beta", amount: "160 atomic" },
    ]);
    expect(view.phase).toBe("FINAL");
    expect(view.policyVersion).toBe("risk-policy-v2");
  });

  it("never marks an unapproved R5 quote ready", () => {
    const markup = renderToStaticMarkup(createElement(RiskQuotePanel, {
      assessment,
      locale: "en",
      now: "2026-09-01T12:00:00.000Z",
      onConfirmIntent: vi.fn(),
      quote: quoteView,
    }));

    expect(markup).toContain("MANUAL REVIEW REQUIRED");
    expect(markup).not.toContain(">READY<");
    expect(markup).toContain("disabled");
  });

  it("allows an unexpired R1-R4 preliminary acknowledgement without marking funding ready", () => {
    const preliminaryAssessment: RiskAssessment = {
      ...assessment,
      riskScore: 50,
      riskTier: "R3",
      depositRateBps: 1_500,
      manualReviewRequired: false,
    };
    const preliminaryQuote: RiskQuoteViewModel = {
      ...quoteView,
      phase: "preliminary",
      riskScore: 50,
      riskTier: "R3",
      depositRateBps: 1_500,
      manualReviewRequired: false,
      A: "150",
      publisherTotal: "1210",
      agentTeamDeposit: "150",
      agentAllocations: [],
    };
    const view = presentRiskQuote(
      preliminaryQuote,
      preliminaryAssessment,
      "en",
      "2026-09-01T12:00:00.000Z",
    );
    expect(view.status).toBe("preliminary");
    expect(view.confirmable).toBe(true);
    expect(view.fundingReady).toBe(false);
  });

  it("blocks expired quotes and labels yield as simulation only", () => {
    const view = presentRiskQuote(quoteView, assessment, "en", "2026-09-01T14:00:00.000Z");
    const markup = renderToStaticMarkup(createElement(RiskQuotePanel, {
      assessment,
      locale: "en",
      now: "2026-09-01T14:00:00.000Z",
      quote: quoteView,
    }));

    expect(view.status).toBe("expired");
    expect(view.ready).toBe(false);
    expect(markup).toContain("SIMULATION_ONLY");
    expect(markup).toContain("EXPIRED");
    expect(markup).not.toMatch(/guaranteed|real yield|actual return/iu);
  });

  it("emits only the quote identifier and task fingerprint", () => {
    expect(createQuoteConfirmationIntent(quoteView)).toEqual({
      quoteId: "quote-risk-001",
      taskFingerprint: fingerprint,
    });
  });

  it("rejects a quote whose assessment does not match", () => {
    expect(() => presentRiskQuote(
      quoteView,
      { ...assessment, riskScore: 89 },
      "en",
      "2026-09-01T12:00:00.000Z",
    )).toThrow("RISK_QUOTE_ASSESSMENT_MISMATCH");
  });
});

describe("Reputation V2 presentation", () => {
  it("renders five dimensions and the bounded confidence contract", () => {
    const markup = renderToStaticMarkup(createElement(ReputationV2Panel, {
      locale: "zh-CN",
      snapshot: reputation,
    }));

    expect(markup).toContain("78.4");
    expect(markup).toContain("n=12");
    expect(markup).toContain("90 天");
    expect(markup).toContain("20 个事件");
    expect(markup).toContain("30 天半衰期");
    expect(markup).toContain("交付可靠性");
    expect(markup).toContain("质量反馈");
    expect(markup).toContain("沟通体验");
    expect(markup).toContain("争议结果");
    expect(markup).toContain("历史经验");
  });

  it("does not expose identity and rejects extra private review fields", () => {
    const view = presentReputationV2(reputation, "en");
    const markup = renderToStaticMarkup(createElement(ReputationV2Panel, {
      locale: "en",
      snapshot: reputation,
    }));
    const privateSnapshot = {
      ...reputation,
      reviewerWallet: "0x1111111111111111111111111111111111111111",
      rawEvents: [{ privatePrompt: "secret" }],
    } as unknown as ReputationSnapshot;

    expect(view).not.toHaveProperty("agentId");
    expect(markup).not.toContain(reputation.agentId);
    expect(markup).not.toMatch(/wallet|privatePrompt|rawEvents/iu);
    expect(() => presentReputationV2(privateSnapshot, "en")).toThrow();
  });
});
