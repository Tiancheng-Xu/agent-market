import { createHash, randomUUID } from "node:crypto";
import {
  QueenPlanningApprovalPayloadSchema,
  canonicalQueenPlanningApprovalBinding,
} from "@agent-market/shared-contracts";
import type { Sql } from "postgres";
import { validate as isUuid } from "uuid";
import { QueenPlanningError } from "./queen-planning-request";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const WALLET = /^0x[0-9a-f]{40}$/u;
const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

export type ApprovalInput = {
  requestId: string;
  taskId: string;
  actorWallet: string;
  expectedTaskVersion: number;
  graphRevision: number;
  taskFingerprint: string;
  approved: boolean;
};

export async function recordQueenPlanningApproval(sql: Sql, input: ApprovalInput) {
  if (!isUuid(input.requestId) || !isUuid(input.taskId) || !WALLET.test(input.actorWallet)
      || !Number.isSafeInteger(input.expectedTaskVersion) || input.expectedTaskVersion < 1
      || !Number.isSafeInteger(input.graphRevision) || input.graphRevision < 1
      || !DIGEST.test(input.taskFingerprint) || typeof input.approved !== "boolean") {
    throw new QueenPlanningError("QUEEN_APPROVAL_INPUT_INVALID", 400);
  }
  const wallet = input.actorWallet.toLowerCase();
  return sql.begin(async tx => {
    const [row] = await tx`
      SELECT request.*, task.version AS current_task_version, task.status AS current_task_status,
        task.publisher_wallet AS current_publisher_wallet
      FROM agent_market.queen_planning_requests request
      JOIN agent_market.tasks task ON task.id = request.task_id
      WHERE request.id = ${input.requestId} AND request.task_id = ${input.taskId}
      FOR UPDATE OF request, task
    `;
    if (!row || String(row.current_publisher_wallet).toLowerCase() !== wallet
        || String(row.publisher_wallet).toLowerCase() !== wallet) {
      throw new QueenPlanningError("QUEEN_TASK_UNAVAILABLE", 404);
    }
    if (row.current_task_version !== input.expectedTaskVersion
        || row.task_version !== input.expectedTaskVersion || row.current_task_status !== "open"
        || row.status !== "requested" || new Date(row.expires_at as string | Date).getTime() <= Date.now()) {
      throw new QueenPlanningError("QUEEN_APPROVAL_TASK_CONFLICT", 409);
    }
    const planningEvent = row.event as Record<string, unknown>;
    if (planningEvent.graphRevision !== input.graphRevision
        || planningEvent.taskFingerprint !== input.taskFingerprint) {
      throw new QueenPlanningError("QUEEN_APPROVAL_VERSION_MISMATCH", 409);
    }
    if (row.approval_id) {
      if (row.approval_decision !== input.approved) {
        throw new QueenPlanningError("QUEEN_APPROVAL_DECISION_CONFLICT", 409);
      }
      return { approvalId: String(row.approval_id), status: "queued" as const, duplicate: true };
    }
    const [workflow] = await tx`
      SELECT record_version, graph_revision, snapshot
      FROM queen_runtime_public.queen_workflows WHERE task_id = ${input.taskId} FOR SHARE
    `;
    const snapshot = workflow?.snapshot as Record<string, unknown> | undefined;
    const graph = snapshot?.graph;
    if (!workflow || workflow.graph_revision !== input.graphRevision
        || !graph || (graph as Record<string, unknown>).graphRevision !== input.graphRevision
        || snapshot?.taskId !== input.taskId || snapshot?.graphConfirmedRevision !== null || snapshot?.runId !== null) {
      throw new QueenPlanningError("QUEEN_APPROVAL_PLAN_NOT_READY", 409);
    }
    let binding: ReturnType<typeof canonicalQueenPlanningApprovalBinding>;
    try {
      binding = canonicalQueenPlanningApprovalBinding({
        graph,
        assignments: snapshot.assignments,
        approvedRevision: input.graphRevision,
        allowSystemAppended: false,
      });
    } catch {
      throw new QueenPlanningError("QUEEN_APPROVAL_PLAN_NOT_READY", 409);
    }
    const graphHash = digest(binding.graph);
    const assignmentHash = digest(binding.assignments);
    const approvalId = randomUUID();
    const payload = QueenPlanningApprovalPayloadSchema.parse({
      version: "queen-planning-approval.v1", action: "approve",
      requestId: input.requestId, taskId: input.taskId, taskVersion: input.expectedTaskVersion,
      graphRevision: input.graphRevision, taskFingerprint: input.taskFingerprint,
      graphHash, assignmentHash,
      approved: input.approved,
    });
    const payloadHash = digest(payload);
    const [clock] = await tx`SELECT clock_timestamp() AS now`;
    const now = new Date(clock!.now as string | Date);
    const expiresAt = new Date(Math.min(
      new Date(row.expires_at as string | Date).getTime(), now.getTime() + 3600000,
    )).toISOString();
    const event = {
      schemaVersion: "queen-workflow-event.v1", eventId: randomUUID(),
      eventType: "task.approval-recorded", taskId: input.taskId,
      scopeId: String(planningEvent.scopeId), graphRevision: input.graphRevision,
      taskFingerprint: input.taskFingerprint, payloadRef: approvalId, payloadHash,
      operationKey: "", occurredAt: now.toISOString(), expiresAt,
    };
    event.operationKey = digest([
      "queen-workflow-event.v1", event.eventType, event.scopeId, event.taskId,
      event.graphRevision, event.taskFingerprint, event.payloadRef, event.payloadHash,
    ]);
    await tx`
      UPDATE agent_market.queen_planning_requests
      SET approval_id = ${approvalId}, approval_decision = ${input.approved},
        approval_payload = ${tx.json(payload)}, approval_event = ${tx.json(event)},
        approval_expires_at = ${expiresAt}
      WHERE id = ${input.requestId}
    `;
    await tx`
      INSERT INTO queen_runtime_public.queen_outbox (event_id, operation_key, event, status)
      VALUES (${event.eventId}, ${event.operationKey}, ${tx.json(event)}, 'pending')
    `;
    return { approvalId, status: "queued" as const, duplicate: false };
  });
}
