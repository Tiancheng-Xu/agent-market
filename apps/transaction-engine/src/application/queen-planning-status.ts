import { createHash } from "node:crypto";
import { canonicalQueenPlanningApprovalBinding, QueenTransportEventSchema, queenTransportOperationParts, TaskGraphSchema } from "@agent-market/shared-contracts";
import type { Sql } from "postgres";
import { validate as isUuid } from "uuid";
import { QueenPlanningError } from "./queen-planning-request";

export type PlanningStatusInput = { taskId: string; actorWallet: string };
const invalid = (): never => { throw new QueenPlanningError("QUEEN_PLANNING_STATE_INVALID", 503); };
function operationStatus(value: unknown) {
  if (value === null || value === undefined) return "unobserved" as const;
  if (value === "executing" || value === "committed" || value === "uncertain") return value;
  return invalid();
}

/** Owner-only readback, never a grant. One SELECT keeps ownership and state on
 * one database snapshot. Projected fields exclude raw payloads/node outputs. */
export async function readQueenPlanningStatus(sql: Sql, input: PlanningStatusInput) {
  if (!isUuid(input.taskId) || !/^0x[0-9a-f]{40}$/iu.test(input.actorWallet)) {
    throw new QueenPlanningError("QUEEN_PLANNING_INPUT_INVALID", 400);
  }
  const wallet = input.actorWallet.toLowerCase();
  const [row] = await sql`
    SELECT task.id AS task_id, task.version AS task_version, task.status AS task_status,
      request.id AS request_id, request.task_version AS request_version,
      request.publisher_wallet AS request_publisher, request.status AS request_status,
      request.allowed_action, request.event, request.expires_at > clock_timestamp() AS request_valid,
      request.approval_id, request.approval_decision,
      request.approval_expires_at > clock_timestamp() AS approval_valid,
      workflow.record_version, workflow.graph_revision, workflow.snapshot,
      planning.status AS planning_operation_status, approval.status AS approval_operation_status
    FROM agent_market.tasks task
    LEFT JOIN LATERAL (
      SELECT * FROM agent_market.queen_planning_requests
      WHERE task_id = task.id ORDER BY task_version DESC, created_at DESC LIMIT 1
    ) request ON true
    LEFT JOIN queen_runtime_public.queen_workflows workflow ON workflow.task_id = task.id
    LEFT JOIN queen_runtime_public.queen_operations planning
      ON planning.operation_key = request.event ->> 'operationKey'
      AND planning.task_id = task.id AND planning.scope_id::text = request.event ->> 'scopeId'
      AND planning.payload_hash = request.event ->> 'payloadHash'
    LEFT JOIN queen_runtime_public.queen_operations approval
      ON approval.operation_key = request.approval_event ->> 'operationKey'
      AND approval.task_id = task.id AND approval.scope_id::text = request.approval_event ->> 'scopeId'
      AND approval.payload_hash = request.approval_event ->> 'payloadHash'
    WHERE task.id = ${input.taskId} AND lower(task.publisher_wallet) = ${wallet}
  `;
  if (!row || (row.request_id && String(row.request_publisher).toLowerCase() !== wallet)) {
    throw new QueenPlanningError("QUEEN_TASK_UNAVAILABLE", 404);
  }
  const task = { taskId: String(row.task_id), taskVersion: Number(row.task_version), status: String(row.task_status) };
  if (!row.request_id) return { task, request: null, canApprove: false, executionVerified: false as const };
  const parsedEvent = QueenTransportEventSchema.safeParse(row.event);
  if (!parsedEvent.success || parsedEvent.data.eventType !== "task.requested"
      || parsedEvent.data.taskId !== input.taskId || parsedEvent.data.payloadRef !== row.request_id) return invalid();
  const event = parsedEvent.data;
  const expectedKey = `sha256:${createHash("sha256").update(JSON.stringify(queenTransportOperationParts(event))).digest("hex")}`;
  if (event.operationKey !== expectedKey) return invalid();
  const planningStatus = operationStatus(row.planning_operation_status);
  const approvalStatus = operationStatus(row.approval_operation_status);
  const current = row.request_status === "requested" && row.allowed_action === "plan"
    && row.request_valid === true && Date.parse(event.expiresAt) > Date.now()
    && row.task_version === row.request_version && row.task_status === "open";
  let plan: { recordVersion: number; graph: ReturnType<typeof TaskGraphSchema.parse> } | null = null;
  let canApprove = false;
  if (planningStatus === "committed") {
    const snapshot = row.snapshot as Record<string, unknown> | null;
    const graph = TaskGraphSchema.safeParse(snapshot?.graph);
    if (!graph.success || !Number.isSafeInteger(row.record_version) || row.record_version < 1
        || graph.data.taskId !== input.taskId || snapshot?.taskId !== input.taskId
        || snapshot.recordVersion !== row.record_version || graph.data.graphRevision !== row.graph_revision) return invalid();
    plan = { recordVersion: row.record_version, graph: graph.data };
    if (current && !row.approval_id && graph.data.graphRevision === event.graphRevision
        && snapshot.graphConfirmedRevision === null && snapshot.runId === null) {
      try {
        canonicalQueenPlanningApprovalBinding({ graph: graph.data, assignments: snapshot.assignments,
          approvedRevision: event.graphRevision, allowSystemAppended: false });
        canApprove = true;
      } catch { /* Incomplete assignments are visible but never approvable. */ }
    }
  }
  return { task, request: {
    requestId: String(row.request_id), taskVersion: Number(row.request_version),
    authorizationCurrent: current, graphRevision: event.graphRevision, taskFingerprint: event.taskFingerprint,
    planningOperationStatus: planningStatus, plan,
    approval: row.approval_id ? { approvalId: String(row.approval_id), approved: row.approval_decision === true,
      authorizationCurrent: current && row.approval_valid === true, operationStatus: approvalStatus } : null,
  }, canApprove, executionVerified: false as const };
}
