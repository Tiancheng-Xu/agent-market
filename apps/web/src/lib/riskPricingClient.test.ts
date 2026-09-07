import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmRiskQuote, readAgentReputation, requestRiskQuote } from "./riskPricingClient";

const id = "01900000-0000-7000-8000-000000000001";
const other = "01900000-0000-7000-8000-000000000002";
const fingerprint = `sha256:${"a".repeat(64)}`;
afterEach(() => vi.unstubAllGlobals());

describe("risk client object identity", () => {
  it.each(["", "fixture-task", "../another-task"])("rejects invalid task ID %s before writes", async (taskId) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(requestRiskQuote(taskId, fingerprint)).rejects.toThrow("RISK_TASK_ID_INVALID");
    await expect(confirmRiskQuote(taskId, id, fingerprint)).rejects.toThrow("RISK_TASK_ID_INVALID");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([id, other])("binds a valid reputation snapshot to the requested Agent: %s", async (returnedId) => {
    const reputation = {
      agentId: returnedId, score: 30, rawScore: 30,
      dimensions: { deliveryReliability: 0, qualityFeedback: 0, communicationExperience: 0, disputeOutcome: 0, experience: 0 },
      sampleCount: 0, effectiveSampleWeight: 0, confidenceValue: 0, confidence: "low",
      acceptanceRate: 0, refundRate: 0, disputeRate: 0,
      windowDays: 90, maxEvents: 20, halfLifeDays: 30, priorScore: 30,
      formulaVersion: "reputation-v2", calculatedAt: "2026-09-04T00:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ reputation, requestId: id }))));
    if (returnedId === id) await expect(readAgentReputation(id)).resolves.toEqual(reputation);
    else await expect(readAgentReputation(id)).rejects.toThrow("RISK_API_RESPONSE_INVALID");
  });
});
