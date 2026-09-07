import { createHash } from "node:crypto";
import {
  QueenPlanningApprovalPayloadSchema,
  canonicalQueenPlanningApprovalBinding,
  type QueenPlanningApprovalPayload as ApprovalPayload,
} from "@agent-market/shared-contracts";
import type { Sql } from "postgres";
import { z } from "zod";
import { QueenWorkflowEventSchema, queenEventOperationKey, type QueenWorkflowEvent } from "./queen-workflow-event";

export type QueenPlanningApprovalPayload = ApprovalPayload & {
  riskLevel: "low" | "high";
};

const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

export function createQueenPlanningApprovalAuthorization(sql: Sql) {
  return async (input: QueenWorkflowEvent): Promise<QueenPlanningApprovalPayload> => {
    const event = QueenWorkflowEventSchema.parse(input);
    if (event.eventType !== "task.approval-recorded"
        || event.operationKey !== queenEventOperationKey(event)) {
      throw new Error("QUEEN_APPROVAL_EVENT_REJECTED");
    }
    const [row] = await sql`
      SELECT request.id, request.task_version, request.publisher_wallet AS authorized_wallet,
        request.status AS request_status, request.expires_at > clock_timestamp() AS request_valid,
        request.approval_payload, request.approval_event,
        request.approval_expires_at > clock_timestamp() AS approval_valid,
        task.version, task.status, task.publisher_wallet,
        workflow.graph_revision, workflow.snapshot
      FROM agent_market.queen_planning_requests request
      JOIN agent_market.tasks task ON task.id = request.task_id
      JOIN queen_runtime_public.queen_workflows workflow ON workflow.task_id = request.task_id
      WHERE request.approval_id = ${event.payloadRef} AND request.task_id = ${event.taskId}
    `;
    const snapshot = row?.snapshot as Record<string, unknown> | undefined;
    const graph = snapshot?.graph;
    const runId = snapshot?.runId;
    const preStartSnapshot = snapshot?.graphConfirmedRevision === null && runId === null;
    const startedSnapshot = snapshot?.graphConfirmedRevision === event.graphRevision
      && typeof runId === "string"
      && z.string().uuid().safeParse(runId).success;
    if (!row || !row.request_valid || !row.approval_valid || row.request_status !== "requested"
        || row.status !== "open" || row.version !== row.task_version
        || String(row.publisher_wallet).toLowerCase() !== String(row.authorized_wallet).toLowerCase()
        || typeof row.graph_revision !== "number" || row.graph_revision < event.graphRevision
        || !graph || (graph as Record<string, unknown>).graphRevision !== row.graph_revision
        || snapshot?.taskId !== event.taskId || (!preStartSnapshot && !startedSnapshot)) {
      throw new Error("QUEEN_APPROVAL_AUTHORIZATION_REJECTED");
    }
    const authorizedEvent = QueenWorkflowEventSchema.parse(row.approval_event);
    if (Object.keys(authorizedEvent).some(key =>
      authorizedEvent[key as keyof QueenWorkflowEvent] !== event[key as keyof QueenWorkflowEvent])) {
      throw new Error("QUEEN_APPROVAL_EVENT_MISMATCH");
    }
    const payload = QueenPlanningApprovalPayloadSchema.parse(row.approval_payload);
    const binding = canonicalQueenPlanningApprovalBinding({
      graph,
      assignments: snapshot?.assignments,
      approvedRevision: event.graphRevision,
      allowSystemAppended: true,
    });
    if (payload.requestId !== row.id || payload.taskId !== event.taskId
        || payload.taskVersion !== row.version || payload.graphRevision !== event.graphRevision
        || payload.taskFingerprint !== event.taskFingerprint || digest(payload) !== event.payloadHash
        || digest(binding.graph) !== payload.graphHash
        || digest(binding.assignments) !== payload.assignmentHash) {
      throw new Error("QUEEN_APPROVAL_PAYLOAD_MISMATCH");
    }
    const riskLevel = (graph as Record<string, unknown>).riskLevel;
    if (riskLevel !== "low" && riskLevel !== "high") throw new Error("QUEEN_APPROVAL_RISK_LEVEL_INVALID");
    return { ...payload, riskLevel };
  };
}
