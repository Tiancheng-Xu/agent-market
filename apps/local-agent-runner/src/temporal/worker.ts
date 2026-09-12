import { fileURLToPath } from "node:url";
import { temporalConfig } from "./config";
import { createTemporalActivities, createTemporalPlanningActivities, type TemporalActivityOptions } from "./activities";
import type { LocalPlanningOptions } from "./planning-runtime";

// Host owns SQL, PostgresSaver and the ledger. No new database/SDK connection
// is made when disabled. The host must supply actual business ports.
export async function createTemporalWorker(
  env: Record<string, string | undefined>, options: TemporalActivityOptions & {
    planning?: Pick<LocalPlanningOptions, "agents" | "queenAgentId">;
  },
) {
  const config = temporalConfig(env);
  if (!config) return undefined;
  if (env.QUEEN_LOCAL_PLANNING_ENABLED === "true" && !options.planning) {
    throw new Error("TEMPORAL_PLANNING_CONFIG_REQUIRED");
  }
  const planningActivities = options.planning ? createTemporalPlanningActivities(env, {
    sql: options.sql, authorizationSql: options.sql, ledger: options.ledger,
    checkpointer: options.checkpointer, ...options.planning,
  }) : undefined;
  const { NativeConnection, Worker } = await import("@temporalio/worker");
  const connection = await NativeConnection.connect({ address: config.address });
  try {
    const worker = await Worker.create({
      connection, namespace: config.namespace, taskQueue: config.taskQueue,
      workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
      activities: { ...createTemporalActivities(options), ...planningActivities },
      maxConcurrentActivityTaskExecutions: 2,
      shutdownGraceTime: "35 seconds",
    });
    return {
      // Caller awaits run(), and calls shutdown() on SIGINT/SIGTERM.
      run: async () => { try { await worker.run(); } finally { await connection.close(); } },
      shutdown: () => worker.shutdown(),
    };
  } catch {
    await connection.close();
    throw new Error("TEMPORAL_WORKER_START_FAILED");
  }
}
