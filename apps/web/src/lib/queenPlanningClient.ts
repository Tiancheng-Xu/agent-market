import { TaskGraphSchema, type TaskGraph } from "@agent-market/shared-contracts";
import { assertWalletSessionAuthenticated, walletSessionRevision } from "./walletSession";

// Browser transport only. AST parsing/execution and authorization stay in TE.
export const QUEEN_PLANNING_PATH = "/api/queen/graphql";
export const QUEEN_PLANNING_OPERATIONS = {
  ProposeTaskGraph: `mutation ProposeTaskGraph($input: ProposeTaskGraphInput!) {
    proposeTaskGraph(input: $input) { requestId status duplicate }
  }`,
  ConfirmTaskGraph: `mutation ConfirmTaskGraph($input: ConfirmTaskGraphInput!) {
    confirmTaskGraph(input: $input) { approvalId status duplicate }
  }`,
  PlanningStatus: `query PlanningStatus($taskId: ID!) {
    planningStatus(taskId: $taskId) {
      task { taskId taskVersion status } canApprove executionVerified
      request {
        requestId taskVersion authorizationCurrent graphRevision taskFingerprint planningOperationStatus
        approval { approvalId approved authorizationCurrent operationStatus }
        plan { recordVersion graph {
          taskId graphRevision requiredStages riskLevel startPolicy
          rescuePolicy { mode visibleToUser evidenceVisible }
          nodes { nodeId type title dependencies required judgesNodeId repairsNodeId assignedAgentId
            contract { schemaVersion contextInputs outputKeys artifactMediaTypes milestone
              acceptanceCriteria budgetAtomic permissions timeoutSeconds failureRoute }
          }
          edges { from to condition }
        } }
      }
    }
  }`,
} as const;

export type PlanningOperationStatus = "unobserved" | "executing" | "committed" | "uncertain";
export interface QueenPlanningStatus {
  task: { taskId: string; taskVersion: number; status: string };
  request: null | {
    requestId: string; taskVersion: number; authorizationCurrent: boolean;
    graphRevision: number; taskFingerprint: string; planningOperationStatus: PlanningOperationStatus;
    plan: null | { recordVersion: number; graph: TaskGraph };
    approval: null | { approvalId: string; approved: boolean; authorizationCurrent: boolean; operationStatus: PlanningOperationStatus };
  };
  canApprove: boolean;
  executionVerified: false;
}

export const QUEEN_PLANNING_ERROR_STATUS: Readonly<Record<string, number>> = {
  METHOD_NOT_ALLOWED: 405, QUEEN_GRAPHQL_INVALID: 400, QUEEN_GRAPHQL_TOO_LARGE: 413,
  QUEEN_GRAPHQL_MEDIA_TYPE: 415, QUEEN_GRAPHQL_OPERATION_FORBIDDEN: 403, QUEEN_GRAPHQL_UNAVAILABLE: 503,
  AUTH_ORIGIN_MISMATCH: 403, AUTH_SESSION_INVALID: 401, AUTH_STORE_UNAVAILABLE: 503,
  QUEEN_ASYNC_PLANNING_DISABLED: 503, QUEEN_PLANNING_INPUT_INVALID: 400, QUEEN_TASK_UNAVAILABLE: 404,
  QUEEN_TASK_VERSION_OR_STATE_CONFLICT: 409, QUEEN_PLANNING_RECONCILIATION_REQUIRED: 409,
  QUEEN_PLANNING_STATE_INVALID: 503, QUEEN_APPROVAL_INPUT_INVALID: 400, QUEEN_APPROVAL_TASK_CONFLICT: 409,
  QUEEN_APPROVAL_VERSION_MISMATCH: 409, QUEEN_APPROVAL_DECISION_CONFLICT: 409, QUEEN_APPROVAL_PLAN_NOT_READY: 409,
};
export class QueenPlanningClientError extends Error {
  constructor(readonly code: string) { super(code); }
}
function fail(code = "QUEEN_GRAPHQL_INVALID_RESPONSE"): never { throw new QueenPlanningClientError(code); }
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function isPlanningTaskId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}
function operationStatus(value: unknown): value is PlanningOperationStatus {
  return value === "unobserved" || value === "executing" || value === "committed" || value === "uncertain";
}
function id(value: unknown): value is string { return typeof value === "string" && isPlanningTaskId(value); }

export function parseQueenPlanningStatus(value: unknown, taskId: string): QueenPlanningStatus {
  if (!record(value) || !record(value.task) || value.task.taskId !== taskId
      || !positive(value.task.taskVersion) || typeof value.task.status !== "string"
      || typeof value.canApprove !== "boolean" || value.executionVerified !== false) fail();
  const task = { taskId, taskVersion: value.task.taskVersion, status: value.task.status };
  if (value.request === null) {
    if (value.canApprove) fail();
    return { task, request: null, canApprove: false, executionVerified: false };
  }
  const r = value.request;
  if (!record(r) || !id(r.requestId) || !positive(r.taskVersion) || !positive(r.graphRevision)
      || typeof r.authorizationCurrent !== "boolean" || typeof r.taskFingerprint !== "string"
      || !/^sha256:[a-f0-9]{64}$/u.test(r.taskFingerprint) || !operationStatus(r.planningOperationStatus)) fail();
  let plan: NonNullable<QueenPlanningStatus["request"]>["plan"] = null;
  if (r.plan !== null) {
    if (!record(r.plan) || !positive(r.plan.recordVersion) || !record(r.plan.graph)
        || !Array.isArray(r.plan.graph.nodes) || !Array.isArray(r.plan.graph.edges)
        || r.planningOperationStatus !== "committed") fail();
    // GraphQL optional fields arrive as null; the domain schema uses omission.
    const stripNull = (entry: unknown) => record(entry)
      ? Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== null)) : entry;
    const parsed = TaskGraphSchema.safeParse({ ...r.plan.graph,
      nodes: r.plan.graph.nodes.map(stripNull), edges: r.plan.graph.edges.map(stripNull) });
    if (!parsed.success || parsed.data.taskId !== taskId) fail();
    plan = { recordVersion: r.plan.recordVersion, graph: parsed.data };
  }
  let approval: NonNullable<QueenPlanningStatus["request"]>["approval"] = null;
  if (r.approval !== null) {
    const a = r.approval;
    if (!record(a) || !id(a.approvalId) || typeof a.approved !== "boolean"
        || typeof a.authorizationCurrent !== "boolean" || !operationStatus(a.operationStatus)) fail();
    approval = { approvalId: a.approvalId, approved: a.approved, authorizationCurrent: a.authorizationCurrent, operationStatus: a.operationStatus };
  }
  const result: QueenPlanningStatus = { task, canApprove: value.canApprove, executionVerified: false,
    request: { requestId: r.requestId, taskVersion: r.taskVersion, authorizationCurrent: r.authorizationCurrent,
      graphRevision: r.graphRevision, taskFingerprint: r.taskFingerprint,
      planningOperationStatus: r.planningOperationStatus, plan, approval } };
  if (value.canApprove && !canConfirmQueenPlanning(result)) fail();
  return result;
}

export function canConfirmQueenPlanning(status: QueenPlanningStatus): boolean {
  const r = status.request;
  return status.canApprove && status.task.status === "open" && r !== null && r.authorizationCurrent
    && r.taskVersion === status.task.taskVersion && r.planningOperationStatus === "committed"
    && r.plan !== null && r.plan.graph.taskId === status.task.taskId
    && r.plan.graph.graphRevision === r.graphRevision && r.approval === null;
}

export function queenPlanningStatusLabel(status: QueenPlanningStatus): string {
  const r = status.request;
  if (!r) return "No persisted planning request";
  const authorization = !r.authorizationCurrent || (r.approval && !r.approval.authorizationCurrent)
    ? "Authorization expired / revoked / stale (server does not distinguish); approval disabled. " : "";
  return `${authorization}Planning: ${r.planningOperationStatus}. ${r.approval
    ? `Approval: ${r.approval.operationStatus} (${r.approval.approved ? "approved" : "rejected"}); recording is not execution.`
    : "No approval recorded."} Execution not verified.`;
}

export function createQueenPlanningClient(options: {
  fetch?: typeof fetch; revision?: () => number; assertSession?: () => void; timeoutMs?: number;
} = {}) {
  const transport = options.fetch ?? fetch;
  const revision = options.revision ?? walletSessionRevision;
  const expected = revision();
  let rejectedSession = false;
  const assertCurrent = (signal?: AbortSignal) => {
    if (revision() !== expected) fail("AUTH_WALLET_CHANGED");
    if (signal?.aborted) fail("QUEEN_REQUEST_CANCELLED");
    if (rejectedSession) fail("AUTH_SESSION_INVALID");
    (options.assertSession ?? assertWalletSessionAuthenticated)();
  };
  async function request(operationName: keyof typeof QUEEN_PLANNING_OPERATIONS, variables: object, signal?: AbortSignal) {
    assertCurrent(signal);
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 12_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let payload: unknown;
    let response: Response;
    try {
      response = await transport(QUEEN_PLANNING_PATH, { method: "POST", credentials: "include",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ operationName, query: QUEEN_PLANNING_OPERATIONS[operationName], variables }), signal: combined });
      payload = await response.json();
    } catch {
      assertCurrent(signal);
      return fail(timeout.aborted ? "QUEEN_REQUEST_TIMEOUT" : "QUEEN_GRAPHQL_UNAVAILABLE");
    }
    assertCurrent(signal);
    if (timeout.aborted) fail("QUEEN_REQUEST_TIMEOUT");
    if (response.status === 401) { rejectedSession = true; fail("AUTH_SESSION_INVALID"); }
    if (!response.ok || (record(payload) && payload.errors !== undefined)) {
      const error = record(payload) && Array.isArray(payload.errors) ? payload.errors[0] : undefined;
      const code = record(error) && record(error.extensions) ? error.extensions.code : undefined;
      fail(typeof code === "string" && Object.hasOwn(QUEEN_PLANNING_ERROR_STATUS, code) ? code : "QUEEN_GRAPHQL_UNAVAILABLE");
    }
    if (!record(payload) || !record(payload.data)) fail();
    return payload.data;
  }
  return {
    async read(taskId: string, signal?: AbortSignal) {
      if (!isPlanningTaskId(taskId)) fail("QUEEN_PLANNING_INPUT_INVALID");
      return parseQueenPlanningStatus((await request("PlanningStatus", { taskId }, signal)).planningStatus, taskId);
    },
    async propose(task: QueenPlanningStatus["task"], signal?: AbortSignal) {
      if (!isPlanningTaskId(task.taskId) || !positive(task.taskVersion) || task.status !== "open") fail("QUEEN_PLANNING_INPUT_INVALID");
      const value = (await request("ProposeTaskGraph", { input: { taskId: task.taskId, taskVersion: task.taskVersion } }, signal)).proposeTaskGraph;
      if (!record(value) || !id(value.requestId) || value.status !== "queued" || typeof value.duplicate !== "boolean") fail();
      return { requestId: value.requestId, status: "queued" as const, duplicate: value.duplicate };
    },
    async confirm(status: QueenPlanningStatus, approved: boolean, signal?: AbortSignal) {
      // Re-validate even if a caller mutated its cached readback object.
      const valid = parseQueenPlanningStatus(status, status.task.taskId);
      if (!canConfirmQueenPlanning(valid) || typeof approved !== "boolean") fail("QUEEN_APPROVAL_PLAN_NOT_READY");
      const r = valid.request!;
      const value = (await request("ConfirmTaskGraph", { input: { taskId: valid.task.taskId, requestId: r.requestId,
        taskVersion: valid.task.taskVersion, graphRevision: r.graphRevision, taskFingerprint: r.taskFingerprint, approved } }, signal)).confirmTaskGraph;
      if (!record(value) || !id(value.approvalId) || value.status !== "queued" || typeof value.duplicate !== "boolean") fail();
      return { approvalId: value.approvalId, status: "queued" as const, duplicate: value.duplicate };
    },
  };
}
