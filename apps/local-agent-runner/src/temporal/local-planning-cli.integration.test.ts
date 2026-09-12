import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import postgres from "postgres";
import { expect, it } from "vitest";
import { requestQueenPlanning } from "../../../transaction-engine/src/application/queen-planning-request";
import { QueenWorkflowEventSchema } from "../queen-workflow-event";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("./local-planning-cli.ts", import.meta.url));
const databaseUrl = process.env.QUEEN_TEMPORAL_TEST_DATABASE_URL;
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
async function child(args: string[], env: Record<string, string | undefined>) {
  try {
    const result = await execute(process.execPath, ["--import", "tsx", cli, ...args], {
      env: { ...baseEnv, ...env }, timeout: 20000, maxBuffer: 65536,
    });
    return { ...result, code: 0 };
  } catch (error) {
    const result = error as { code: unknown; stdout: string; stderr: string; killed?: boolean };
    if (typeof result.code !== "number" || result.killed) throw error;
    return { code: result.code, stdout: result.stdout, stderr: result.stderr };
  }
}

it("CLI exits with bounded sanitized errors before database access", async () => {
  const disabled = await child([], {});
  expect(disabled.code).toBe(2);
  expect(JSON.parse(disabled.stdout)).toEqual({ outcome: "error", code: "PLANNING_DISABLED" });
  const malformed = await child(["--request", '{"requestId":"private-prompt-sentinel"}'], { QUEEN_LOCAL_PLANNING_ENABLED: "true" });
  expect(malformed.code).toBe(2);
  expect(JSON.parse(malformed.stdout).code).toBe("PLANNING_ARGUMENTS_INVALID");
  expect(malformed.stdout).not.toContain("private-prompt-sentinel");
  const ref = { requestId: randomUUID(), taskId: randomUUID(), scopeId: randomUUID() };
  const missing = await child(["--request", JSON.stringify(ref)], { QUEEN_LOCAL_PLANNING_ENABLED: "true" });
  expect(missing.code).toBe(2);
  expect(JSON.parse(missing.stdout).code).toBe("PLANNING_CONFIG_MISSING");
  expect([disabled.stderr, malformed.stderr, missing.stderr]).toEqual(["", "", ""]);
}, 30000);

it.skipIf(!databaseUrl)("real CLI process consumes, exits, deduplicates and rejects expired grants without provisioning", async () => {
  const url = new URL(databaseUrl!);
  if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/am_temporal_test") {
    throw new Error("DEDICATED_TEMPORAL_TEST_DATABASE_REQUIRED");
  }
  const sql = postgres(url.toString(), { max: 2 });
  const schema = `cli_planning_${randomUUID().replaceAll("-", "")}`;
  const saver = PostgresSaver.fromConnString(url.toString(), { schema });
  // Only the controlled test fixture provisions checkpoint tables, never the CLI.
  await saver.setup();
  const env = {
    QUEEN_LOCAL_PLANNING_ENABLED: "true", QUEEN_PUBLIC_DATABASE_URL: url.toString(),
    QUEEN_CHECKPOINT_DATABASE_URL: url.toString(), QUEEN_CHECKPOINT_SCHEMA: schema,
    QWEN_API_KEY: "local-catalog-fixture-token-never-call-provider",
    QWEN_MODELS: "fixture-executor,fixture-judge,fixture-red-team,fixture-final",
    LOCAL_AGENT_MODEL_ALLOWLIST: "__no_test_ollama_models__",
    QUEEN_ASYNC_WORKER_READY: "false", QUEEN_ASYNC_PLANNING_ENABLED: "false",
  };
  const prepare = async () => {
    const taskId = randomUUID();
    const wallet = `0x${"a".repeat(40)}`;
    await sql`INSERT INTO agent_market.tasks (id, publisher_wallet, title, description, budget_atomic, request_id)
      VALUES (${taskId}, ${wallet}, 'CLI fixture', 'High risk fixture prompt not for output', 100, ${randomUUID()})`;
    const request = await requestQueenPlanning(sql, { taskId, actorWallet: wallet, expectedTaskVersion: 1 });
    const [row] = await sql`SELECT event FROM agent_market.queen_planning_requests WHERE id = ${request.requestId}`;
    const event = QueenWorkflowEventSchema.parse(row!.event);
    return { event, ref: { requestId: request.requestId, taskId, scopeId: event.scopeId } };
  };
  const checkOutput = (result: Awaited<ReturnType<typeof child>>) => {
    expect(result.stderr).toBe("");
    for (const privateText of [env.QWEN_API_KEY, url.toString(), "High risk fixture prompt", "Error:", " at "]) {
      expect(result.stdout).not.toContain(privateText);
    }
    return JSON.parse(result.stdout);
  };
  try {
    const first = await prepare();
    const args = ["--request", JSON.stringify(first.ref)];
    const absentSchema = `absent_${randomUUID().replaceAll("-", "")}`;
    const missing = await child(args, { ...env, QUEEN_CHECKPOINT_SCHEMA: absentSchema });
    expect(missing.code).toBe(2);
    expect(checkOutput(missing).code).toBe("PLANNING_SCHEMA_NOT_READY");
    const [notCreated] = await sql`SELECT to_regnamespace(${absentSchema}) AS schema`;
    expect(notCreated!.schema).toBeNull();
    const initial = await child(args, env);
    expect(initial.code).toBe(0);
    expect(checkOutput(initial).results).toEqual([{ index: 0, outcome: "committed" }]);
    const [before] = await sql`SELECT record_version, snapshot FROM queen_runtime_public.queen_workflows WHERE task_id = ${first.ref.taskId}`;
    expect(before!.snapshot.runId).toBeNull();
    const duplicate = await child(["--batch", JSON.stringify([first.ref])], env);
    expect(duplicate.code).toBe(0);
    expect(checkOutput(duplicate).results).toEqual([{ index: 0, outcome: "duplicate-committed" }]);
    const [after] = await sql`SELECT record_version FROM queen_runtime_public.queen_workflows WHERE task_id = ${first.ref.taskId}`;
    expect(after!.record_version).toBe(before!.record_version);
    const expired = await prepare();
    await sql`UPDATE agent_market.queen_planning_requests SET expires_at = clock_timestamp() - interval '1 second'
      WHERE id = ${expired.ref.requestId}`;
    const rejected = await child(["--request", JSON.stringify(expired.ref)], env);
    expect(rejected.code).toBe(3);
    expect(checkOutput(rejected).results).toEqual([{ index: 0, outcome: "rejected" }]);
    const [count] = await sql`SELECT count(*)::integer AS n FROM queen_runtime_public.queen_operations
      WHERE operation_key = ${expired.event.operationKey}`;
    expect(count!.n).toBe(0);
    expect(env.QUEEN_ASYNC_WORKER_READY).toBe("false");
    expect(env.QUEEN_ASYNC_PLANNING_ENABLED).toBe("false");
  } finally {
    await saver.end();
    await sql.end({ timeout: 5 });
  }
}, 90000);
