import { Command } from "@langchain/langgraph";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { Sql } from "postgres";
import { createQueenPlanningApprovalAuthorization } from "./queen-planning-approval-authorization";
import {
  createQueenTaskGraph, QueenTaskStateSchema, queenTaskThreadId,
  type QueenTaskGraphPorts,
} from "./queen-task-graph";
import type { QueenWorkflowEvent } from "./queen-workflow-event";

export function createQueenDurableApproval(options: {
  sql: Sql;
  checkpointer: PostgresSaver;
  ports: QueenTaskGraphPorts;
}) {
  const resolve = createQueenPlanningApprovalAuthorization(options.sql);
  return async (event: QueenWorkflowEvent) => {
    const approval = await resolve(event);
    const identity = QueenTaskStateSchema.parse({
      scopeId: event.scopeId,
      taskId: event.taskId,
      graphRevision: event.graphRevision,
      taskFingerprint: event.taskFingerprint,
      riskLevel: approval.riskLevel,
    });
    const config = { configurable: { thread_id: queenTaskThreadId(identity) } };
    const graph = createQueenTaskGraph({
      authorize: async (state, action) => {
        const current = await resolve(event);
        if (current.approved !== approval.approved) throw new Error("QUEEN_APPROVAL_CHANGED");
        if (action !== "approve") {
          if (!current.approved) throw new Error("QUEEN_APPROVAL_REQUIRED");
          await options.ports.authorize(state, action);
        }
      },
      plan: async () => { throw new Error("QUEEN_PLANNING_MUST_NOT_REPEAT"); },
      execute: options.ports.execute,
      judge: options.ports.judge,
      repair: options.ports.repair,
      finalize: options.ports.finalize,
      ...(options.ports.redTeam ? { redTeam: options.ports.redTeam } : {}),
    }, options.checkpointer);
    const before = await graph.getState(config);
    if (!before.next.includes("approval")) throw new Error("QUEEN_APPROVAL_CHECKPOINT_NOT_READY");
    const result = QueenTaskStateSchema.parse(await graph.invoke(new Command({ resume: {
      approved: approval.approved,
      graphRevision: event.graphRevision,
      taskFingerprint: event.taskFingerprint,
    } }), config));
    const after = await graph.getState(config);
    const expectedStatus = approval.approved ? "completed" : "rejected";
    if (result.status !== expectedStatus || after.next.length !== 0) {
      throw new Error("QUEEN_APPROVAL_CHECKPOINT_NOT_DURABLE");
    }
    await resolve(event);
    return result;
  };
}
