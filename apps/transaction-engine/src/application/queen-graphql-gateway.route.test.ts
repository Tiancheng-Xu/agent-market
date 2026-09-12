import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "../app/api/queen/graphql/route";
import { requestQueenPlanning } from "./queen-planning-request";
import { recordQueenPlanningApproval } from "./queen-planning-approval";
import { readQueenPlanningStatus } from "./queen-planning-status";

// Real Next route + real GraphQL adapter; auth/SQL/service ports are local fakes.
// No database, worker, provider or production endpoint is contacted.
const fixtures = vi.hoisted(() => ({
  sql: { kind: "local-fake-sql-port" },
  wallet: `0x${"a".repeat(40)}`,
  taskId: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  approvalId: "33333333-3333-4333-8333-333333333333",
  authenticateSession: vi.fn(),
  getAuthOrigin: vi.fn(),
  getOrderRuntime: vi.fn(),
}));
vi.mock("../auth/runtime", () => ({
  getAuthOrigin: fixtures.getAuthOrigin,
  getAuthService: () => ({ authenticateSession: fixtures.authenticateSession }),
}));
vi.mock("./order-runtime", () => ({ getOrderRuntime: fixtures.getOrderRuntime }));
vi.mock("./queen-planning-request", async original => ({
  ...await original<typeof import("./queen-planning-request")>(), requestQueenPlanning: vi.fn(),
}));
vi.mock("./queen-planning-approval", () => ({ recordQueenPlanningApproval: vi.fn() }));
vi.mock("./queen-planning-status", () => ({ readQueenPlanningStatus: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  fixtures.getAuthOrigin.mockReturnValue(new URL("https://market.example"));
  fixtures.authenticateSession.mockResolvedValue({ walletAddress: fixtures.wallet });
  fixtures.getOrderRuntime.mockReturnValue({ sql: fixtures.sql });
  vi.stubEnv("QUEEN_ASYNC_PLANNING_ENABLED", "true");
  vi.stubEnv("QUEEN_ASYNC_WORKER_READY", "true");
  vi.mocked(requestQueenPlanning).mockResolvedValue({ requestId: fixtures.requestId, status: "queued", duplicate: true });
  vi.mocked(recordQueenPlanningApproval).mockResolvedValue({ approvalId: fixtures.approvalId, status: "queued", duplicate: false });
  vi.mocked(readQueenPlanningStatus).mockResolvedValue({
    task: { taskId: fixtures.taskId, taskVersion: 3, status: "open" }, request: null,
    canApprove: false, executionVerified: false,
  });
});
afterEach(() => vi.unstubAllEnvs());

function request(query: string, variables: Record<string, unknown>) {
  return new Request("https://market.example/api/queen/graphql", {
    method: "POST", headers: { origin: "https://market.example", "content-type": "application/json",
      cookie: "__Host-agent_market_session=route-token" }, body: JSON.stringify({ query, variables }),
  });
}
const proposal = "mutation($input: ProposeTaskGraphInput!) { proposeTaskGraph(input: $input) { requestId status duplicate } }";

describe("TE route wiring (local fake auth and service ports, not PG/production)", () => {
  it("passes its SQL instance and the authenticated actor to the real proposal service port", async () => {
    const response = await POST(request(proposal, { input: { taskId: fixtures.taskId, taskVersion: 3 } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { proposeTaskGraph: {
      requestId: fixtures.requestId, status: "queued", duplicate: true,
    } } });
    expect(fixtures.authenticateSession).toHaveBeenCalledExactlyOnceWith("route-token");
    expect(requestQueenPlanning).toHaveBeenCalledExactlyOnceWith(fixtures.sql, {
      taskId: fixtures.taskId, expectedTaskVersion: 3, actorWallet: fixtures.wallet,
    });
  });

  it("passes exact approval binding to the approval service without starting execution", async () => {
    const input = { taskId: fixtures.taskId, requestId: fixtures.requestId, taskVersion: 3,
      graphRevision: 1, taskFingerprint: `sha256:${"f".repeat(64)}`, approved: true };
    const response = await POST(request(
      "mutation($input: ConfirmTaskGraphInput!) { confirmTaskGraph(input: $input) { approvalId status duplicate } }", { input },
    ));
    expect(await response.json()).toEqual({ data: { confirmTaskGraph: {
      approvalId: fixtures.approvalId, status: "queued", duplicate: false,
    } } });
    expect(recordQueenPlanningApproval).toHaveBeenCalledExactlyOnceWith(fixtures.sql, {
      taskId: fixtures.taskId, requestId: fixtures.requestId, expectedTaskVersion: 3,
      graphRevision: 1, taskFingerprint: input.taskFingerprint, approved: true, actorWallet: fixtures.wallet,
    });
    expect(requestQueenPlanning).not.toHaveBeenCalled();
  });

  it("does not treat the string false as worker readiness, while querying the real readback port", async () => {
    vi.stubEnv("QUEEN_ASYNC_PLANNING_ENABLED", "false");
    vi.stubEnv("QUEEN_ASYNC_WORKER_READY", "false");
    const rejected = await POST(request(proposal, { input: { taskId: fixtures.taskId, taskVersion: 3 } }));
    expect(rejected.status).toBe(503);
    expect(fixtures.getOrderRuntime).not.toHaveBeenCalled();
    const response = await POST(request(
      "query($taskId: ID!) { planningStatus(taskId: $taskId) { task { taskId taskVersion } canApprove executionVerified } }",
      { taskId: fixtures.taskId },
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { planningStatus: {
      task: { taskId: fixtures.taskId, taskVersion: 3 }, canApprove: false, executionVerified: false,
    } } });
    expect(readQueenPlanningStatus).toHaveBeenCalledExactlyOnceWith(fixtures.sql, { taskId: fixtures.taskId, actorWallet: fixtures.wallet });
  });

  it("sanitizes setup and authentication failures before GraphQL execution", async () => {
    fixtures.getAuthOrigin.mockImplementationOnce(() => { throw new Error("postgres://admin:secret@internal"); });
    const first = await POST(request(proposal, { input: { taskId: fixtures.taskId, taskVersion: 3 } }));
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ data: null, errors: [{ message: "QUEEN_GRAPHQL_UNAVAILABLE",
      extensions: { code: "QUEEN_GRAPHQL_UNAVAILABLE" } }] });
    fixtures.authenticateSession.mockRejectedValueOnce(new Error("SELECT secret FROM wallet_sessions"));
    const second = await POST(request(proposal, { input: { taskId: fixtures.taskId, taskVersion: 3 } }));
    expect(await second.json()).toEqual({ data: null, errors: [{ message: "QUEEN_GRAPHQL_UNAVAILABLE",
      extensions: { code: "QUEEN_GRAPHQL_UNAVAILABLE" } }] });
    expect(fixtures.getOrderRuntime).not.toHaveBeenCalled();
  });

  it("never authenticates or opens SQL for GET", () => {
    expect(GET().status).toBe(405);
    expect(fixtures.authenticateSession).not.toHaveBeenCalled();
    expect(fixtures.getOrderRuntime).not.toHaveBeenCalled();
  });
});
