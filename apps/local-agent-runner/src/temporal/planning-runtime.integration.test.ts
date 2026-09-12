import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { AgentCandidate } from "@agent-market/shared-contracts";
import postgres from "postgres";
import { expect, it } from "vitest";
import { requestQueenPlanning } from "../../../transaction-engine/src/application/queen-planning-request";
import { QueenOperationLedger } from "../queen-operation-ledger";
import { QueenWorkflowEventSchema } from "../queen-workflow-event";
import { queenTaskThreadId } from "../queen-task-graph";
import { createLocalPlanningRuntime } from "./planning-runtime";

const databaseUrl = process.env.QUEEN_TEMPORAL_TEST_DATABASE_URL;
const candidate = (agentId: string, capabilities: string[]): AgentCandidate => ({
  agentId, displayName: agentId, capabilities, tags: [], provider: "qwen",
  ownership: "third-party/provider-api", selectableBy: "public-market", status: "online",
  costPer1kTokensUsd: 0.01, latencyMs: 100, qualityScore: 0.9,
  firstSeenAt: "2026-01-01T00:00:00.000Z", modelTag: agentId,
  modelDigest: "provider-managed", riskCodes: [],
});

// Real PostgreSQL, producer authorization, operation ledger and StateGraph.
// Static local agent catalog; no provider inference, AWS or production evidence.
it.skipIf(!databaseUrl)("consumes explicit planning references with real checkpoints and no unauthorized or uncertain replay", async () => {
  const url = new URL(databaseUrl!);
  if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/am_temporal_test") {
    throw new Error("DEDICATED_TEMPORAL_TEST_DATABASE_REQUIRED");
  }
  const sql = postgres(url.toString(), { max: 4 });
  const saver = PostgresSaver.fromConnString(url.toString(), { schema: `local_planning_${randomUUID().replaceAll("-", "")}` });
  const ledger = new QueenOperationLedger(url.toString(), "queen_runtime_public");
  const agents = [candidate("queen-test", ["plan"]), candidate("executor", ["completion"]),
    candidate("judge", ["judge"]), candidate("red-team", ["red_team"]), candidate("final-arbiter", ["final_arbitration"])];
  const options = { sql, authorizationSql: sql, checkpointer: saver, ledger, agents, queenAgentId: "queen-test" };
  const env = { QUEEN_LOCAL_PLANNING_ENABLED: "true", QUEEN_ASYNC_WORKER_READY: "false" };
  const owner = `0x${"a".repeat(40)}`;
  try {
    const [existing] = await sql`SELECT to_regclass('agent_market.queen_planning_requests') AS requests`;
    if (!existing!.requests) {
      for (const path of ["migrations/0001_agent_market_core.sql", "queen-runtime-scopes.sql", "queen-planning-requests.sql"]) {
        await sql.unsafe(await readFile(new URL(`../../../../database/${path}`, import.meta.url), "utf8"));
      }
    }
    await saver.setup();
    expect(createLocalPlanningRuntime({}, options)).toBeUndefined();
    expect(createLocalPlanningRuntime({ QUEEN_LOCAL_PLANNING_ENABLED: "1" }, options)).toBeUndefined();
    const runtime = createLocalPlanningRuntime(env, options)!;
    const prepare = async () => {
      const taskId = randomUUID();
      await sql`INSERT INTO agent_market.tasks (id, publisher_wallet, title, description, budget_atomic, request_id)
        VALUES (${taskId}, ${owner}, 'Local planning integration', 'High risk planning test only', 100, ${randomUUID()})`;
      const request = await requestQueenPlanning(sql, { taskId, actorWallet: owner, expectedTaskVersion: 1 });
      const [row] = await sql`SELECT event FROM agent_market.queen_planning_requests WHERE id = ${request.requestId}`;
      const event = QueenWorkflowEventSchema.parse(row!.event);
      return { event, ref: { requestId: request.requestId, taskId, scopeId: event.scopeId } };
    };
    const count = async (key: string) => {
      const [row] = await sql`SELECT count(*)::integer AS n FROM queen_runtime_public.queen_operations WHERE operation_key = ${key}`;
      return row!.n;
    };
    const first = await prepare();
    await expect(runtime.consumeBatch(Array.from({ length: 21 }, () => first.ref))).rejects.toThrow();
    await expect(runtime.consumeBatch([])).rejects.toThrow();
    expect(await count(first.event.operationKey)).toBe(0);
    expect((await runtime.consume({ ...first.ref, scopeId: randomUUID() })).outcome).toBe("rejected");
    expect((await runtime.consume({ ...first.ref, taskId: randomUUID() })).outcome).toBe("rejected");
    expect(await count(first.event.operationKey)).toBe(0);
    expect((await runtime.consume(first.ref)).outcome).toBe("committed");
    const config = { configurable: { thread_id: queenTaskThreadId(first.event) } };
    const saved = await saver.getTuple(config);
    expect(saved?.checkpoint.channel_values.status).toBe("awaiting_approval");
    expect(saved?.checkpoint.channel_values.planRef).toMatch(/^queen-plan:/u);
    const [before] = await sql`SELECT record_version, snapshot FROM queen_runtime_public.queen_workflows WHERE task_id = ${first.ref.taskId}`;
    expect(before!.snapshot.runId).toBeNull();
    expect(before!.snapshot.graphConfirmedRevision).toBeNull();
    expect((await createLocalPlanningRuntime(env, options)!.consume(first.ref)).outcome).toBe("duplicate-committed");
    const [after] = await sql`SELECT record_version FROM queen_runtime_public.queen_workflows WHERE task_id = ${first.ref.taskId}`;
    expect(after!.record_version).toBe(before!.record_version);
    expect((await saver.getTuple(config))?.checkpoint.id).toBe(saved?.checkpoint.id);

    for (const kind of ["revoked", "expired", "changed", "event-expired"] as const) {
      const rejected = await prepare();
      if (kind === "revoked") await sql`UPDATE agent_market.queen_planning_requests SET status = 'revoked' WHERE id = ${rejected.ref.requestId}`;
      if (kind === "expired") await sql`UPDATE agent_market.queen_planning_requests SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${rejected.ref.requestId}`;
      if (kind === "changed") await sql`UPDATE agent_market.tasks SET version = version + 1 WHERE id = ${rejected.ref.taskId}`;
      if (kind === "event-expired") {
        const event = { ...rejected.event, occurredAt: new Date(Date.now() - 120000).toISOString(), expiresAt: new Date(Date.now() - 60000).toISOString() };
        await sql`UPDATE agent_market.queen_planning_requests SET event = ${sql.json(event)} WHERE id = ${rejected.ref.requestId}`;
      }
      expect((await runtime.consume(rejected.ref)).outcome).toBe("rejected");
      expect(await count(rejected.event.operationKey)).toBe(0);
    }
    // Failed real planning (no independent executor) leaves an uncertain claim.
    const failed = await prepare();
    const insufficient = createLocalPlanningRuntime(env, { ...options, agents: [agents[0]!] })!;
    expect((await insufficient.consume(failed.ref)).outcome).toBe("uncertain");
    expect((await runtime.consume(failed.ref)).outcome).toBe("uncertain");
    const [unknown] = await sql`SELECT status FROM queen_runtime_public.queen_operations WHERE operation_key = ${failed.event.operationKey}`;
    expect(unknown!.status).toBe("uncertain");

    const concurrent = await prepare();
    const outcomes = await Promise.all([runtime.consume(concurrent.ref), runtime.consume(concurrent.ref)]);
    expect(outcomes.filter(result => result.outcome === "committed")).toHaveLength(1);
    expect(outcomes.every(result => ["committed", "busy", "duplicate-committed"].includes(result.outcome))).toBe(true);
    expect(await count(concurrent.event.operationKey)).toBe(1);
    const batch = await runtime.consumeBatch([first.ref, failed.ref]);
    expect(batch.map(result => result.outcome)).toEqual(["duplicate-committed", "uncertain"]);
    expect(env.QUEEN_ASYNC_WORKER_READY).toBe("false");
  } finally {
    await ledger.close();
    await saver.end();
    await sql.end({ timeout: 5 });
  }
}, 60000);
