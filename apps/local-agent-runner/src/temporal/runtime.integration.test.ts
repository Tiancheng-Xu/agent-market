import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { AgentCandidate } from "@agent-market/shared-contracts";
import postgres from "postgres";
import { expect, it } from "vitest";
import { requestQueenPlanning } from "../../../transaction-engine/src/application/queen-planning-request";
import { recordQueenPlanningApproval } from "../../../transaction-engine/src/application/queen-planning-approval";
import { createQueenDurablePlanning } from "../queen-durable-planning";
import { QueenOperationLedger } from "../queen-operation-ledger";
import { QueenWorkflowEventSchema, queenEventOperationKey, type QueenWorkflowEvent } from "../queen-workflow-event";
import { createQueenTaskGraph, queenTaskThreadId } from "../queen-task-graph";
import { createTemporalActivities, type ScheduleAuthority } from "./activities";
import { createTemporalScheduler } from "./client";
import { createTemporalWorker } from "./worker";
import type { ScheduleIdentity } from "./contracts";

const databaseUrl = process.env.QUEEN_TEMPORAL_TEST_DATABASE_URL;
const address = process.env.QUEEN_TEMPORAL_TEST_ADDRESS;
const candidate = (agentId: string, capabilities: string[]): AgentCandidate => ({
  agentId, displayName: agentId, capabilities, tags: [], provider: "qwen",
  ownership: "third-party/provider-api", selectableBy: "public-market", status: "online",
  costPer1kTokensUsd: 0.01, latencyMs: 100, qualityScore: 0.9,
  firstSeenAt: "2026-01-01T00:00:00.000Z", modelTag: agentId,
  modelDigest: "provider-managed", riskCodes: [],
});

// Real Temporal gRPC + Worker + PostgreSQL. Test-only schedule commands write
// PostgreSQL rows; they do not pretend to perform production refunds or inference.
it.skipIf(!databaseUrl || !address)("real Temporal timers survive worker replacement; approval and uncertain claims remain authoritative", async () => {
  const url = new URL(databaseUrl!);
  if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/am_temporal_test") {
    throw new Error("DEDICATED_TEMPORAL_TEST_DATABASE_REQUIRED");
  }
  const sql = postgres(url.toString(), { max: 4 });
  const saver = PostgresSaver.fromConnString(url.toString(), { schema: "temporal_test_checkpoints" });
  const ledger = new QueenOperationLedger(url.toString(), "queen_runtime_public");
  const env = { QUEEN_TEMPORAL_ENABLED: "true", QUEEN_TEMPORAL_ADDRESS: address,
    QUEEN_TEMPORAL_TASK_QUEUE: `temporal-test-${randomUUID()}` };
  let scheduler: Awaited<ReturnType<typeof createTemporalScheduler>>;
  let worker: Awaited<ReturnType<typeof createTemporalWorker>>;
  let running: Promise<void> | undefined;
  try {
    const [existing] = await sql`SELECT to_regclass('agent_market.tasks') AS tasks`;
    // Core-table existence does not imply all later runtime migrations finished.
    // The two runtime setup files are idempotent, and this database is test-only.
    const migrations = [
      ...(!existing!.tasks ? ["migrations/0001_agent_market_core.sql"] : []),
      "queen-runtime-scopes.sql", "queen-planning-requests.sql",
    ];
    for (const path of migrations) {
      const migration = (await readFile(new URL(`../../../../database/${path}`, import.meta.url), "utf8"))
        .replace(/^\s*BEGIN;\s*$/gmu, "").replace(/^\s*COMMIT;\s*$/gmu, "");
      await sql.begin(async transaction => { await transaction.unsafe(migration); });
    }
    await saver.setup();
    await sql`CREATE TABLE IF NOT EXISTS public.temporal_test_schedules (
      task_id uuid PRIMARY KEY, identity jsonb NOT NULL, deadline_at bigint NOT NULL,
      terminal boolean NOT NULL DEFAULT false, approval_ref uuid,
      deadline_event jsonb, fault_after_effect boolean NOT NULL DEFAULT false,
      inspections integer NOT NULL DEFAULT 0
    )`;
    await sql`CREATE TABLE IF NOT EXISTS public.temporal_test_effects (
      operation_key text PRIMARY KEY, task_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`;
    const inspect: ScheduleAuthority["inspect"] = async identity => {
      const [row] = await sql`UPDATE public.temporal_test_schedules SET inspections = inspections + 1
        WHERE task_id = ${identity.taskId} AND identity = ${sql.json({ ...identity })} RETURNING *`;
      if (!row) throw new Error("TEST_SCHEDULE_BINDING_REJECTED");
      return { deadlineAt: Number(row.deadline_at), terminal: Boolean(row.terminal),
        approvalRef: row.approval_ref as string | null };
    };
    const authorizeDeadline: ScheduleAuthority["authorizeDeadline"] = async event => {
      const [row] = await sql`SELECT 1 FROM public.temporal_test_schedules
        WHERE task_id = ${event.taskId} AND terminal = false
        AND deadline_at <= extract(epoch FROM clock_timestamp()) * 1000
        AND deadline_event = ${sql.json(event)}`;
      if (!row) throw new Error("TEST_DEADLINE_GRANT_REJECTED");
    };
    const authority: ScheduleAuthority = {
      inspect, authorizeDeadline,
      resolveDeadline: async identity => {
        const [row] = await sql`SELECT deadline_event FROM public.temporal_test_schedules WHERE task_id = ${identity.taskId}`;
        return QueenWorkflowEventSchema.parse(row?.deadline_event);
      },
      executeDeadline: async event => {
        await authorizeDeadline(event);
        await sql`INSERT INTO public.temporal_test_effects (operation_key, task_id)
          VALUES (${event.operationKey}, ${event.taskId})`;
        const [row] = await sql`SELECT fault_after_effect FROM public.temporal_test_schedules WHERE task_id = ${event.taskId}`;
        if (row!.fault_after_effect) throw new Error("TEST_CONNECTION_LOST_AFTER_COMMITTED_EFFECT");
        await sql`UPDATE public.temporal_test_schedules SET terminal = true WHERE task_id = ${event.taskId}`;
      },
    };
    const denied = async (): Promise<never> => { throw new Error("TEST_EXECUTION_NOT_AUTHORIZED"); };
    // Rejection is a real graph path that must never reach a provider port.
    const ports = { authorize: denied, plan: denied, execute: denied, judge: denied,
      redTeam: denied, repair: denied, finalize: denied };
    const options = { sql, checkpointer: saver, ledger, ports, authority };
    scheduler = await createTemporalScheduler(env);
    worker = await createTemporalWorker(env, options);
    running = worker!.run();
    const until = async (predicate: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await predicate()) return;
        await delay(100);
      }
      throw new Error("TEMPORAL_TEST_WAIT_EXHAUSTED");
    };
    const createSchedule = async (milliseconds: number, fault = false) => {
      const identity: ScheduleIdentity = { scopeId: randomUUID(), taskId: randomUUID(),
        graphRevision: 1, taskFingerprint: `sha256:${"a".repeat(64)}` };
      const event: QueenWorkflowEvent = {
        ...identity, schemaVersion: "queen-workflow-event.v1", eventId: randomUUID(),
        eventType: "task.resume-requested", payloadRef: randomUUID(),
        payloadHash: `sha256:${"b".repeat(64)}`, operationKey: "",
        occurredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
      };
      event.operationKey = queenEventOperationKey(event);
      await sql`INSERT INTO public.temporal_test_schedules (task_id, identity, deadline_at, deadline_event, fault_after_effect)
        VALUES (${identity.taskId}, ${sql.json({ ...identity })}, ${Date.now() + milliseconds}, ${sql.json(event)}, ${fault})`;
      return { identity, event };
    };

    // A real server timer persists while the original SDK Worker is shut down.
    const waiting = await createSchedule(60000);
    const handle = await scheduler!.start(waiting.identity);
    await expect(scheduler!.start(waiting.identity)).rejects.toThrow();
    await until(async () => (await handle.fetchHistory()).events?.some(event => Boolean(event.timerStartedEventAttributes)) ?? false);
    worker!.shutdown();
    await running;
    running = undefined;
    // The real authoritative deadline changes while there is no Worker.
    await sql`UPDATE public.temporal_test_schedules SET deadline_at = ${Date.now() - 1} WHERE task_id = ${waiting.identity.taskId}`;
    await scheduler!.notifyChanged(waiting.identity);
    worker = await createTemporalWorker(env, options);
    running = worker!.run();
    expect(await handle.result()).toBe("business-terminal");
    const [effectCount] = await sql`SELECT count(*)::integer AS n FROM public.temporal_test_effects WHERE task_id = ${waiting.identity.taskId}`;
    expect(effectCount!.n).toBe(1);

    // A real committed SQL effect followed by failure must not be run again.
    const uncertain = await createSchedule(-1, true);
    expect(await (await scheduler!.start(uncertain.identity)).result()).toBe("reconciliation-required");
    const activities = createTemporalActivities(options);
    expect(await activities.dispatchDeadline(uncertain.identity)).toBe("uncertain");
    const [uncertainRow] = await sql`SELECT status FROM queen_runtime_public.queen_operations WHERE operation_key = ${uncertain.event.operationKey}`;
    expect(uncertainRow!.status).toBe("uncertain");
    const [uncertainEffects] = await sql`SELECT count(*)::integer AS n FROM public.temporal_test_effects WHERE task_id = ${uncertain.identity.taskId}`;
    expect(uncertainEffects!.n).toBe(1);
    await expect(activities.dispatchDeadline({ ...uncertain.identity, scopeId: randomUUID() })).rejects.toThrow();

    // Real planning, business approval recording and PostgresSaver interrupt resume.
    const owner = `0x${"a".repeat(40)}`;
    const taskId = randomUUID();
    await sql`INSERT INTO agent_market.tasks (id, publisher_wallet, title, description, budget_atomic, request_id)
      VALUES (${taskId}, ${owner}, 'Temporal rejection test', 'High risk local test', 100, ${randomUUID()})`;
    const request = await requestQueenPlanning(sql, { taskId, actorWallet: owner, expectedTaskVersion: 1 });
    const [planRow] = await sql`SELECT event FROM queen_runtime_public.queen_outbox
      WHERE event ->> 'taskId' = ${taskId} AND event ->> 'eventType' = 'task.requested'`;
    const planEvent = QueenWorkflowEventSchema.parse(planRow!.event);
    await createQueenDurablePlanning({ sql, authorizationSql: sql, checkpointer: saver,
      queenAgentId: "queen-test", agents: [candidate("queen-test", ["plan"]), candidate("executor", ["completion"]),
        candidate("judge", ["judge"]), candidate("red-team", ["red_team"]), candidate("final-arbiter", ["final_arbitration"])] })(planEvent);
    await recordQueenPlanningApproval(sql, { requestId: request.requestId, taskId, actorWallet: owner,
      expectedTaskVersion: 1, graphRevision: 1, taskFingerprint: planEvent.taskFingerprint, approved: false });
    const [approvalRow] = await sql`SELECT approval_event FROM agent_market.queen_planning_requests WHERE id = ${request.requestId}`;
    const approvalEvent = QueenWorkflowEventSchema.parse(approvalRow!.approval_event);
    const identity: ScheduleIdentity = { scopeId: approvalEvent.scopeId, taskId,
      graphRevision: approvalEvent.graphRevision, taskFingerprint: approvalEvent.taskFingerprint };
    await sql`INSERT INTO public.temporal_test_schedules (task_id, identity, deadline_at, approval_ref)
      VALUES (${taskId}, ${sql.json({ ...identity })}, ${Date.now() + 600000}, ${approvalEvent.payloadRef})`;
    const approvalHandle = await scheduler!.start(identity);
    const graph = createQueenTaskGraph(ports, saver);
    await until(async () => {
      const state = await graph.getState({ configurable: { thread_id: queenTaskThreadId(identity) } });
      return state.values.status === "rejected" && state.next.length === 0;
    });
    await sql`UPDATE public.temporal_test_schedules SET terminal = true WHERE task_id = ${taskId}`;
    await scheduler!.notifyChanged(identity);
    expect(await approvalHandle.result()).toBe("business-terminal");
    const checkpoint = await graph.getState({ configurable: { thread_id: queenTaskThreadId(identity) } });
    expect(checkpoint.values.status).toBe("rejected");
    expect(checkpoint.next).toEqual([]);
    expect(await activities.resumeApproval(identity, approvalEvent.payloadRef)).toBe("duplicate-committed");
    await sql`UPDATE agent_market.queen_planning_requests SET approval_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${request.requestId}`;
    await expect(activities.resumeApproval(identity, approvalEvent.payloadRef)).rejects.toThrow();
    const [executions] = await sql`SELECT count(*)::integer AS n FROM public.temporal_test_effects WHERE task_id = ${taskId}`;
    expect(executions!.n).toBe(0);
  } finally {
    if (running) { worker!.shutdown(); await running; }
    await scheduler?.close();
    await ledger.close();
    await saver.end();
    await sql.end({ timeout: 5 });
  }
}, 120000);
