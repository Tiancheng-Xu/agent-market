import { describe, expect, it, vi } from "vitest";
import { RequiredWorkflowStages, TaskGraphSchema } from "@agent-market/shared-contracts";
import { canConfirmQueenPlanning, createQueenPlanningClient, parseQueenPlanningStatus,
  QUEEN_PLANNING_OPERATIONS, QUEEN_PLANNING_ERROR_STATUS, QueenPlanningClientError,
  queenPlanningStatusLabel, type QueenPlanningStatus } from "./queenPlanningClient";

// Local fake HTTP/session ports only; no PG, wallet provider, model or production host.
const taskId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const approvalId = "33333333-3333-4333-8333-333333333333";
function status(): QueenPlanningStatus {
  return { task: { taskId, taskVersion: 3, status: "open" }, canApprove: true, executionVerified: false,
    request: { requestId, taskVersion: 3, authorizationCurrent: true, graphRevision: 1,
      taskFingerprint: `sha256:${"f".repeat(64)}`, planningOperationStatus: "committed", approval: null,
      plan: { recordVersion: 1, graph: TaskGraphSchema.parse({ taskId, graphRevision: 1, requiredStages: [...RequiredWorkflowStages],
        riskLevel: "low", startPolicy: "auto", rescuePolicy: { mode: "auto", visibleToUser: false, evidenceVisible: true },
        nodes: [{ nodeId: "plan", type: "plan", title: "Persisted private requirement", dependencies: [], required: true },
          { nodeId: "deliver", type: "deliver", title: "Deliver", dependencies: ["plan"], required: true }],
        edges: [{ from: "plan", to: "deliver" }] }) } } };
}
function setup(response: () => Promise<Response> = async () => Response.json({ data: { planningStatus: status() } })) {
  let revision = 4;
  const transport = vi.fn<typeof fetch>(response);
  const client = createQueenPlanningClient({ fetch: transport, revision: () => revision, assertSession() {} });
  return { client, transport, invalidate() { revision++; } };
}

describe("Queen planning browser transport (fake local ports)", () => {
  it("uses only the task-bound endpoint, exact query/operationName, Cookie credentials and no client actor", async () => {
    const { client, transport } = setup();
    const result = await client.read(taskId);
    expect(result).toEqual(status());
    expect(transport).toHaveBeenCalledOnce();
    const [url, options] = transport.mock.calls[0]!;
    expect(url).toBe("/api/queen/graphql");
    expect(options?.credentials).toBe("include");
    expect(JSON.parse(options?.body as string)).toEqual({ query: QUEEN_PLANNING_OPERATIONS.PlanningStatus,
      operationName: "PlanningStatus", variables: { taskId } });
    expect(options?.headers).toEqual({ "content-type": "application/json", accept: "application/json" });
  });
  it("proposes the readback version and preserves queued/duplicate instead of inventing a graph", async () => {
    const { client, transport } = setup(async () => Response.json({ data: { proposeTaskGraph: { requestId, status: "queued", duplicate: true } } }));
    expect(await client.propose(status().task)).toEqual({ requestId, status: "queued", duplicate: true });
    expect(JSON.parse(transport.mock.calls[0]![1]?.body as string).variables).toEqual({ input: { taskId, taskVersion: 3 } });
  });
  it("confirms the exact persisted request/version/revision/fingerprint and preserves approved=false", async () => {
    const { client, transport } = setup(async () => Response.json({ data: { confirmTaskGraph: { approvalId, status: "queued", duplicate: false } } }));
    expect(await client.confirm(status(), false)).toEqual({ approvalId, status: "queued", duplicate: false });
    expect(JSON.parse(transport.mock.calls[0]![1]?.body as string).variables).toEqual({ input: {
      taskId, taskVersion: 3, requestId, graphRevision: 1, taskFingerprint: status().request!.taskFingerprint, approved: false,
    } });
  });
  it.each(["canApprove", "authorization", "version", "revision", "plan", "approval", "uncertain", "closed"])("vetoes confirmation for %s without network I/O", async condition => {
    const value = status();
    if (condition === "canApprove") value.canApprove = false;
    if (condition === "authorization") value.request!.authorizationCurrent = false;
    if (condition === "version") value.task.taskVersion++;
    if (condition === "revision") value.request!.plan!.graph.graphRevision++;
    if (condition === "plan") value.request!.plan = null;
    if (condition === "approval") value.request!.approval = { approvalId, approved: true, authorizationCurrent: true, operationStatus: "unobserved" };
    if (condition === "uncertain") value.request!.planningOperationStatus = "uncertain";
    if (condition === "closed") value.task.status = "cancelled";
    const { client, transport } = setup();
    expect(canConfirmQueenPlanning(value)).toBe(false);
    await expect(client.confirm(value, true)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects malformed task IDs and versions before network access", async () => {
    const { client, transport } = setup();
    await expect(client.read("not-a-task")).rejects.toThrow("QUEEN_PLANNING_INPUT_INVALID");
    await expect(client.propose({ ...status().task, taskVersion: 1.5 })).rejects.toThrow("QUEEN_PLANNING_INPUT_INVALID");
    expect(transport).not.toHaveBeenCalled();
  });
  it("keeps old session clients unusable after a revision change", async () => {
    const { client, transport, invalidate } = setup();
    invalidate();
    await expect(client.read(taskId)).rejects.toThrow("AUTH_WALLET_CHANGED");
    expect(transport).not.toHaveBeenCalled();
  });
  it("discards a private readback that completes after wallet invalidation", async () => {
    let resolve!: (response: Response) => void;
    const { client, invalidate } = setup(() => new Promise(r => { resolve = r; }));
    const pending = client.read(taskId);
    invalidate();
    resolve(Response.json({ data: { planningStatus: status() } }));
    await expect(pending).rejects.toThrow("AUTH_WALLET_CHANGED");
  });
  it("checks revision again after slow body decoding, not only after response headers", async () => {
    let release!: (value: unknown) => void;
    const response = Response.json({});
    response.json = () => new Promise(resolve => { release = resolve; });
    const { client, invalidate } = setup(async () => response);
    const pending = client.read(taskId);
    await Promise.resolve();
    invalidate();
    release({ data: { planningStatus: status() } });
    await expect(pending).rejects.toThrow("AUTH_WALLET_CHANGED");
  });
  it("rejects cancelled requests even if the fake transport ignores the abort", async () => {
    let resolve!: (response: Response) => void;
    const { client } = setup(() => new Promise(r => { resolve = r; }));
    const abort = new AbortController();
    const pending = client.read(taskId, abort.signal);
    abort.abort();
    resolve(Response.json({ data: { planningStatus: status() } }));
    await expect(pending).rejects.toThrow("QUEEN_REQUEST_CANCELLED");
  });
  it("honors the existing local reauthentication veto before I/O", async () => {
    const transport = vi.fn<typeof fetch>();
    const client = createQueenPlanningClient({ fetch: transport, assertSession() { throw new Error("AUTH_REAUTH_REQUIRED"); } });
    await expect(client.read(taskId)).rejects.toThrow("AUTH_REAUTH_REQUIRED");
    expect(transport).not.toHaveBeenCalled();
  });
  it("401 disables this client until explicit login creates a new client, without any auto-sign or retry", async () => {
    const { client, transport } = setup(async () => Response.json({ errors: [{ extensions: { code: "AUTH_SESSION_INVALID" } }] }, { status: 401 }));
    await expect(client.read(taskId)).rejects.toThrow("AUTH_SESSION_INVALID");
    await expect(client.propose(status().task)).rejects.toThrow("AUTH_SESSION_INVALID");
    expect(transport).toHaveBeenCalledOnce();
  });
  it.each([
    ["QUEEN_ASYNC_PLANNING_DISABLED", 503],
    ["QUEEN_PLANNING_RECONCILIATION_REQUIRED", 409],
    ["QUEEN_APPROVAL_VERSION_MISMATCH", 409],
  ] as const)("preserves safe actionable %s", async (code, httpStatus) => {
    expect(QUEEN_PLANNING_ERROR_STATUS[code]).toBe(httpStatus);
    const { client, transport } = setup(async () => Response.json({ errors: [{ message: "SQL secret", extensions: { code }, stack: "secret" }] }, { status: httpStatus }));
    const result = client.read(taskId);
    await expect(result).rejects.toBeInstanceOf(QueenPlanningClientError);
    await expect(result).rejects.toHaveProperty("code", code);
    await expect(result).rejects.toHaveProperty("message", code);
    expect(transport).toHaveBeenCalledOnce();
  });
  it("sanitizes unknown server errors", async () => {
    const { client } = setup(async () => Response.json({ errors: [{ message: "SELECT secret", extensions: { code: "postgres://secret" } }] }, { status: 500 }));
    await expect(client.read(taskId)).rejects.toThrow("QUEEN_GRAPHQL_UNAVAILABLE");
  });
  it("sanitizes HTML and invalid JSON", async () => {
    const { client } = setup(async () => new Response("<pre>SQL secret</pre>", { status: 502 }));
    await expect(client.read(taskId)).rejects.toThrow("QUEEN_GRAPHQL_UNAVAILABLE");
  });
  it("times out without a mutation retry", async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init) => new Promise((_, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("secret")), { once: true });
    }));
    const client = createQueenPlanningClient({ fetch: transport, assertSession() {}, timeoutMs: 5 });
    await expect(client.read(taskId)).rejects.toThrow("QUEEN_REQUEST_TIMEOUT");
    expect(transport).toHaveBeenCalledOnce();
  });
  it("binds readback to taskId and refuses falsely verified execution", () => {
    expect(() => parseQueenPlanningStatus(status(), requestId)).toThrow();
    expect(() => parseQueenPlanningStatus({ ...status(), executionVerified: true }, taskId)).toThrow();
  });
  it("allows committed historical graphs while explicitly labeling expired/revoked authorization", () => {
    const value = status(); value.canApprove = false; value.request!.authorizationCurrent = false;
    expect(parseQueenPlanningStatus(value, taskId).request!.plan).not.toBeNull();
    expect(queenPlanningStatusLabel(value)).toContain("expired / revoked / stale");
    expect(queenPlanningStatusLabel(value)).toContain("Execution not verified");
  });
  it("shows uncertainty and committed approval independently of execution completion", () => {
    const value = status(); value.canApprove = false; value.request!.planningOperationStatus = "uncertain"; value.request!.plan = null;
    expect(queenPlanningStatusLabel(parseQueenPlanningStatus(value, taskId))).toContain("Planning: uncertain");
    value.request!.approval = { approvalId, approved: true, authorizationCurrent: true, operationStatus: "committed" };
    expect(queenPlanningStatusLabel(value)).toContain("Approval: committed");
    expect(queenPlanningStatusLabel(value)).toContain("recording is not execution");
  });
});
