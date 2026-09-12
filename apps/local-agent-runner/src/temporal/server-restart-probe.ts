import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import postgres from "postgres";
import { requestQueenPlanning } from "../../../transaction-engine/src/application/queen-planning-request";
import { QueenOperationLedger } from "../queen-operation-ledger";
import { QueenWorkflowEventSchema, queenEventOperationKey, type QueenWorkflowEvent } from "../queen-workflow-event";
import { createTemporalWorker } from "./worker";
import { createTemporalScheduler } from "./client";
import type { ScheduleAuthority } from "./activities";

// Destructive test boundary: only the explicitly authorized, task-owned dev server.
const binary = "/tmp/agent-market-temporal.m7smAO/temporal";
const sqlite = "/tmp/agent-market-temporal.m7smAO/temporal.sqlite";
const address = "127.0.0.1:7239";
const serverArgs = ["server", "start-dev", "--ip", "127.0.0.1", "--port", "7239", "--headless", "--db-filename", sqlite];
const exec = promisify(execFile);
function check(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
const until = async (predicate: () => Promise<boolean>, attempts = 100) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error("RESTART_PROBE_WAIT_EXHAUSTED");
};
const cli = async (...args: string[]) => (await exec(binary, [...args, "--address", address], { timeout: 5000, maxBuffer: 1048576 })).stdout;
async function runningIds(): Promise<string[]> {
  const rows = JSON.parse(await cli("workflow", "list", "--query", 'ExecutionStatus="Running"', "--output", "json")) as Array<{ execution?: { workflowId?: string } }>;
  return rows.map(row => { check(row.execution?.workflowId, "RUNNING_LIST_UNRECOGNIZED"); return row.execution.workflowId; });
}
async function serverPid() {
  const result = await exec("lsof", ["-t", "-iTCP:7239", "-sTCP:LISTEN"]);
  const pids = result.stdout.trim().split(/\s+/u);
  check(pids.length === 1 && /^\d+$/u.test(pids[0]!), "SERVER_PID_AMBIGUOUS");
  const pid = Number(pids[0]);
  const command = (await exec("ps", ["-p", String(pid), "-o", "command="])).stdout.trim();
  check(command === [binary, ...serverArgs].join(" "), "SERVER_NOT_OWNED_BY_THIS_PROBE");
  return pid;
}

async function main() {
  check(process.env.QUEEN_TEMPORAL_SERVER_RESTART_TEST === "true", "RESTART_PROBE_EXPLICIT_OPT_IN_REQUIRED");
  const databaseUrl = process.env.QUEEN_TEMPORAL_TEST_DATABASE_URL;
  check(databaseUrl, "RESTART_PROBE_DATABASE_REQUIRED");
  const url = new URL(databaseUrl);
  check(url.hostname === "127.0.0.1" && url.port === "55439" && url.pathname === "/am_temporal_test", "RESTART_PROBE_DATABASE_REJECTED");
  check((await runningIds()).length === 0, "OTHER_RUNNING_WORKFLOWS_CONFLICT");
  const oldPid = await serverPid();
  const sql = postgres(databaseUrl, { max: 3, onnotice: () => undefined });
  const ledger = new QueenOperationLedger(databaseUrl, "queen_runtime_public");
  const saver = PostgresSaver.fromConnString(databaseUrl, { schema: "temporal_test_checkpoints" });
  const taskQueue = `restart-probe-${randomUUID()}`;
  const env = { QUEEN_TEMPORAL_ENABLED: "true", QUEEN_LOCAL_PLANNING_ENABLED: "true",
    QUEEN_TEMPORAL_ADDRESS: address, QUEEN_TEMPORAL_TASK_QUEUE: taskQueue };
  let scheduler: Awaited<ReturnType<typeof createTemporalScheduler>>;
  let worker: Awaited<ReturnType<typeof createTemporalWorker>>;
  let running: Promise<void> | undefined;
  let serverStopped = false;
  const restart = async () => {
    const log = await open("/tmp/agent-market-temporal.m7smAO/restart-probe-server.log", "a");
    try {
      const child = spawn(binary, serverArgs, { detached: true, stdio: ["ignore", log.fd, log.fd] });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
    } finally { await log.close(); }
    await until(async () => {
      try { return (await cli("operator", "cluster", "health")).includes("SERVING"); } catch { return false; }
    }, 30);
    serverStopped = false;
  };
  try {
    await sql`CREATE TABLE IF NOT EXISTS public.temporal_restart_probe_effects (
      operation_key text PRIMARY KEY, task_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS public.temporal_restart_probe_schedule (
      task_id uuid PRIMARY KEY, event jsonb NOT NULL, deadline_at bigint NOT NULL, terminal boolean NOT NULL DEFAULT false
    )`;
    const identity = { taskId: randomUUID(), scopeId: randomUUID(), graphRevision: 1, taskFingerprint: `sha256:${"a".repeat(64)}` };
    const deadlineEvent: QueenWorkflowEvent = { ...identity, schemaVersion: "queen-workflow-event.v1",
      eventType: "task.resume-requested", eventId: randomUUID(), payloadRef: randomUUID(),
      payloadHash: `sha256:${"b".repeat(64)}`, operationKey: "", occurredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600000).toISOString() };
    deadlineEvent.operationKey = queenEventOperationKey(deadlineEvent);
    const authorize: ScheduleAuthority["authorizeDeadline"] = async event => {
      const [row] = await sql`SELECT 1 FROM public.temporal_restart_probe_schedule WHERE task_id = ${event.taskId}
        AND event = ${sql.json(event)} AND NOT terminal AND deadline_at <= extract(epoch FROM clock_timestamp()) * 1000`;
      check(row, "RESTART_PROBE_DEADLINE_DENIED");
    };
    const authority: ScheduleAuthority = {
      inspect: async input => {
        check(input.taskId === identity.taskId && input.scopeId === identity.scopeId
          && input.graphRevision === identity.graphRevision && input.taskFingerprint === identity.taskFingerprint,
        "RESTART_PROBE_SCOPE_DENIED");
        const [row] = await sql`SELECT deadline_at, terminal FROM public.temporal_restart_probe_schedule WHERE task_id = ${input.taskId}`;
        check(row, "RESTART_PROBE_ORDER_MISSING");
        return { deadlineAt: Number(row.deadline_at), terminal: Boolean(row.terminal), approvalRef: null };
      },
      resolveDeadline: async () => deadlineEvent,
      authorizeDeadline: authorize,
      executeDeadline: async event => {
        await authorize(event);
        await sql.begin(async tx => {
          await tx`INSERT INTO public.temporal_restart_probe_effects (operation_key,task_id) VALUES (${event.operationKey},${event.taskId})`;
          await tx`UPDATE public.temporal_restart_probe_schedule SET terminal = true WHERE task_id = ${event.taskId}`;
        });
      },
    };
    const denied = async (): Promise<never> => { throw new Error("RESTART_PROBE_EXECUTION_DENIED"); };
    const options = { sql, checkpointer: saver, ledger, authority,
      ports: { authorize: denied, plan: denied, execute: denied, judge: denied, repair: denied, finalize: denied },
      planning: { queenAgentId: "queen-test", agents: [{ agentId: "queen-test", displayName: "Fixture Queen", capabilities: ["plan"], tags: [],
        provider: "qwen" as const, ownership: "third-party/provider-api" as const, selectableBy: "public-market" as const,
        status: "degraded" as const, costPer1kTokensUsd: 0, qualityScore: 0.9, modelTag: "fixture-queen",
        modelDigest: "provider-managed", riskCodes: [] }] } };
    scheduler = await createTemporalScheduler(env);
    worker = await createTemporalWorker(env, options);
    running = worker!.run();
    const deadlineAt = Date.now() + 15000;
    await sql`INSERT INTO public.temporal_restart_probe_schedule (task_id,event,deadline_at)
      VALUES (${identity.taskId},${sql.json(deadlineEvent)},${deadlineAt})`;
    const order = await scheduler!.start(identity);
    await until(async () => (await order.fetchHistory()).events?.some(event => Boolean(event.timerStartedEventAttributes)) ?? false);
    const orderRunId = (await order.describe()).runId;
    worker!.shutdown(); await running; running = undefined;

    const taskId = randomUUID(), wallet = `0x${"a".repeat(40)}`;
    await sql`INSERT INTO agent_market.tasks (id,publisher_wallet,title,description,budget_atomic,request_id)
      VALUES (${taskId},${wallet},'Restart probe','Local-only fixture',100,${randomUUID()})`;
    const request = await requestQueenPlanning(sql, { taskId, actorWallet: wallet, expectedTaskVersion: 1 });
    const [record] = await sql`SELECT event FROM agent_market.queen_planning_requests WHERE id = ${request.requestId}`;
    const event = QueenWorkflowEventSchema.parse(record!.event);
    // Commit an actual SQL effect, then lose its acknowledgement. Do not pretend
    // this fixture effect is provider execution or completed business planning.
    check(await ledger.execute(event, async () => {
      await sql`INSERT INTO public.temporal_restart_probe_effects (operation_key,task_id) VALUES (${event.operationKey},${taskId})`;
      throw new Error("FIXTURE_ACK_LOST_AFTER_SQL_COMMIT");
    }) === "uncertain", "UNCERTAIN_FIXTURE_NOT_DURABLE");
    const ref = { requestId: request.requestId, taskId, scopeId: event.scopeId };
    const planning = await scheduler!.startPlanning(ref);
    const planningRunId = (await planning.describe()).runId;
    const active = await runningIds();
    check(active.every(id => id === order.workflowId || id === planning.workflowId), "OTHER_RUNNING_WORKFLOWS_CONFLICT");
    check(await serverPid() === oldPid, "SERVER_PID_CHANGED_BEFORE_RESTART");
    await scheduler!.close(); scheduler = undefined;
    process.kill(oldPid, "SIGTERM"); serverStopped = true;
    await until(async () => {
      try { process.kill(oldPid, 0); return false; } catch { return true; }
    });
    await restart();
    const newPid = await serverPid();
    check(newPid !== oldPid, "SERVER_PROCESS_NOT_REPLACED");
    scheduler = await createTemporalScheduler(env);
    worker = await createTemporalWorker(env, options);
    running = worker!.run();
    // Fetch with fresh SDK connection, proving server persistence rather than cached handles.
    const { Client, Connection } = await import("@temporalio/client");
    const fresh = await Connection.connect({ address });
    try {
      const client = new Client({ connection: fresh });
      const resumedOrder = client.workflow.getHandle(order.workflowId);
      const resumedPlanning = client.workflow.getHandle(planning.workflowId);
      check((await resumedOrder.describe()).runId === orderRunId, "ORDER_RUN_CHANGED");
      check((await resumedPlanning.describe()).runId === planningRunId, "PLANNING_RUN_CHANGED");
      check(await resumedOrder.result() === "deadline-dispatched", "TIMER_RECOVERY_FAILED");
      const planningResult = await resumedPlanning.result() as { outcome?: string };
      check(planningResult.outcome === "uncertain", "UNCERTAIN_OPERATION_REPLAYED");
      const history = await resumedOrder.fetchHistory();
      check(history.events?.some(item => item.timerFiredEventAttributes), "DURABLE_TIMER_DID_NOT_FIRE");
      let duplicateRejected = false;
      try { await scheduler!.startPlanning(ref); } catch (error) {
        duplicateRejected = error instanceof Error && error.name === "WorkflowExecutionAlreadyStartedError";
      }
      check(duplicateRejected, "WORKFLOW_ID_NOT_DEDUPLICATED");
      const [effects] = await sql`SELECT
        count(*) FILTER (WHERE operation_key = ${event.operationKey})::integer AS uncertain_count,
        count(*) FILTER (WHERE operation_key = ${deadlineEvent.operationKey})::integer AS deadline_count
        FROM public.temporal_restart_probe_effects`;
      check(effects!.uncertain_count === 1 && effects!.deadline_count === 1, "SIDE_EFFECT_COUNT_CHANGED");
      const [operation] = await sql`SELECT status FROM queen_runtime_public.queen_operations WHERE operation_key = ${event.operationKey}`;
      check(operation!.status === "uncertain", "UNCERTAIN_LEDGER_CHANGED");
      const evidence = { schemaVersion: "temporal-server-restart-evidence.v1", verifiedAt: new Date().toISOString(),
        status: "verified-local", server: { address, storage: "task-owned-sqlite", processReplaced: true, sameStorage: true },
        database: "dedicated-local-test", workflowIds: { order: order.workflowId, planning: planning.workflowId },
        checks: { sameOrderRun: true, samePlanningRun: true, persistedTimerFired: true, deadlineEffects: effects!.deadline_count,
          uncertainEffects: effects!.uncertain_count, uncertainLedgerRetained: true, duplicateWorkflowRejected: true },
        limits: ["development-server-only", "fixture-sql-effect-not-provider", "no-production-supervisor", "no-cloud-or-chain"] };
      await writeFile(new URL("./server-restart.evidence.json", import.meta.url), JSON.stringify(evidence, null, 2) + "\n");
      process.stdout.write(JSON.stringify({ status: "verified-local", checks: evidence.checks }) + "\n");
    } finally { await fresh.close(); }
  } finally {
    if (serverStopped) await restart();
    if (running) { worker!.shutdown(); await running; }
    await scheduler?.close(); await ledger.close(); await saver.end(); await sql.end({ timeout: 5 });
  }
}

try { await main(); } catch (error) {
  const code = error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : "RESTART_PROBE_FAILED";
  process.stderr.write(JSON.stringify({ status: "failed", code }) + "\n"); process.exitCode = 1;
}
