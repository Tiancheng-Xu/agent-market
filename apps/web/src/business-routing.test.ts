import { describe, expect, it, vi } from "vitest";
import { createPagesHandler, type PagesEnvironment } from "./pages-worker";
import { RequiredWorkflowStages, TaskGraphSchema } from "@agent-market/shared-contracts";
import { createQueenPlanningClient, QUEEN_PLANNING_OPERATIONS, type QueenPlanningStatus } from "./lib/queenPlanningClient";
// Test-only Node gateway import. No server parser is imported by browser/Edge production code.
import { createQueenGraphqlGateway, type QueenGraphqlGatewayOptions } from "../../transaction-engine/src/application/queen-graphql-gateway";
import { AuthError } from "../../transaction-engine/src/auth/session";

const id = "00000000-0000-4000-8000-000000000001";
const environment: PagesEnvironment = {
  ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
  TRANSACTION_ENGINE_ORIGIN: "https://engine.example",
};
const routes: Array<readonly [string, string]> = [
  ["GET", `/api/tasks/${id}/risk-quote`],
  ["GET", `/api/tasks/${id}/planning-request`],
  ["POST", `/api/tasks/${id}/planning-request`], ["POST", `/api/tasks/${id}/planning-approval`],
  ["POST", "/api/commercial/orders"], ["GET", `/api/commercial/orders/${id}`],
  ["POST", `/api/commercial/orders/${id}/commands`],
  ...["events", "tickets", "reviews"].flatMap<readonly [string, string]>(name => [["GET", `/api/governance/${name}`], ["POST", `/api/governance/${name}`]]),
  ["POST", "/api/governance/commands"], ["GET", "/api/governance/compensation"], ["GET", "/api/governance/audit"],
];

it.each(routes)("routes %s %s to the authenticated business engine without retry", async (method, path) => {
  let calls = 0;
  const handler = createPagesHandler({ upstreamFetch: async input => {
    calls++;
    const request = input as Request;
    expect(request.url).toBe(`https://engine.example${path}`);
    expect(request.method).toBe(method);
    expect(request.headers.get("cookie")).toBe("__Host-agent_market_session=synthetic-test-session");
    expect(request.headers.get("authorization")).toBeNull();
    // A downstream denial remains a denial, never simulated successful data.
    return Response.json({ error: "AUTH_SESSION_INVALID" }, { status: 401 });
  } });
  const response = await handler.fetch(new Request(`https://market.example${path}`, {
    method,
    headers: { origin: "https://market.example", cookie: "__Host-agent_market_session=synthetic-test-session", authorization: "Bearer untrusted" },
    ...(method === "POST" ? { body: "{}" } : {}),
  }), environment);
  expect(calls).toBe(1);
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("blocks unknown resources, wrong methods and cross-origin writes before forwarding", async () => {
  let calls = 0;
  const handler = createPagesHandler({ upstreamFetch: async () => { calls++; return Response.json({}); } });
  const request = (path: string, method: string, origin: string) => new Request(`https://market.example${path}`, { method, headers: { origin } });
  expect((await handler.fetch(request("/api/governance/grant-admin", "POST", "https://market.example"), environment)).status).toBe(404);
  expect((await handler.fetch(request("/api/commercial/orders/not-a-uuid", "GET", "https://market.example"), environment)).status).toBe(404);
  expect((await handler.fetch(request("/api/governance/audit", "POST", "https://market.example"), environment)).status).toBe(405);
  expect((await handler.fetch(request(`/api/tasks/${id}/planning-approval`, "GET", "https://market.example"), environment)).status).toBe(405);
  expect((await handler.fetch(request(`/api/tasks/${id}/risk-quote/confirm`, "GET", "https://market.example"), environment)).status).toBe(405);
  expect((await handler.fetch(request("/api/governance/commands", "POST", "https://attacker.example"), environment)).status).toBe(403);
  expect(calls).toBe(0);
});

describe("task-bound Queen Edge -> real TE AST gateway (local fake service ports, not PG/production)", () => {
  const requestId = "22222222-2222-4222-8222-222222222222";
  const approvalId = "33333333-3333-4333-8333-333333333333";
  const wallet = `0x${"a".repeat(40)}`;
  const fingerprint = `sha256:${"f".repeat(64)}`;
  function setup(flags: { planningEnabled?: boolean; workerReady?: boolean } = {}) {
    let state: QueenPlanningStatus = { task: { taskId: id, taskVersion: 3, status: "open" }, request: null, canApprove: false, executionVerified: false };
    const auth = { authenticateSession: vi.fn<QueenGraphqlGatewayOptions["auth"]["authenticateSession"]>(async () => ({
      sessionId: requestId, requestId, walletAddress: wallet, chainId: 11155111,
      issuedAt: "2026-09-09T00:00:00.000Z", expiresAt: "2026-09-10T00:00:00.000Z", recentAuthAt: "2026-09-09T00:00:00.000Z",
    })) };
    const propose = vi.fn<QueenGraphqlGatewayOptions["propose"]>(async () => {
      state = { ...state, request: { requestId, taskVersion: 3, authorizationCurrent: true, graphRevision: 1,
        taskFingerprint: fingerprint, planningOperationStatus: "unobserved", plan: null, approval: null } };
      return { requestId, status: "queued", duplicate: false };
    });
    const confirm = vi.fn<QueenGraphqlGatewayOptions["confirm"]>(async () => {
      state.canApprove = false;
      state.request!.approval = { approvalId, approved: true, authorizationCurrent: true, operationStatus: "unobserved" };
      return { approvalId, status: "queued", duplicate: true };
    });
    const read = vi.fn<QueenGraphqlGatewayOptions["read"]>(async () => state);
    const gateway = createQueenGraphqlGateway({ authOrigin: new URL("https://market.example"),
      auth, propose, confirm, read, planningEnabled: true, workerReady: true, ...flags });
    const upstream = vi.fn<typeof fetch>(async input => {
      const request = input as Request;
      expect(request.url).toBe("https://engine.example/api/queen/graphql");
      expect(request.headers.get("origin")).toBe("https://market.example");
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("x-agent-caller-scope")).toBeNull();
      expect(request.headers.get("x-wallet-address")).toBeNull();
      expect(request.headers.get("x-forwarded-host")).toBe("market.example");
      return gateway(request);
    });
    const handler = createPagesHandler({ upstreamFetch: upstream });
    const browserFetch: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      // Browser supplies Origin and cookie automatically; no real credential is used here.
      headers.set("origin", "https://market.example");
      headers.set("cookie", "__Host-agent_market_session=local-test-session");
      return handler.fetch(new Request(new URL(String(url), "https://market.example"), { ...init, headers }), environment);
    };
    const client = createQueenPlanningClient({ fetch: browserFetch, assertSession() {} });
    return { client, handler, upstream, auth, propose, confirm, read, state: () => state,
      commitFakePlan() {
        state.canApprove = true;
        state.request!.planningOperationStatus = "committed";
        state.request!.plan = { recordVersion: 1, graph: TaskGraphSchema.parse({
          taskId: id, graphRevision: 1, requiredStages: [...RequiredWorkflowStages], riskLevel: "low", startPolicy: "auto",
          rescuePolicy: { mode: "auto", visibleToUser: false, evidenceVisible: true },
          nodes: [{ nodeId: "plan", type: "plan", title: "Requirement from fake persisted task", dependencies: [], required: true },
            { nodeId: "deliver", type: "deliver", title: "Deliver", dependencies: ["plan"], required: true }], edges: [{ from: "plan", to: "deliver" }],
        }) };
      },
    };
  }
  function http(body: unknown, path = "/api/queen/graphql", headers: Record<string, string> = {}) {
    return new Request(`https://market.example${path}`, { method: "POST", headers: {
      origin: "https://market.example", cookie: "__Host-agent_market_session=local-test-session",
      "content-type": "application/json", authorization: "Bearer untrusted", "x-agent-caller-scope": "owner",
      "x-wallet-address": `0x${"b".repeat(40)}`, "x-forwarded-host": "evil.example", ...headers,
    }, body: JSON.stringify(body) });
  }
  const readBody = () => ({ operationName: "PlanningStatus", query: QUEEN_PLANNING_OPERATIONS.PlanningStatus, variables: { taskId: id } });

  it("runs browser documents through Edge and real AST execution: read -> queued -> committed -> approval queued -> readback", async () => {
    const s = setup();
    const initial = await s.client.read(id);
    expect(initial.request).toBeNull();
    expect(await s.client.propose(initial.task)).toEqual({ requestId, status: "queued", duplicate: false });
    const queued = await s.client.read(id);
    expect(queued.request!.plan).toBeNull();
    expect(queued.canApprove).toBe(false);
    expect(queued.executionVerified).toBe(false);
    s.commitFakePlan(); // Synthetic worker state, not a worker/model execution.
    const committed = await s.client.read(id);
    expect(committed.request!.plan!.graph.nodes[0]!.title).toBe("Requirement from fake persisted task");
    expect(committed.request!.plan!.graph.nodes[0]!.contract.schemaVersion).toBe("1");
    expect(committed.canApprove).toBe(true);
    expect(await s.client.confirm(committed, true)).toEqual({ approvalId, status: "queued", duplicate: true });
    const approval = await s.client.read(id);
    expect(approval.canApprove).toBe(false);
    expect(approval.request!.approval!.operationStatus).toBe("unobserved");
    expect(approval.executionVerified).toBe(false);
    expect(s.propose).toHaveBeenCalledExactlyOnceWith({ taskId: id, expectedTaskVersion: 3, actorWallet: wallet });
    expect(s.confirm).toHaveBeenCalledExactlyOnceWith({ taskId: id, requestId, expectedTaskVersion: 3,
      graphRevision: 1, taskFingerprint: fingerprint, approved: true, actorWallet: wallet });
    expect(s.read).toHaveBeenCalledWith({ taskId: id, actorWallet: wallet });
    expect(s.auth.authenticateSession).toHaveBeenCalledWith("local-test-session");
  });
  it.each([{ workerReady: false }, { planningEnabled: false }])("keeps historical query available with producer gate %j closed", async flags => {
    const s = setup(flags);
    const history = await s.client.read(id);
    await expect(s.client.propose(history.task)).rejects.toThrow("QUEEN_ASYNC_PLANNING_DISABLED");
    expect((await s.client.read(id)).executionVerified).toBe(false);
    expect(s.propose).not.toHaveBeenCalled();
  });
  it.each(["sender", "actorWallet", "ownerScope", "requirement", "queenAgentId"])("does not grant spoofed input %s", async field => {
    const s = setup();
    const response = await s.handler.fetch(http({ operationName: "ProposeTaskGraph", query: QUEEN_PLANNING_OPERATIONS.ProposeTaskGraph,
      variables: { input: { taskId: id, taskVersion: 3, [field]: "owner" } } }), environment);
    expect(response.status).toBe(400);
    expect(s.propose).not.toHaveBeenCalled();
  });
  it.each(["https://evil.example", "null", ""])("rejects Origin %s before TE", async origin => {
    const s = setup();
    expect((await s.handler.fetch(http(readBody(), undefined, { origin }), environment)).status).toBe(403);
    expect(s.upstream).not.toHaveBeenCalled();
  });
  it("rejects cross-site browser metadata even with a spoofed matching Origin", async () => {
    const s = setup();
    expect((await s.handler.fetch(http(readBody(), undefined, { "sec-fetch-site": "cross-site" }), environment)).status).toBe(403);
    expect(s.upstream).not.toHaveBeenCalled();
  });
  it("preserves session denials for missing and revoked cookies", async () => {
    const s = setup();
    expect((await s.handler.fetch(http(readBody(), undefined, { cookie: "" }), environment)).status).toBe(401);
    s.auth.authenticateSession.mockRejectedValueOnce(new AuthError("AUTH_SESSION_INVALID"));
    await expect(s.client.read(id)).rejects.toThrow("AUTH_SESSION_INVALID");
    expect(s.read).not.toHaveBeenCalled();
  });
  it.each([
    { ...readBody(), operationName: "ProposeTaskGraph" },
    { query: "query A { planningStatus(taskId: \"x\") { canApprove } } query B { planningStatus(taskId: \"x\") { canApprove } }" },
    { query: "query { hidden: planningStatus(taskId: \"x\") { canApprove } }" },
    { query: "query { planningStatus(taskId: \"x\") { ...F } } fragment F on PlanningStatus { canApprove }" },
  ])("rejects operation-name/document/alias/fragment bypasses", async body => {
    const s = setup();
    expect((await s.handler.fetch(http(body), environment)).status).toBe(400);
    expect(s.read).not.toHaveBeenCalled();
  });
  it.each(["startTaskRun", "submitNodeOutput", "judgeNodeOutput", "repairNode", "finalArbitrate", "writeLearningLoop"])("never opens trusted-worker %s", async operation => {
    const s = setup();
    expect((await s.handler.fetch(http({ query: `mutation { ${operation} }` }), environment)).status).toBe(403);
    expect(s.propose).not.toHaveBeenCalled();
    expect(s.confirm).not.toHaveBeenCalled();
  });
  it("only exposes the exact TE path and does not route public agent/graphql to TE", async () => {
    const s = setup();
    for (const path of ["/api/queen/graphql/", "/api/queen/graphql/run", "/api/queen/start", "/api/queen"]) {
      expect((await s.handler.fetch(http(readBody(), path), environment)).status).toBe(404);
    }
    expect((await s.handler.fetch(new Request("https://market.example/api/queen/graphql"), environment)).status).toBe(405);
    expect((await s.handler.fetch(http(readBody(), "/api/queen/graphql?query=other"), environment)).status).toBe(400);
    expect((await s.handler.fetch(http(readBody(), "/agent/graphql"), environment)).ok).toBe(false);
    expect(s.upstream).not.toHaveBeenCalled();
  });
  it("rejects excessive byte size, including chunked bodies without Content-Length", async () => {
    const s = setup();
    expect((await s.handler.fetch(http({ query: "x".repeat(32_769) }), environment)).status).toBe(413);
    expect((await s.handler.fetch(http({}, undefined, { "content-length": "32769" }), environment)).status).toBe(413);
    expect(s.upstream).not.toHaveBeenCalled();
  });
  it.each(["", "text/plain"])("requires JSON content type %s", async type => {
    const s = setup();
    expect((await s.handler.fetch(http(readBody(), undefined, { "content-type": type }), environment)).status).toBe(415);
    expect(s.upstream).not.toHaveBeenCalled();
  });
  it("reports absent production TE configuration without a fake successful fallback", async () => {
    const s = setup();
    const response = await s.handler.fetch(http(readBody()), { ASSETS: environment.ASSETS });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("QUEEN_GRAPHQL_UNAVAILABLE");
    expect(s.upstream).not.toHaveBeenCalled();
  });
  it.each(["html", "redirect", "unknown-error", "network"])("sanitizes %s errors without leaking headers/SQL or retrying", async kind => {
    const upstream = vi.fn<typeof fetch>(async () => {
      if (kind === "network") throw new Error("postgres://secret");
      if (kind === "redirect") return new Response(null, { status: 302, headers: { location: "https://secret.example", "set-cookie": "secret" } });
      if (kind === "html") return new Response("<pre>SELECT secret</pre>", { status: 500 });
      return Response.json({ errors: [{ message: "SELECT secret", extensions: { code: "secret" } }] }, { status: 500 });
    });
    const response = await createPagesHandler({ upstreamFetch: upstream }).fetch(http(readBody()), environment);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ data: null, errors: [{ message: "QUEEN_GRAPHQL_UNAVAILABLE", extensions: { code: "QUEEN_GRAPHQL_UNAVAILABLE" } }] });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(upstream).toHaveBeenCalledOnce();
  });
  it("enforces the Edge 10-second timeout without a retry", async () => {
    vi.useFakeTimers();
    try {
      // AbortSignal.timeout is native, so expose its deadline through a deterministic local test clock.
      vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
        const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
      });
      const upstream = vi.fn<typeof fetch>(async input => new Promise((_, reject) => {
        (input as Request).signal.addEventListener("abort", () => reject(new Error("private host")), { once: true });
      }));
      const pending = createPagesHandler({ upstreamFetch: upstream }).fetch(http(readBody()), environment);
      await vi.advanceTimersByTimeAsync(10_001);
      const response = await pending;
      expect(response.status).toBe(503);
      expect(upstream).toHaveBeenCalledOnce();
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });
});
