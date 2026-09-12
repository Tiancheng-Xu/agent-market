import { queenTaskThreadId } from "../queen-task-graph";
import { createHash } from "node:crypto";
import { TemporalPlanningReferenceSchema, type TemporalPlanningReference, type TemporalPlanningResult } from "./planning-contracts";
import { ScheduleIdentitySchema } from "./activities";
import { temporalConfig } from "./config";
import { SCHEDULE_CHANGED_SIGNAL, type ScheduleIdentity } from "./contracts";

export async function createTemporalScheduler(env: Record<string, string | undefined>) {
  const config = temporalConfig(env);
  if (!config) return undefined;
  const { Client, Connection } = await import("@temporalio/client");
  const connection = await Connection.connect({ address: config.address });
  const client = new Client({ connection, namespace: config.namespace });
  const workflowId = (input: ScheduleIdentity) => `queen-order-v1-${queenTaskThreadId(ScheduleIdentitySchema.parse(input))}`;
  return {
    startPlanning: async (input: TemporalPlanningReference) => {
      if (env.QUEEN_LOCAL_PLANNING_ENABLED !== "true") throw new Error("TEMPORAL_PLANNING_DISABLED");
      const reference = TemporalPlanningReferenceSchema.parse(input);
      const id = createHash("sha256").update(JSON.stringify([
        "queen-planning-v1", reference.scopeId, reference.taskId, reference.requestId,
      ])).digest("hex");
      return client.workflow.start<(reference: TemporalPlanningReference) => Promise<TemporalPlanningResult>>("queenPlanningRequest", {
        workflowId: `queen-planning-v1-${id}`, taskQueue: config.taskQueue, args: [reference],
        workflowIdReusePolicy: "REJECT_DUPLICATE", workflowExecutionTimeout: "6 minutes",
        retry: { maximumAttempts: 1 },
      });
    },
    // Call only from a server-authorized order handler. SDK access is not a user API.
    start: (input: ScheduleIdentity) => client.workflow.start("queenOrderSchedule", {
      workflowId: workflowId(input), taskQueue: config.taskQueue,
      args: [ScheduleIdentitySchema.parse(input)],
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      workflowExecutionTimeout: "45 days",
      retry: { maximumAttempts: 1 },
    }),
    notifyChanged: (input: ScheduleIdentity) => client.workflow.getHandle(workflowId(input)).signal(SCHEDULE_CHANGED_SIGNAL),
    close: () => connection.close(),
  };
}
