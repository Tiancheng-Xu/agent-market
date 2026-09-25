import { describe, expect, it } from "vitest";

import {
  probabilityMargin,
  validateChoiceAnswer,
  validateScoreAnswer,
  type SystemOneDecisionResult,
} from "./system-one-decision-provider";

describe("System-One decision provider contract", () => {
  it("represents a fractional observed score without provider-specific fields", () => {
    const observed: SystemOneDecisionResult = {
      status: "observed",
      provider: "laya",
      decisionType: "agent_quality",
      decisionId: "quality_01",
      value: 3.183,
      confidence: 0.369,
      probabilities: { "0": 0.0247, "1": 0.0395, "2": 0.0272, "3": 0.5453, "4": 0.3633 },
      margin: 0.182,
      model: "laya@68f27dfe",
      usage: { inputTokens: 109 },
      latencyMs: 99,
    };

    expect(observed.value).toBe(3.183);
  });

  it("rejects a choice outside the host-computed pool", () => {
    expect(validateChoiceAnswer(
      { candidate_allowed: 0.2, candidate_outside: 0.8 },
      new Set(["candidate_allowed"]),
      "candidate_outside",
    )).toBe(false);
  });

  it("accepts a fractional expected score with a complete distribution", () => {
    expect(validateScoreAnswer(
      { "0": 0.0247, "1": 0.0395, "2": 0.0272, "3": 0.5453, "4": 0.3633 },
      3.183,
    )).toBe(true);
  });

  it("rejects a score that does not match the distribution's expected value", () => {
    expect(validateScoreAnswer(
      { "0": 0.02, "1": 0.03, "2": 0.05, "3": 0.7, "4": 0.2 },
      3.5,
    )).toBe(false);
  });

  it("normalizes a rounded probability total before comparing the expected score", () => {
    const probabilities = { "0": 0, "1": 0, "2": 0, "3": 0.495, "4": 0.495 };

    expect(validateScoreAnswer(probabilities, 3.5)).toBe(true);
    expect(validateScoreAnswer(probabilities, 3.47)).toBe(false);

    const fiveLevelProbabilities = { "0": 0, "1": 0.059, "2": 0.47, "3": 0.172, "4": 0.289 };
    expect(validateScoreAnswer(fiveLevelProbabilities, 2.699)).toBe(true);
    expect(validateScoreAnswer(fiveLevelProbabilities, 2.67)).toBe(false);
  });

  it("computes the top-two probability margin", () => {
    expect(probabilityMargin({ first: 0.63, second: 0.21, third: 0.16 })).toBeCloseTo(0.42);
  });
});
