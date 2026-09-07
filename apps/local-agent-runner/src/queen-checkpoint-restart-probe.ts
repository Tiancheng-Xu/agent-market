import { spawn } from "node:child_process";
import { Command } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createQueenTaskGraph, QueenTaskStateSchema, queenTaskThreadId, type QueenTaskGraphPorts } from "./queen-task-graph";

// Local destructive-test entry point only. Never import from the runtime server.
const url = process.env.QUEEN_CHECKPOINT_TEST_DATABASE_URL;
if (!url) throw new Error("LOCAL_TEST_DATABASE_REQUIRED");
const parsed = new URL(url);
if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
  || !/^\/agent_market_checkpoint_test_[a-z0-9_]+$/u.test(parsed.pathname)) {
  throw new Error("EPHEMERAL_LOCAL_DATABASE_REQUIRED");
}
const input = QueenTaskStateSchema.parse({
  scopeId: "restart-probe-owner", taskId: "01900000-0000-7000-8000-000000000011",
  graphRevision: 1, taskFingerprint: `sha256:${"b".repeat(64)}`,
  riskLevel: "low",
});
const config = { configurable: { thread_id: queenTaskThreadId(input) } };
const mode = process.argv[2];

if (mode === "pause" || mode === "resume") {
  const saver = PostgresSaver.fromConnString(url, { schema: "queen_restart_probe" });
  if (mode === "pause") await saver.setup();
  const calls: string[] = [];
  const ports: QueenTaskGraphPorts = {
    authorize: async (_state, action) => { calls.push(`authorize:${action}`); },
    plan: async () => {
      if (mode === "resume") throw new Error("PLANNING_REPEATED_AFTER_RESTART");
      calls.push("plan"); return "plan-ref";
    },
    execute: async () => { calls.push("execute"); return "output-ref"; },
    judge: async () => { calls.push("judge"); return "approved"; },
    repair: async () => { throw new Error("UNEXPECTED_REPAIR"); },
    finalize: async () => { calls.push("finalize"); return "final-ref"; },
  };
  const graph = createQueenTaskGraph(ports, saver);
  if (mode === "pause") {
    await graph.invoke(input, config);
    const saved = await graph.getState(config);
    if (!saved.next.includes("approval") || calls.includes("execute")) throw new Error("APPROVAL_NOT_PERSISTED");
    process.stdout.write("CHECKPOINT_DURABLE\n");
    setInterval(() => undefined, 1000);
  } else {
    const saved = await graph.getState(config);
    if (!saved.next.includes("approval")) throw new Error("CHECKPOINT_NOT_RECOVERED");
    const result = await graph.invoke(new Command({ resume: {
      approved: true, graphRevision: input.graphRevision, taskFingerprint: input.taskFingerprint,
    } }), config);
    if (result.status !== "completed" || calls.filter(x => x === "execute").length !== 1
      || !calls.includes("authorize:approve")) throw new Error("RESUME_FAILED");
    process.stdout.write(JSON.stringify({ passed: true, storage: "local-postgresql", killedSignal: "SIGKILL",
      restoredApproval: true, repeatedPlanning: false, calls,
      boundary: "Synthetic authorization and model ports; not production, wallet, or side-effect crash-window verification" }) + "\n", () => process.exit(0));
  }
} else {
  const run = (phase: string) => spawn(process.execPath, [...process.execArgv, import.meta.filename, phase], {
    env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  const first = run("pause");
  await new Promise<void>((resolve, reject) => {
    let ready = false, output = "";
    const timer = setTimeout(() => { first.kill("SIGKILL"); reject(new Error("CHECKPOINT_SETUP_TIMEOUT")); }, 30000);
    first.stdout.on("data", chunk => {
      output += chunk.toString();
      if (!ready && output.includes("CHECKPOINT_DURABLE")) { ready = true; first.kill("SIGKILL"); }
    });
    first.stderr.on("data", () => undefined);
    first.once("error", () => { clearTimeout(timer); reject(new Error("PROBE_START_FAILED")); });
    first.once("exit", (_code, signal) => {
      clearTimeout(timer);
      if (ready && signal === "SIGKILL") resolve(); else reject(new Error("PROBE_PAUSE_FAILED"));
    });
  });
  const second = run("resume");
  const timer = setTimeout(() => second.kill("SIGKILL"), 30000);
  second.stdout.pipe(process.stdout);
  second.stderr.on("data", () => undefined);
  second.once("exit", code => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1; });
}
