import { describe, expect, it, vi } from "vitest";

import type { ReputationReview, RiskAssessorResult } from "@agent-market/shared-contracts";
import { MemoryReputationStore } from "./reputation-service";
import { MemoryRiskQuoteStore } from "./risk-quote-store";
import {
  RiskPricingService,
  fingerprintRiskTask,
  type AuthoritativeRiskTask,
  type RiskAssessorClient,
  type RiskTaskSource,
} from "./risk-pricing-service";
import { createRiskQuoteHandler } from "../app/api/tasks/[taskId]/risk-quote/route";
import { createRiskQuoteConfirmationHandler } from "../app/api/tasks/[taskId]/risk-quote/confirm/route";
import { createRiskContextReadHandler } from "../app/api/tasks/[taskId]/risk-context/route";
import { createReputationReadHandler } from "../app/api/agents/[agentId]/reputation/route";
import {
  confirmRiskQuote,
  readAgentReputation,
  readRiskContext,
  requestRiskQuote,
} from "../../../web/src/lib/riskPricingClient";

const taskId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const publisher = "0x1111111111111111111111111111111111111111";
const agentWallet = "0x2222222222222222222222222222222222222222";
const outsider = "0x3333333333333333333333333333333333333333";
const origin = new URL("https://agent-market.test");
const now = "2026-09-01T12:00:00.000Z";
const requestId = "0191f6f8-cb6b-7f31-81ad-c497d7d90102";

const assessment: RiskAssessorResult = {
  factors: {
    complexity: 40,
    acceptanceAmbiguity: 30,
    externalDependency: 20,
    dataSensitivity: 10,
    financialRisk: 30,
    irreversibility: 20,
    deadlineRisk: 10,
    agentUncertainty: 40,
  },
  reasonCodes: ["moderate_complexity"],
};

const preliminaryTask = (): AuthoritativeRiskTask => ({
  id: taskId,
  title: "Verify a deterministic delivery",
  description: "Run the accepted checks and return the evidence.",
  requirements: ["Return a schema-valid evidence record"],
  declaredPermissions: ["public-read"],
  durationHours: 24,
  dependencyClasses: ["public-http"],
  budgetAtomic: "1000",
  publisherWallet: publisher,
  authorizedQuoteWallets: [publisher],
  quoteStatus: "not_issued",
  dag: null,
});

const finalTask = (): AuthoritativeRiskTask => ({
  ...preliminaryTask(),
  dag: {
    revision: 2,
    finalized: true,
    assignments: [{
      agentId,
      agentWallet,
      shareBps: 10_000,
      nodeRiskMultiplierBps: 10_000,
      reputationRiskMultiplierBps: 10_000,
    }],
  },
});

function dependencies(task: AuthoritativeRiskTask, quotes = new MemoryRiskQuoteStore()) {
  const tasks: RiskTaskSource = { loadAuthoritativeTask: vi.fn(async () => structuredClone(task)) };
  const assessor: RiskAssessorClient = { assess: vi.fn(async () => structuredClone(assessment)) };
  const service = new RiskPricingService({
    tasks,
    assessor,
    quotes,
    now: () => new Date(now),
    policyVersion: "risk-pricing-v2-test",
    serviceFeeBps: 600,
  });
  return { tasks, assessor, quotes, service };
}

const auth = (walletAddress = publisher) => ({
  authenticateSession: vi.fn(async () => ({ walletAddress })),
});

const post = (path: string, body: unknown, extras: HeadersInit = {}) => new Request(`${origin.origin}${path}`, {
  method: "POST",
  headers: {
    origin: origin.origin,
    cookie: "__Host-agent_market_session=secure-session",
    "content-type": "application/json",
    "x-request-id": requestId,
    ...extras,
  },
  body: JSON.stringify(body),
});

describe("RiskPricingService", () => {
  it("derives preliminary and final phases only from authoritative DAG state", async () => {
    const preliminary = dependencies(preliminaryTask());
    const pre = await preliminary.service.issueQuote({
      taskId,
      expectedTaskFingerprint: fingerprintRiskTask(preliminaryTask()),
      actorWallet: publisher,
    });
    expect(pre.quote.phase).toBe("preliminary");
    expect(pre.assignments).toEqual([]);

    const final = dependencies(finalTask());
    const issued = await final.service.issueQuote({
      taskId,
      expectedTaskFingerprint: fingerprintRiskTask(finalTask()),
      actorWallet: publisher,
    });
    expect(issued.quote.phase).toBe("final");
    expect(issued.assignments).toEqual([{ agentId, agentWallet }]);
  });

  it("compares the client expectation with a server-computed canonical fingerprint", async () => {
    const { service, assessor } = dependencies(preliminaryTask());
    await expect(service.issueQuote({
      taskId,
      expectedTaskFingerprint: `sha256:${"0".repeat(64)}`,
      actorWallet: publisher,
    })).rejects.toMatchObject({ code: "RISK_TASK_FINGERPRINT_CONFLICT", status: 409 });
    expect(assessor.assess).not.toHaveBeenCalled();
  });

  it("derives confirmation roles from the authenticated wallet and stored quote", async () => {
    const { service } = dependencies(finalTask());
    const issued = await service.issueQuote({
      taskId,
      expectedTaskFingerprint: fingerprintRiskTask(finalTask()),
      actorWallet: publisher,
    });
    await expect(service.confirmQuote({
      taskId, quoteId: issued.id, taskFingerprint: issued.quote.taskFingerprint, actorWallet: publisher,
    })).resolves.toMatchObject({ actorType: "publisher", agentId: null });
    await expect(service.confirmQuote({
      taskId, quoteId: issued.id, taskFingerprint: issued.quote.taskFingerprint, actorWallet: agentWallet,
    })).resolves.toMatchObject({ actorType: "agent", agentId });
    await expect(service.confirmQuote({
      taskId, quoteId: issued.id, taskFingerprint: issued.quote.taskFingerprint, actorWallet: outsider,
    })).rejects.toMatchObject({ code: "RISK_QUOTE_CONFIRM_FORBIDDEN", status: 403 });
  });

  it("keeps confirm available while quote creation is explicitly unavailable", async () => {
    const quotes = new MemoryRiskQuoteStore();
    const configured = dependencies(preliminaryTask(), quotes);
    const issued = await configured.service.issueQuote({
      taskId,
      expectedTaskFingerprint: fingerprintRiskTask(preliminaryTask()),
      actorWallet: publisher,
    });
    const unconfigured = new RiskPricingService({ quotes, now: () => new Date(now) });
    await expect(unconfigured.issueQuote({
      taskId, expectedTaskFingerprint: issued.quote.taskFingerprint, actorWallet: publisher,
    })).rejects.toMatchObject({ code: "RISK_QUOTE_CREATION_UNAVAILABLE", status: 503 });
    await expect(unconfigured.confirmQuote({
      taskId, quoteId: issued.id, taskFingerprint: issued.quote.taskFingerprint, actorWallet: publisher,
    })).resolves.toMatchObject({ actorType: "publisher" });
  });

  it("bootstraps a minimal canonical context for the publisher", async () => {
    const { service } = dependencies(preliminaryTask());
    await expect(service.readRiskContext({ taskId, actorWallet: publisher })).resolves.toEqual({
      taskId,
      taskFingerprint: fingerprintRiskTask(preliminaryTask()),
      phase: "preliminary",
      dagRevision: 0,
      quoteStatus: "not_issued",
    });
  });

  it("allows finalized assignment wallets but rejects preliminary and unrelated wallets", async () => {
    await expect(dependencies(finalTask()).service.readRiskContext({
      taskId, actorWallet: agentWallet,
    })).resolves.toMatchObject({ phase: "final", dagRevision: 2 });
    await expect(dependencies(preliminaryTask()).service.readRiskContext({
      taskId, actorWallet: agentWallet,
    })).rejects.toMatchObject({ code: "RISK_CONTEXT_READ_FORBIDDEN", status: 403 });
    await expect(dependencies(finalTask()).service.readRiskContext({
      taskId, actorWallet: outsider,
    })).rejects.toMatchObject({ code: "RISK_CONTEXT_READ_FORBIDDEN", status: 403 });
  });

  it("fails closed when the authoritative task source is unavailable", async () => {
    const service = new RiskPricingService({ quotes: new MemoryRiskQuoteStore() });
    await expect(service.readRiskContext({ taskId, actorWallet: publisher }))
      .rejects.toMatchObject({ code: "RISK_CONTEXT_UNAVAILABLE", status: 503 });
  });
});

describe("risk pricing HTTP routes", () => {
  it("returns only the authenticated risk-context bootstrap fields", async () => {
    const { service } = dependencies(finalTask());
    const response = await createRiskContextReadHandler({ auth: auth(agentWallet), service })(
      new Request(`${origin.origin}/api/tasks/${taskId}/risk-context`, {
        headers: {
          cookie: "__Host-agent_market_session=secure-session",
          "x-request-id": requestId,
        },
      }),
      taskId,
    );
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(body).sort()).toEqual([
      "dagRevision", "phase", "quoteStatus", "requestId", "taskFingerprint", "taskId",
    ]);
    expect(body).toMatchObject({ taskId, phase: "final", dagRevision: 2, quoteStatus: "not_issued", requestId });
    expect(JSON.stringify(body)).not.toMatch(/wallet|description|requirement|permission|budget|assignment/iu);
  });

  it("requires a valid session and fails closed without a configured task source", async () => {
    const configured = dependencies(preliminaryTask()).service;
    const noSession = await createRiskContextReadHandler({ auth: auth(), service: configured })(
      new Request(`${origin.origin}/api/tasks/${taskId}/risk-context`), taskId,
    );
    const unavailable = await createRiskContextReadHandler({
      auth: auth(), service: new RiskPricingService({ quotes: new MemoryRiskQuoteStore() }),
    })(new Request(`${origin.origin}/api/tasks/${taskId}/risk-context`, {
      headers: { cookie: "__Host-agent_market_session=secure-session" },
    }), taskId);
    expect(noSession.status).toBe(401);
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({ error: "RISK_CONTEXT_UNAVAILABLE", requestId: expect.any(String) });
  });

  it.each(["phase", "assessment", "factors", "rate", "tier", "P", "A", "B", "actorType"])(
    "rejects browser-controlled %s during quote creation",
    async (field) => {
      const service = { issueQuote: vi.fn() };
      const response = await createRiskQuoteHandler({ auth: auth(), service, authOrigin: origin })(
        post(`/api/tasks/${taskId}/risk-quote`, {
          taskFingerprint: fingerprintRiskTask(preliminaryTask()),
          [field]: field === "phase" ? "final" : "injected",
        }),
        taskId,
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(service.issueQuote).not.toHaveBeenCalled();
    },
  );

  it("requires same-origin secure session requests and returns a UUID request ID", async () => {
    const { service } = dependencies(preliminaryTask());
    const handler = createRiskQuoteHandler({ auth: auth(), service, authOrigin: origin });
    const missingCookie = await handler(new Request(`${origin.origin}/api/tasks/${taskId}/risk-quote`, {
      method: "POST",
      headers: { origin: origin.origin, "content-type": "application/json" },
      body: JSON.stringify({ taskFingerprint: fingerprintRiskTask(preliminaryTask()) }),
    }), taskId);
    const wrongOrigin = await handler(new Request(`${origin.origin}/api/tasks/${taskId}/risk-quote`, {
      method: "POST",
      headers: { origin: "https://evil.test", cookie: "__Host-agent_market_session=x", "content-type": "application/json" },
      body: JSON.stringify({ taskFingerprint: fingerprintRiskTask(preliminaryTask()) }),
    }), taskId);
    const malformedJson = await handler(new Request(`${origin.origin}/api/tasks/${taskId}/risk-quote`, {
      method: "POST",
      headers: { origin: origin.origin, cookie: "__Host-agent_market_session=x", "content-type": "application/json" },
      body: "{",
    }), taskId);
    const accepted = await handler(post(`/api/tasks/${taskId}/risk-quote`, {
      taskFingerprint: fingerprintRiskTask(preliminaryTask()),
    }), taskId);
    expect([missingCookie.status, wrongOrigin.status, malformedJson.status, accepted.status]).toEqual([401, 403, 400, 201]);
    expect(accepted.headers.get("x-request-id")).toBe(requestId);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects confirmation role injection and derives the role from the session wallet", async () => {
    const { service } = dependencies(finalTask());
    const issued = await service.issueQuote({
      taskId,
      expectedTaskFingerprint: fingerprintRiskTask(finalTask()),
      actorWallet: publisher,
    });
    const handler = createRiskQuoteConfirmationHandler({ auth: auth(agentWallet), service, authOrigin: origin });
    const injected = await handler(post(`/api/tasks/${taskId}/risk-quote/confirm`, {
      quoteId: issued.id,
      taskFingerprint: issued.quote.taskFingerprint,
      actorType: "publisher",
    }), taskId);
    const accepted = await handler(post(`/api/tasks/${taskId}/risk-quote/confirm`, {
      quoteId: issued.id,
      taskFingerprint: issued.quote.taskFingerprint,
    }), taskId);
    expect(injected.status).toBe(400);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ confirmation: { actorType: "agent", agentId } });
  });
});

describe("public Reputation V2 API", () => {
  it("returns only aggregate snapshot fields with no wallet or raw event data", async () => {
    const review: ReputationReview = {
      reviewId: "33333333-3333-4333-8333-333333333333",
      orderId: taskId,
      agentId,
      reviewerWallet: publisher,
      agentOwnerWallet: agentWallet,
      qualityScore: 0.9,
      timelinessScore: 1,
      communicationScore: 0.8,
      outcome: "accepted",
      disputeAttribution: "none",
      orderValueAtomic: "1000",
      occurredAt: now,
      reasonCodes: ["delivery_accepted"],
    };
    const store = new MemoryReputationStore([]);
    await store.saveReview(review);
    const response = await createReputationReadHandler({ store, now: () => new Date(now) })(
      new Request(`${origin.origin}/api/agents/${agentId}/reputation`, { headers: { "x-request-id": requestId } }),
      agentId,
    );
    const serialized = JSON.stringify(await response.json());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(serialized).toContain("reputation-v2");
    expect(serialized).not.toContain(publisher);
    expect(serialized).not.toContain(agentWallet);
    expect(serialized).not.toContain("reviewId");
    expect(serialized).not.toContain("reasonCodes");
  });
});

describe("riskPricingClient", () => {
  it("sends only the public fields and strictly parses aggregate responses", async () => {
    const task = preliminaryTask();
    const { service } = dependencies(task);
    const issued = await service.issueQuote({
      taskId,
      expectedTaskFingerprint: fingerprintRiskTask(task),
      actorWallet: publisher,
    });
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/reputation")) {
        return Response.json({
          reputation: {
            agentId, score: 30, rawScore: 0,
            dimensions: { deliveryReliability: 0, qualityFeedback: 0, communicationExperience: 0, disputeOutcome: 0, experience: 0 },
            sampleCount: 0, effectiveSampleWeight: 0, confidenceValue: 0, confidence: "low",
            acceptanceRate: 0, refundRate: 0, disputeRate: 0,
            windowDays: 90, maxEvents: 20, halfLifeDays: 30, priorScore: 30,
            formulaVersion: "reputation-v2", calculatedAt: now,
          },
          requestId,
        });
      }
      if (String(url).endsWith("/confirm")) {
        return Response.json({ confirmation: { quoteId: issued.id, actorType: "publisher", agentId: null }, requestId });
      }
      return Response.json({ quoteId: issued.id, quote: issued.quote, version: issued.version, requestId }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await requestRiskQuote(taskId, issued.quote.taskFingerprint);
    await confirmRiskQuote(taskId, issued.id, issued.quote.taskFingerprint);
    await readAgentReputation(agentId);
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ taskFingerprint: issued.quote.taskFingerprint });
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ quoteId: issued.id, taskFingerprint: issued.quote.taskFingerprint });
    expect(calls.slice(0, 2).every(({ init }) => init?.credentials === "include")).toBe(true);
    expect(calls[2]?.init?.credentials).toBe("omit");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      quoteId: issued.id, quote: issued.quote, version: issued.version, requestId, publisherWallet: publisher,
    }, { status: 201 })));
    await expect(requestRiskQuote(taskId, issued.quote.taskFingerprint)).rejects.toThrow("RISK_API_RESPONSE_INVALID");
    vi.unstubAllGlobals();
  });

  it("strictly reads the minimal risk context with authenticated credentials", async () => {
    const expected = {
      taskId,
      taskFingerprint: fingerprintRiskTask(preliminaryTask()),
      phase: "preliminary" as const,
      dagRevision: 0,
      quoteStatus: "not_issued" as const,
      requestId,
    };
    const fetchMock = vi.fn(async () => Response.json(expected));
    vi.stubGlobal("fetch", fetchMock);
    await expect(readRiskContext(taskId)).resolves.toEqual(expected);
    expect(fetchMock).toHaveBeenCalledWith(`/api/tasks/${taskId}/risk-context`, {
      credentials: "include",
      headers: { accept: "application/json" },
    });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...expected, publisherWallet: publisher })));
    await expect(readRiskContext(taskId)).rejects.toThrow("RISK_API_RESPONSE_INVALID");
    vi.unstubAllGlobals();
  });
});
