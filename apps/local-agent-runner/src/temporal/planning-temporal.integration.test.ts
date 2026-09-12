import { randomUUID } from "node:crypto";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { AgentCandidate } from "@agent-market/shared-contracts";
import { Client, Connection } from "@temporalio/client";
import postgres from "postgres";
import { expect, it } from "vitest";
import { requestQueenPlanning } from "../../../transaction-engine/src/application/queen-planning-request";
import { readQueenPlanningStatus } from "../../../transaction-engine/src/application/queen-planning-status";
import { QueenWorkflowEventSchema } from "../queen-workflow-event";
import { QueenOperationLedger } from "../queen-operation-ledger";
import { queenTaskThreadId } from "../queen-task-graph";
import { createLocalPlanningRuntime } from "./planning-runtime";
import { createTemporalWorker } from "./worker";
import { createTemporalScheduler } from "./client";

const databaseUrl = process.env.QUEEN_TEMPORAL_TEST_DATABASE_URL;
const address = process.env.QUEEN_TEMPORAL_TEST_ADDRESS;
const candidate = (agentId: string, capabilities: string[]): AgentCandidate => ({
  agentId, displayName: agentId, capabilities, tags: [], provider: "qwen",
  ownership: "third-party/provider-api", selectableBy: "public-market", status: "degraded",
  costPer1kTokensUsd: 0.01, latencyMs: 100, qualityScore: 0.9,
  firstSeenAt: new Date().toISOString(), modelTag: agentId, modelDigest: "provider-managed", riskCodes: [],
});

// Real SDK Worker and loopback Temporal server; real PG ledger/authorization/checkpoint.
// Static catalog is a controlled fixture, not evidence of provider execution.
it.skipIf(!databaseUrl || !address)("real registered planning workflow persists checkpoints and refuses replay", async () => {
  const url = new URL(databaseUrl!);
  if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/am_temporal_test"
      || address !== "127.0.0.1:7239") throw new Error("DEDICATED_TEMPORAL_SERVICES_REQUIRED");
  const sql = postgres(url.toString(), { max: 3 });
  const saver = PostgresSaver.fromConnString(url.toString(), { schema: `planning_wf_${randomUUID().replaceAll("-", "")}` });
  const ledger = new QueenOperationLedger(url.toString(), "queen_runtime_public");
  const agents = [candidate("queen-test", ["plan"]), candidate("executor", ["completion"]),
    candidate("judge", ["judge"]), candidate("red-team", ["red_team"]), candidate("final", ["final_arbitration"])];
  const env = { QUEEN_TEMPORAL_ENABLED: "true", QUEEN_LOCAL_PLANNING_ENABLED: "true",
    QUEEN_TEMPORAL_ADDRESS: address, QUEEN_TEMPORAL_TASK_QUEUE: `planning-test-${randomUUID()}`,
    QUEEN_ASYNC_WORKER_READY: "false", QUEEN_ASYNC_PLANNING_ENABLED: "false" };
  const denied = async (): Promise<never> => { throw new Error("PLANNING_MUST_NOT_EXECUTE_OR_APPROVE"); };
  const options = { sql, checkpointer: saver, ledger,
    ports: { authorize: denied, plan: denied, execute: denied, judge: denied, redTeam: denied, repair: denied, finalize: denied },
    authority: { inspect: denied, resolveDeadline: denied, authorizeDeadline: denied, executeDeadline: denied },
    planning: { agents, queenAgentId: "queen-test" } };
  let scheduler: Awaited<ReturnType<typeof createTemporalScheduler>>;
  let worker: Awaited<ReturnType<typeof createTemporalWorker>>;
  let running: Promise<void> | undefined;
  let direct: Connection | undefined;
  try {
    await saver.setup(); // Fixture only; production factories never provision.
    expect(await createTemporalWorker({}, options)).toBeUndefined();
    const { planning: _planning, ...withoutPlanning } = options;
    await expect(createTemporalWorker(env, withoutPlanning)).rejects.toThrow("TEMPORAL_PLANNING_CONFIG_REQUIRED");
    scheduler = await createTemporalScheduler(env);
    worker = await createTemporalWorker(env, options);
    running = worker!.run();
    const prepare = async () => {
      const taskId = randomUUID(), wallet = `0x${"a".repeat(40)}`;
      await sql`INSERT INTO agent_market.tasks (id, publisher_wallet, title, description, budget_atomic, request_id)
        VALUES (${taskId}, ${wallet}, 'Temporal planning fixture', 'High risk local-only planning fixture', 100, ${randomUUID()})`;
      const request = await requestQueenPlanning(sql, { taskId, actorWallet: wallet, expectedTaskVersion: 1 });
      const [row] = await sql`SELECT event FROM agent_market.queen_planning_requests WHERE id = ${request.requestId}`;
      const event = QueenWorkflowEventSchema.parse(row!.event);
      return { event, ref: { requestId: request.requestId, taskId, scopeId: event.scopeId } };
    };
    const first = await prepare();
    const handle = await scheduler!.startPlanning(first.ref);
    expect(await handle.result()).toEqual({ outcome: "committed" });
    await expect(scheduler!.startPlanning(first.ref)).rejects.toThrow();
    const tuple = await saver.getTuple({ configurable: { thread_id: queenTaskThreadId(first.event) } });
    expect(tuple?.checkpoint.channel_values.status).toBe("awaiting_approval");
    expect(tuple?.checkpoint.channel_values.planRef).toMatch(/^queen-plan:/u);
    const history = await handle.fetchHistory();
    const activities = history.events?.filter(event => event.activityTaskScheduledEventAttributes);
    expect(activities).toHaveLength(1);
    expect(activities![0]!.activityTaskScheduledEventAttributes?.activityType?.name).toBe("consumePlanning");
    expect(activities![0]!.activityTaskScheduledEventAttributes?.retryPolicy?.maximumAttempts).toBe(1);
    const [state] = await sql`SELECT record_version, snapshot FROM queen_runtime_public.queen_workflows WHERE task_id = ${first.ref.taskId}`;
    expect(state!.snapshot.runId).toBeNull();
    const owner = `0x${"a".repeat(40)}`;
    const status = await readQueenPlanningStatus(sql, { taskId: first.ref.taskId, actorWallet: owner });
    expect(status).toMatchObject({
      task: { taskId: first.ref.taskId, taskVersion: 1, status: "open" },
      request: { requestId: first.ref.requestId, taskVersion: 1, graphRevision: first.event.graphRevision,
        taskFingerprint: first.event.taskFingerprint, authorizationCurrent: true,
        planningOperationStatus: "committed", plan: { recordVersion: state!.record_version,
          graph: { taskId: first.ref.taskId, graphRevision: first.event.graphRevision } } },
      canApprove: true, executionVerified: false,
    });
    await expect(readQueenPlanningStatus(sql, { taskId: first.ref.taskId, actorWallet: `0x${"b".repeat(40)}` }))
      .rejects.toMatchObject({ code: "QUEEN_TASK_UNAVAILABLE", status: 404 });
    // Plant private fields only in this fixture's snapshot; the public projection
    // must retain the plan but never return raw provider configuration or outputs.
    await sql`UPDATE queen_runtime_public.queen_workflows SET snapshot = snapshot || ${sql.json({
      providerKeys: { qwen: "private-provider-key-sentinel" },
      rawInput: "private-input-sentinel", rawOutput: "private-output-sentinel",
    })}::jsonb WHERE task_id = ${first.ref.taskId}`;
    const projected = await readQueenPlanningStatus(sql, { taskId: first.ref.taskId, actorWallet: owner });
    expect(projected.canApprove).toBe(true);
    expect(Object.keys(projected).sort()).toEqual(["canApprove", "executionVerified", "request", "task"]);
    expect(Object.keys(projected.request!.plan!).sort()).toEqual(["graph", "recordVersion"]);
    for (const secret of ["private-provider-key-sentinel", "private-input-sentinel", "private-output-sentinel",
      "High risk local-only planning fixture", '"snapshot"', '"providerKeys"', '"rawInput"', '"rawOutput"']) {
      expect(JSON.stringify(projected)).not.toContain(secret);
    }
    // Alternate raw workflow ID cannot bypass durable business deduplication.
    direct = await Connection.connect({ address });
    const raw = new Client({ connection: direct });
    const startRaw = (input: unknown) => raw.workflow.start("queenPlanningRequest", {
      workflowId: `raw-planning-test-${randomUUID()}`, taskQueue: env.QUEEN_TEMPORAL_TASK_QUEUE,
      args: [input], workflowExecutionTimeout: "30 seconds", retry: { maximumAttempts: 1 },
    });
    expect(await (await startRaw(first.ref)).result()).toEqual({ outcome: "duplicate-committed" });
    const [unchanged] = await sql`SELECT record_version FROM queen_runtime_public.queen_workflows WHERE task_id = ${first.ref.taskId}`;
    expect(unchanged!.record_version).toBe(state!.record_version);
    const invalid = await startRaw({ ...first.ref, agentId: "untrusted" });
    expect(await invalid.result()).toEqual({ outcome: "rejected" });
    expect((await invalid.fetchHistory()).events?.some(event => event.activityTaskScheduledEventAttributes)).toBe(false);
    await expect(scheduler!.startPlanning({ ...first.ref, requestId: "invalid" })).rejects.toThrow();
    for (const kind of ["missing", "expired", "scope"] as const) {
      const fixture = await prepare();
      if (kind === "expired") await sql`UPDATE agent_market.queen_planning_requests SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${fixture.ref.requestId}`;
      const ref = { ...fixture.ref, ...(kind === "missing" ? { requestId: randomUUID() } : {}),
        ...(kind === "scope" ? { scopeId: randomUUID() } : {}) };
      expect(await (await scheduler!.startPlanning(ref)).result()).toEqual({ outcome: "rejected" });
      const [count] = await sql`SELECT count(*)::integer AS n FROM queen_runtime_public.queen_operations WHERE operation_key = ${fixture.event.operationKey}`;
      expect(count!.n).toBe(0);
    }
    const busy = await prepare();
    await sql`INSERT INTO queen_runtime_public.queen_operations
      (operation_key,payload_hash,task_id,scope_id,graph_revision,owner_token,status)
      VALUES (${busy.event.operationKey},${busy.event.payloadHash},${busy.ref.taskId},${busy.ref.scopeId},1,${randomUUID()},'executing')`;
    expect(await (await scheduler!.startPlanning(busy.ref)).result()).toEqual({ outcome: "busy" });
    const failed = await prepare();
    const local = createLocalPlanningRuntime(env, { sql, authorizationSql: sql, checkpointer: saver,
      ledger, agents: [agents[0]!], queenAgentId: "queen-test" })!;
    expect((await local.consume(failed.ref)).outcome).toBe("uncertain");
    expect(await (await scheduler!.startPlanning(failed.ref)).result()).toEqual({ outcome: "uncertain" });
    expect(await saver.getTuple({ configurable: { thread_id: queenTaskThreadId(busy.event) } })).toBeUndefined();
    const [claim] = await sql`SELECT status FROM queen_runtime_public.queen_operations WHERE operation_key = ${failed.event.operationKey}`;
    expect(claim!.status).toBe("uncertain");
    expect(await readQueenPlanningStatus(sql, { taskId: failed.ref.taskId, actorWallet: owner }))
      .toMatchObject({ request: { planningOperationStatus: "uncertain", plan: null }, canApprove: false, executionVerified: false });
    expect(await readQueenPlanningStatus(sql, { taskId: busy.ref.taskId, actorWallet: owner }))
      .toMatchObject({ request: { planningOperationStatus: "executing", plan: null }, canApprove: false, executionVerified: false });
    // Reuse the completed fixture: a visible committed plan alone is not approval authority.
    await sql`UPDATE agent_market.queen_planning_requests SET expires_at = clock_timestamp() - interval '1 second'
      WHERE id = ${first.ref.requestId}`;
    expect(await readQueenPlanningStatus(sql, { taskId: first.ref.taskId, actorWallet: owner }))
      .toMatchObject({ request: { planningOperationStatus: "committed", authorizationCurrent: false }, canApprove: false, executionVerified: false });
    await sql`UPDATE agent_market.queen_planning_requests SET expires_at = clock_timestamp() + interval '10 minutes', status = 'revoked'
      WHERE id = ${first.ref.requestId}`;
    expect(await readQueenPlanningStatus(sql, { taskId: first.ref.taskId, actorWallet: owner }))
      .toMatchObject({ request: { planningOperationStatus: "committed", authorizationCurrent: false }, canApprove: false, executionVerified: false });
    expect(env.QUEEN_ASYNC_WORKER_READY).toBe("false");
    expect(env.QUEEN_ASYNC_PLANNING_ENABLED).toBe("false");
  } finally {
    if (running) { worker!.shutdown(); await running; }
    await direct?.close(); await scheduler?.close();
    await ledger.close(); await saver.end(); await sql.end({ timeout: 5 });
  }
}, 120000);
