import { describe, expect, it, vi } from "vitest";
import { AuthError } from "../auth/session";
import { QueenPlanningError } from "./queen-planning-request";
import { createQueenGraphqlGateway, type QueenGraphqlGatewayOptions } from "./queen-graphql-gateway";

// Local service-port tests: no PostgreSQL, wallet extension, worker or production I/O.
const taskId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const approvalId = "33333333-3333-4333-8333-333333333333";
const wallet = `0x${"a".repeat(40)}`;
const fingerprint = `sha256:${"f".repeat(64)}`;
const proposal = "mutation ProposeTaskGraph($input: ProposeTaskGraphInput!) { proposeTaskGraph(input: $input) { requestId status duplicate } }";
const confirmation = "mutation ConfirmTaskGraph($input: ConfirmTaskGraphInput!) { confirmTaskGraph(input: $input) { approvalId status duplicate } }";
const query = "query PlanningStatus($taskId: ID!) { planningStatus(taskId: $taskId) { task { taskId taskVersion status } request { requestId } canApprove executionVerified } }";

function setup(flags: Partial<Pick<QueenGraphqlGatewayOptions, "planningEnabled" | "workerReady">> = {}) {
  const auth = { authenticateSession: vi.fn<QueenGraphqlGatewayOptions["auth"]["authenticateSession"]>(async () => ({
    sessionId: requestId, requestId, walletAddress: wallet, chainId: 11155111,
    issuedAt: "2026-09-09T00:00:00.000Z", expiresAt: "2026-09-10T00:00:00.000Z", recentAuthAt: "2026-09-09T00:00:00.000Z",
  })) };
  const propose = vi.fn<QueenGraphqlGatewayOptions["propose"]>(async () => ({ requestId, status: "queued", duplicate: false }));
  const confirm = vi.fn<QueenGraphqlGatewayOptions["confirm"]>(async () => ({ approvalId, status: "queued", duplicate: true }));
  const read = vi.fn<QueenGraphqlGatewayOptions["read"]>(async () => ({
    task: { taskId, taskVersion: 3, status: "open" }, request: null, canApprove: false, executionVerified: false,
  }));
  return { auth, propose, confirm, read, handler: createQueenGraphqlGateway({
    authOrigin: new URL("https://market.example"), auth, propose, confirm, read,
    planningEnabled: true, workerReady: true, ...flags,
  }) };
}
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://market.example/api/queen/graphql", {
    method: "POST", headers: { origin: "https://market.example", "content-type": "application/json",
      cookie: "__Host-agent_market_session=test-session-token", ...headers }, body: JSON.stringify(body),
  });
}
const proposeBody = () => ({ query: proposal, operationName: "ProposeTaskGraph", variables: { input: { taskId, taskVersion: 3 } } });
const readBody = () => ({ query, operationName: "PlanningStatus", variables: { taskId } });
async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ data: null, errors: [{ message: code, extensions: { code } }] });
  expect(response.headers.get("cache-control")).toBe("no-store");
}

describe("bounded Queen GraphQL gateway (local fake service ports)", () => {
  it("executes a real mutation with variables and passes only task context plus the session actor", async () => {
    const { handler, propose, confirm, read } = setup();
    const response = await handler(request(proposeBody(), { "x-agent-caller-scope": "owner", "x-wallet-address": `0x${"b".repeat(40)}` }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { proposeTaskGraph: { requestId, status: "queued", duplicate: false } } });
    expect(propose).toHaveBeenCalledExactlyOnceWith({ taskId, expectedTaskVersion: 3, actorWallet: wallet });
    expect(confirm).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("executes the AST selection instead of returning an opaque full service object", async () => {
    const { handler } = setup();
    const response = await handler(request({ query: `mutation { proposeTaskGraph(input: {taskId: "${taskId}", taskVersion: 3}) { duplicate } }` }));
    expect(await response.json()).toEqual({ data: { proposeTaskGraph: { duplicate: false } } });
  });

  it("passes all existing approval fields, preserves approved=false and returns queued duplicate without execution claims", async () => {
    const { handler, confirm } = setup();
    const input = { taskId, requestId, taskVersion: 3, graphRevision: 1, taskFingerprint: fingerprint, approved: false };
    const response = await handler(request({ query: confirmation, operationName: "ConfirmTaskGraph", variables: { input } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { confirmTaskGraph: { approvalId, status: "queued", duplicate: true } } });
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ taskId, requestId, expectedTaskVersion: 3,
      graphRevision: 1, taskFingerprint: fingerprint, approved: false, actorWallet: wallet });
  });

  it.each(["actorWallet", "sender", "ownerScope", "requirement", "queenAgentId"])("rejects client input privilege/content field %s", async field => {
    const { handler, propose } = setup();
    const body = proposeBody();
    const response = await handler(request({ ...body, variables: { input: { ...body.variables.input, [field]: "private:secret" } } }));
    await expectError(response, 400, "QUEEN_GRAPHQL_INVALID");
    expect(propose).not.toHaveBeenCalled();
  });

  it.each([{ origin: "https://evil.example" }, { origin: "null" }, { origin: "" }, { "sec-fetch-site": "cross-site" }])("rejects foreign or missing Origin before any service call", async headers => {
    const { handler, auth, read } = setup();
    await expectError(await handler(request(readBody(), headers)), 403, "AUTH_ORIGIN_MISMATCH");
    expect(auth.authenticateSession).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a missing Cookie", async () => {
    const { handler, auth } = setup();
    await expectError(await handler(request(proposeBody(), { cookie: "" })), 401, "AUTH_SESSION_INVALID");
    expect(auth.authenticateSession).not.toHaveBeenCalled();
  });

  it("rejects a revoked session before accessing tasks", async () => {
    const { handler, auth, read } = setup();
    auth.authenticateSession.mockRejectedValueOnce(new AuthError("AUTH_SESSION_INVALID"));
    await expectError(await handler(request(readBody())), 401, "AUTH_SESSION_INVALID");
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    "mutation { proposeTaskGraph(input: {taskId: \"x\", taskVersion: 1}) { status } proposeTaskGraph(input: {taskId: \"y\", taskVersion: 1}) { status } }",
    "mutation { first: proposeTaskGraph(input: {taskId: \"x\", taskVersion: 1}) { status } }",
    "mutation { proposeTaskGraph(input: {taskId: \"x\", taskVersion: 1}) { hidden: status } }",
    "mutation { ...Control } fragment Control on Mutation { proposeTaskGraph(input: {taskId: \"x\", taskVersion: 1}) { status } }",
    "mutation { ... on Mutation { proposeTaskGraph(input: {taskId: \"x\", taskVersion: 1}) { status } } }",
    "mutation A { proposeTaskGraph(input: {taskId: \"x\", taskVersion: 1}) { status } } mutation B { proposeTaskGraph(input: {taskId: \"y\", taskVersion: 1}) { status } }",
    "mutation { proposeTaskGraph(input: {taskId: \"x\", taskVersion: 1}) @skip(if: true) { status } }",
  ])("rejects multi-operation, alias, fragment and directive bypasses", async document => {
    const { handler, propose } = setup();
    await expectError(await handler(request({ query: document })), 400, "QUEEN_GRAPHQL_INVALID");
    expect(propose).not.toHaveBeenCalled();
  });

  it("rejects operationName that does not name the document's operation", async () => {
    const { handler, propose } = setup();
    await expectError(await handler(request({ ...proposeBody(), operationName: "ConfirmTaskGraph" })), 400, "QUEEN_GRAPHQL_INVALID");
    expect(propose).not.toHaveBeenCalled();
  });

  it("does not infer a mutation from text in a query operation name", async () => {
    const { handler, read, propose } = setup({ planningEnabled: false, workerReady: false });
    const response = await handler(request({ query: query.replaceAll("PlanningStatus", "ProposeTaskGraph"),
      operationName: "ProposeTaskGraph", variables: { taskId } }));
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledExactlyOnceWith({ taskId, actorWallet: wallet });
    expect(propose).not.toHaveBeenCalled();
  });

  it.each(["startTaskRun", "submitNodeOutput", "judgeNodeOutput", "repairNode", "finalArbitrate", "writeLearningLoop", "requestAdversarialReview", "selectNodeAgent"])("explicitly denies unsupported browser field %s", async field => {
    const { handler, propose, confirm } = setup();
    await expectError(await handler(request({ query: `mutation { ${field} { status } }` })), 403, "QUEEN_GRAPHQL_OPERATION_FORBIDDEN");
    expect(propose).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([{ planningEnabled: false, workerReady: true }, { planningEnabled: true, workerReady: false },
    { planningEnabled: false, workerReady: false }])("requires both mutation producer flags but keeps historical queries available", async flags => {
    const { handler, propose, confirm, read } = setup(flags);
    await expectError(await handler(request(proposeBody())), 503, "QUEEN_ASYNC_PLANNING_DISABLED");
    const input = { taskId, requestId, taskVersion: 3, graphRevision: 1, taskFingerprint: fingerprint, approved: true };
    await expectError(await handler(request({ query: confirmation, variables: { input } })), 503, "QUEEN_ASYNC_PLANNING_DISABLED");
    const response = await handler(request(readBody()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { planningStatus: {
      task: { taskId, taskVersion: 3, status: "open" }, request: null, canApprove: false, executionVerified: false,
    } } });
    expect(propose).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledExactlyOnceWith({ taskId, actorWallet: wallet });
  });

  it.each([
    new Error("SELECT secret FROM postgres://admin:secret@internal/private"),
    new QueenPlanningError("SELECT private:secret", 400),
  ])("does not expose unexpected service errors, even a forged domain error code", async error => {
    const { handler, propose } = setup();
    propose.mockRejectedValueOnce(error);
    await expectError(await handler(request(proposeBody())), 503, "QUEEN_GRAPHQL_UNAVAILABLE");
  });

  it("preserves the service's cross-wallet non-disclosure result", async () => {
    const { handler, read } = setup();
    read.mockRejectedValueOnce(new QueenPlanningError("QUEEN_TASK_UNAVAILABLE", 404));
    await expectError(await handler(request(readBody())), 404, "QUEEN_TASK_UNAVAILABLE");
  });

  it.each([
    { query: "mutation { private_secret" },
    { ...proposeBody(), variables: { input: { taskId, taskVersion: "postgres://secret" } } },
    { ...proposeBody(), variables: { input: { taskId } } },
    { query: "{ __schema { types { name } } }" },
    [proposeBody()],
    { ...proposeBody(), ownerScope: "owner" },
    { ...proposeBody(), variables: { input: { taskId, taskVersion: 1 }, sender: "secret" } },
  ])("sanitizes parsing, validation, coercion and envelope errors without reaching the service", async body => {
    const { handler, propose } = setup();
    await expectError(await handler(request(body)), 400, "QUEEN_GRAPHQL_INVALID");
    expect(propose).not.toHaveBeenCalled();
  });

  it("caps request bytes even without Content-Length", async () => {
    const { handler, propose } = setup();
    await expectError(await handler(request({ ...proposeBody(), padding: "x".repeat(32769) })), 413, "QUEEN_GRAPHQL_TOO_LARGE");
    expect(propose).not.toHaveBeenCalled();
  });

  it("rejects declared oversized bodies before reading the stream", async () => {
    const { handler } = setup();
    const req = request(proposeBody(), { "content-length": "999999" });
    await expectError(await handler(req), 413, "QUEEN_GRAPHQL_TOO_LARGE");
    expect(req.bodyUsed).toBe(false);
  });

  it("rejects GET instead of exposing a mutation or leaking credentials in URL parameters", async () => {
    const { handler, auth } = setup();
    const response = await handler(new Request("https://market.example/api/queen/graphql?query=mutation"));
    await expectError(response, 405, "METHOD_NOT_ALLOWED");
    expect(response.headers.get("allow")).toBe("POST");
    expect(auth.authenticateSession).not.toHaveBeenCalled();
  });
});
