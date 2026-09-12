import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmRiskQuote, readAgentReputation, readCurrentRiskQuote, readRiskContext, requestRiskQuote } from "./riskPricingClient";
import { assertWalletSessionAuthenticated, walletSessionRevision } from "./walletSession";

vi.mock("./walletSession", () => ({
  assertWalletSessionAuthenticated: vi.fn(),
  walletSessionRevision: vi.fn(() => 0),
}));

const id = "01900000-0000-7000-8000-000000000001";
const other = "01900000-0000-7000-8000-000000000002";
const fingerprint = `sha256:${"a".repeat(64)}`;
const quoteHash = `sha256:${"b".repeat(64)}`;
const assetId = `eip155:11155111/erc20:0x${"1".repeat(40)}`;
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.mocked(assertWalletSessionAuthenticated).mockReset();
  vi.mocked(walletSessionRevision).mockReset().mockReturnValue(0);
});

describe("risk client object identity", () => {
  it.each(["context", "quote", "confirmation"] as const)("blocks %s before HTTP when local authentication is invalid", async (kind) => {
    vi.mocked(assertWalletSessionAuthenticated).mockImplementation(() => { throw new Error("AUTH_REAUTH_REQUIRED"); });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const operation = kind === "context" ? readRiskContext(id)
      : kind === "quote" ? requestRiskQuote(id, fingerprint)
      : confirmRiskQuote(id, other, fingerprint, quoteHash);
    await expect(operation).rejects.toThrow("AUTH_REAUTH_REQUIRED");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["response", "body"] as const)("rejects an old context after session changes during %s", async (stage) => {
    const body = { activeQuote: { quoteId: other, version: 1, quoteHash }, taskId: id, taskFingerprint: fingerprint, phase: "final", dagRevision: 1, quoteStatus: "confirmed", requestId: id, assetId, quoteSchemaVersion: 2 };
    const response = Response.json(body);
    if (stage === "body") vi.spyOn(response, "json").mockImplementation(async () => {
      vi.mocked(walletSessionRevision).mockReturnValue(1);
      return body;
    });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      if (stage === "response") vi.mocked(walletSessionRevision).mockReturnValue(1);
      return response;
    }));
    await expect(readRiskContext(id)).rejects.toThrow("AUTH_WALLET_CHANGED");
  });

  it("keeps public reputation independent from wallet authentication", async () => {
    vi.mocked(assertWalletSessionAuthenticated).mockImplementation(() => { throw new Error("AUTH_REAUTH_REQUIRED"); });
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: "REPUTATION_UNAVAILABLE" }, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(readAgentReputation(id)).rejects.toThrow("REPUTATION_UNAVAILABLE");
    expect(assertWalletSessionAuthenticated).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["", "fixture-task", "../another-task"])("rejects invalid task ID %s before writes", async (taskId) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(requestRiskQuote(taskId, fingerprint)).rejects.toThrow("RISK_TASK_ID_INVALID");
    await expect(confirmRiskQuote(taskId, id, fingerprint, quoteHash)).rejects.toThrow("RISK_TASK_ID_INVALID");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends only the three server-bound confirmation fields", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ confirmation: { quoteId: other, actorType: "publisher", agentId: null }, requestId: id }));
    vi.stubGlobal("fetch", fetch);
    await confirmRiskQuote(id, other, fingerprint, quoteHash);
    const call = fetch.mock.calls.at(0);
    if (!call) throw new Error("EXPECTED_CONFIRMATION_REQUEST");
    const options = call[1];
    if (!options) throw new Error("EXPECTED_CONFIRMATION_OPTIONS");
    expect(JSON.parse(options.body)).toEqual({ quoteId: other, taskFingerprint: fingerprint, quoteHash });
    expect(options.credentials).toBe("include");
  });

  it.each(["", "sha256:wrong", "0x123"])("rejects malformed confirmation hash %s before writing", async (hash) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(confirmRiskQuote(id, other, fingerprint, hash)).rejects.toThrow("RISK_QUOTE_HASH_INVALID");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([assetId, "YD", `eip155:11155111/erc20:0x${"0".repeat(40)}`])("validates context asset identity %s", async (returnedAsset) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ activeQuote: { quoteId: other, version: 1, quoteHash }, taskId: id, taskFingerprint: fingerprint, phase: "final", dagRevision: 1, quoteStatus: "active", requestId: id, assetId: returnedAsset, quoteSchemaVersion: 2 })));
    if (returnedAsset === assetId) await expect(readRiskContext(id)).resolves.toMatchObject({ assetId, quoteSchemaVersion: 2 });
    else await expect(readRiskContext(id)).rejects.toThrow("RISK_API_RESPONSE_INVALID");
  });

  it("reads an absent quote using GET without triggering creation", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ context: { activeQuote: null, taskId: id, taskFingerprint: fingerprint, phase: "final", dagRevision: 1, quoteStatus: "not_issued", assetId, quoteSchemaVersion: 2 }, quote: null, requestId: id }));
    vi.stubGlobal("fetch", fetch);
    await expect(readCurrentRiskQuote(id)).resolves.toMatchObject({ record: null, context: { activeQuote: null, requestId: id } });
    expect(fetch).toHaveBeenCalledWith(`/api/tasks/${id}/risk-quote`, expect.objectContaining({ method: "GET", credentials: "include" }));
    expect(fetch).toHaveBeenCalledOnce();
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
