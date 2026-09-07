import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirmCurrentRiskQuote, loadCurrentRiskQuote, refreshCurrentRiskQuote } from "./riskQuoteFlow";
import { confirmRiskQuote, readRiskContext, requestRiskQuote, type BrowserRiskQuote } from "./riskPricingClient";

vi.mock("./riskPricingClient", () => ({
  readRiskContext: vi.fn(), requestRiskQuote: vi.fn(), confirmRiskQuote: vi.fn(),
}));

const taskId = "11111111-1111-4111-8111-111111111111";
const quoteId = "22222222-2222-4222-8222-222222222222";
const fingerprint = `sha256:${"a".repeat(64)}`;
const context = {
  taskId, taskFingerprint: fingerprint, phase: "final" as const,
  dagRevision: 2, quoteStatus: "active" as const, requestId: taskId,
};
const record: BrowserRiskQuote = {
  quoteId, version: 1, requestId: taskId,
  quote: {
    phase: "final", policyVersion: "risk-pricing-v2", taskFingerprint: fingerprint,
    riskScore: 40, riskTier: "R2", depositRateBps: 1000, serviceFeeBps: 600,
    manualReviewRequired: false, reasonCodes: [], P: "1000", A: "100", B: "60",
    publisherTotal: "1160", agentTeamDeposit: "100",
    agentAllocations: [{ agentId: taskId, amountAtomic: "100" }],
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readRiskContext).mockResolvedValue(context);
  vi.mocked(requestRiskQuote).mockResolvedValue(record);
  vi.mocked(confirmRiskQuote).mockResolvedValue({ quoteId, actorType: "publisher", agentId: null });
});

describe("authoritative risk quote flow", () => {
  it("refreshes final readiness without resubmitting a confirmation", async () => {
    vi.mocked(readRiskContext).mockResolvedValue({ ...context, quoteStatus: "confirmed" });
    await expect(refreshCurrentRiskQuote(taskId, record)).resolves.toMatchObject({ fundingContext: { quoteId, taskFingerprint: fingerprint } });
    expect(confirmRiskQuote).not.toHaveBeenCalled();
    expect(requestRiskQuote).not.toHaveBeenCalled();
  });
  it("does not expose funding context for manual review", async () => {
    vi.mocked(readRiskContext).mockResolvedValue({ ...context, quoteStatus: "manual_review" });
    await expect(refreshCurrentRiskQuote(taskId, record)).resolves.toMatchObject({ fundingContext: null });
  });
  it("rejects an expired quote even when the server reports confirmed", async () => {
    vi.mocked(readRiskContext).mockResolvedValue({ ...context, quoteStatus: "confirmed" });
    await expect(refreshCurrentRiskQuote(taskId, { ...record, quote: { ...record.quote, expiresAt: "2000-01-01T00:00:00.000Z" } })).rejects.toThrow("RISK_QUOTE_CONTEXT_CHANGED");
  });
  it("requests a quote using only the freshly read task fingerprint", async () => {
    await expect(loadCurrentRiskQuote(taskId)).resolves.toEqual(record);
    expect(requestRiskQuote).toHaveBeenCalledWith(taskId, fingerprint);
  });
  it("does not request a quote when authoritative context is unavailable", async () => {
    vi.mocked(readRiskContext).mockRejectedValue(new Error("UNAVAILABLE"));
    await expect(loadCurrentRiskQuote(taskId)).rejects.toThrow("UNAVAILABLE");
    expect(requestRiskQuote).not.toHaveBeenCalled();
  });
  it("rejects a response for a different task fingerprint", async () => {
    vi.mocked(requestRiskQuote).mockResolvedValue({ ...record, quote: { ...record.quote, taskFingerprint: `sha256:${"b".repeat(64)}` } });
    await expect(loadCurrentRiskQuote(taskId)).rejects.toThrow("RISK_QUOTE_CONTEXT_CHANGED");
  });
  it("never treats a single confirmation response as funding readiness", async () => {
    const result = await confirmCurrentRiskQuote(taskId, record);
    expect(result.fundingContext).toBeNull();
    expect(readRiskContext).toHaveBeenCalledTimes(2);
  });
  it("exposes funding context only after final confirmed server readback", async () => {
    vi.mocked(readRiskContext).mockResolvedValueOnce(context).mockResolvedValueOnce({ ...context, quoteStatus: "confirmed" });
    await expect(confirmCurrentRiskQuote(taskId, record)).resolves.toMatchObject({ fundingContext: { quoteId, taskFingerprint: fingerprint } });
  });
  it("keeps a confirmed preliminary quote out of funding", async () => {
    vi.mocked(readRiskContext).mockResolvedValue({ ...context, phase: "preliminary", quoteStatus: "confirmed" });
    await expect(confirmCurrentRiskQuote(taskId, { ...record, quote: { ...record.quote, phase: "preliminary" } })).resolves.toMatchObject({ fundingContext: null });
  });
  it("does not submit an expired quote", async () => {
    await expect(confirmCurrentRiskQuote(taskId, { ...record, quote: { ...record.quote, expiresAt: "2000-01-01T00:00:00.000Z" } })).rejects.toThrow("RISK_QUOTE_CONTEXT_CHANGED");
    expect(confirmRiskQuote).not.toHaveBeenCalled();
  });
  it("rejects a task change during confirmation", async () => {
    vi.mocked(readRiskContext).mockResolvedValueOnce(context).mockResolvedValueOnce({ ...context, taskFingerprint: `sha256:${"b".repeat(64)}` });
    await expect(confirmCurrentRiskQuote(taskId, record)).rejects.toThrow("RISK_QUOTE_CONTEXT_CHANGED");
  });
});
