import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { Sql } from "postgres";
import { z } from "zod";
import { createQueenDurableApproval } from "../queen-durable-approval";
import type { QueenOperationLedger } from "../queen-operation-ledger";
import { createQueenPlanningApprovalAuthorization } from "../queen-planning-approval-authorization";
import type { QueenTaskGraphPorts } from "../queen-task-graph";
import { QueenWorkflowEventSchema, queenEventOperationKey, type QueenWorkflowEvent } from "../queen-workflow-event";
import type { ScheduleIdentity, ScheduleSnapshot, TemporalActivities } from "./contracts";
import { createLocalPlanningRuntime, type LocalPlanningOptions } from "./planning-runtime";
import { TemporalPlanningReferenceSchema, type TemporalPlanningActivities } from "./planning-contracts";

export function createTemporalPlanningActivities(env: Record<string, string | undefined>,
  options: LocalPlanningOptions): TemporalPlanningActivities | undefined {
  const runtime = createLocalPlanningRuntime(env, options);
  if (!runtime) return undefined;
  return {
    async consumePlanning(input) {
      const parsed = TemporalPlanningReferenceSchema.safeParse(input);
      if (!parsed.success) return { outcome: "rejected" };
      const result = await runtime.consume(parsed.data);
      return { outcome: result.outcome };
    },
  };
}

export const ScheduleIdentitySchema = z.object({
  scopeId: z.string().uuid(), taskId: z.string().uuid(),
  graphRevision: z.number().int().positive(),
  taskFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
}).strict();
const SnapshotSchema = z.object({
  deadlineAt: z.number().int().nonnegative().max(8640000000000000),
  terminal: z.boolean(), approvalRef: z.string().uuid().nullable(),
}).strict();

export interface ScheduleAuthority {
  // Check current owner/scope/revision; read order deadline and committed state.
  inspect(identity: ScheduleIdentity): Promise<ScheduleSnapshot>;
  // Return a persisted business command reference, with a stable operation key.
  // Must reject premature/terminal/stale/unauthorized requests. Compensation
  // requires a separate business grant, not the original execution approval.
  resolveDeadline(identity: ScheduleIdentity): Promise<QueenWorkflowEvent>;
  authorizeDeadline(event: QueenWorkflowEvent): Promise<void>;
  // Route to existing StateGraph/Transaction Engine. Persist result before return.
  // No raw provider calls here; provider operations need their own durable keys.
  executeDeadline(event: QueenWorkflowEvent): Promise<void>;
}

export interface TemporalActivityOptions {
  sql: Sql;
  checkpointer: PostgresSaver;
  ledger: QueenOperationLedger;
  ports: QueenTaskGraphPorts;
  authority: ScheduleAuthority;
}

function boundEvent(raw: unknown, identity: ScheduleIdentity): QueenWorkflowEvent {
  const event = QueenWorkflowEventSchema.parse(raw);
  if (event.scopeId !== identity.scopeId || event.taskId !== identity.taskId
      || event.graphRevision !== identity.graphRevision || event.taskFingerprint !== identity.taskFingerprint
      || event.operationKey !== queenEventOperationKey(event)
      || Date.parse(event.expiresAt) <= Date.now() || Date.parse(event.occurredAt) > Date.now() + 60000) {
    throw new Error("TEMPORAL_BUSINESS_AUTHORIZATION_REJECTED");
  }
  return event;
}

export function createTemporalActivities(options: TemporalActivityOptions): TemporalActivities {
  const authorizeApproval = createQueenPlanningApprovalAuthorization(options.sql);
  const resume = createQueenDurableApproval(options);
  const inspect = async (input: ScheduleIdentity) => {
    const identity = ScheduleIdentitySchema.parse(input);
    return SnapshotSchema.parse(await options.authority.inspect(identity));
  };
  const requireOpen = async (identity: ScheduleIdentity, expired: boolean) => {
    const current = await inspect(identity);
    if (current.terminal || (current.deadlineAt <= Date.now()) !== expired) {
      throw new Error("TEMPORAL_SCHEDULE_STATE_CHANGED");
    }
    return current;
  };
  return {
    inspectSchedule: inspect,
    async resumeApproval(input, approvalRef) {
      const identity = ScheduleIdentitySchema.parse(input);
      z.string().uuid().parse(approvalRef);
      const current = await requireOpen(identity, false);
      if (current.approvalRef !== approvalRef) throw new Error("TEMPORAL_APPROVAL_CHANGED");
      const [row] = await options.sql`
        SELECT approval_event FROM agent_market.queen_planning_requests
        WHERE approval_id = ${approvalRef} AND task_id = ${identity.taskId}
      `;
      const event = boundEvent(row?.approval_event, identity);
      await authorizeApproval(event);
      return options.ledger.execute(event, async () => {
        // Recheck after the durable claim, then the existing graph rechecks every node.
        const fresh = await requireOpen(identity, false);
        if (fresh.approvalRef !== approvalRef) throw new Error("TEMPORAL_APPROVAL_CHANGED");
        boundEvent(event, identity);
        await resume(event);
      });
    },
    async dispatchDeadline(input) {
      const identity = ScheduleIdentitySchema.parse(input);
      await requireOpen(identity, true);
      const event = boundEvent(await options.authority.resolveDeadline(identity), identity);
      if (event.eventType !== "task.resume-requested") throw new Error("TEMPORAL_DEADLINE_EVENT_REJECTED");
      await options.authority.authorizeDeadline(event);
      return options.ledger.execute(event, async () => {
        await requireOpen(identity, true);
        boundEvent(event, identity);
        await options.authority.authorizeDeadline(event);
        await options.authority.executeDeadline(event);
      });
    },
  };
}
