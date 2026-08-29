import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimePort = process.env.LOCAL_AGENT_RUNTIME_PORT ?? "8789";
const transactionEnginePort = process.env.TRANSACTION_ENGINE_PORT ?? "3000";
const transactionEngineOrigin = localOrigin(
  process.env.TRANSACTION_ENGINE_ORIGIN ?? `http://127.0.0.1:${transactionEnginePort}`,
  "TRANSACTION_ENGINE_ORIGIN",
);
const sharedSecret = process.env.AGENT_RUNTIME_SHARED_SECRET ?? randomBytes(32).toString("hex");
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "agent-market-local-"));
const workerEnvironment = path.join(temporaryDirectory, "worker.env");
const children = new Set();
let cleaningUp = false;

await writeFile(
  workerEnvironment,
  `AGENT_RUNTIME_ORIGIN=http://127.0.0.1:${runtimePort}\nAGENT_RUNTIME_SHARED_SECRET=${sharedSecret}\nTRANSACTION_ENGINE_ORIGIN=${transactionEngineOrigin}\n`,
  { mode: 0o600 },
);

const runtime = start("pnpm", ["--dir", "apps/local-agent-runner", "runtime:dev"], root, {
  ...process.env,
  AGENT_RUNTIME_SHARED_SECRET: sharedSecret,
  LOCAL_AGENT_RUNTIME_PORT: runtimePort,
});

const transactionEngine = start(
  "pnpm",
  ["--dir", "apps/transaction-engine", "dev", "--", "--port", new URL(transactionEngineOrigin).port || transactionEnginePort],
  root,
  process.env,
);

const buildExit = await run("pnpm", ["--dir", "apps/web", "build"], root, process.env);
if (buildExit !== 0) {
  await cleanup(buildExit);
}

const worker = start(
  "wrangler",
  [
    "dev",
    "--local",
    "--port",
    "4173",
    "--compatibility-date",
    "2026-07-29",
    "--env-file",
    workerEnvironment,
  ],
  path.join(root, "apps/web"),
  process.env,
);

runtime.once("exit", (code) => void cleanup(code ?? 1));
transactionEngine.once("exit", (code) => void cleanup(code ?? 1));
worker.once("exit", (code) => void cleanup(code ?? 0));
process.once("SIGINT", () => void cleanup(0));
process.once("SIGTERM", () => void cleanup(0));

function start(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: "inherit" });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = start(command, args, cwd, env);
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function localOrigin(value, name) {
  const origin = new URL(value);
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
    throw new Error(`${name} must use an HTTP loopback origin`);
  }
  return origin.origin;
}

async function cleanup(exitCode) {
  if (cleaningUp) return;
  cleaningUp = true;
  for (const child of children) child.kill("SIGTERM");
  await rm(temporaryDirectory, { recursive: true, force: true });
  process.exit(exitCode);
}
