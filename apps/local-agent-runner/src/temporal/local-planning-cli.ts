import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { AgentCandidateSchema, type AgentManifest } from "@agent-market/shared-contracts";
import postgres from "postgres";
import { z } from "zod";
import { parseRunnerConfig, type RunnerEnv } from "../config";
import { discoverOllamaManifests } from "../model-registry";
import { OllamaClient } from "../ollama-client";
import { providerManifests } from "../provider-adapters";
import { QueenOperationLedger } from "../queen-operation-ledger";
import { createLocalPlanningRuntime } from "./planning-runtime";

const Reference = z.object({ requestId: z.string().uuid(), taskId: z.string().uuid(), scopeId: z.string().uuid() }).strict();
const References = z.array(Reference).min(1).max(20);
const fail = (code: string): never => { throw new Error(code); };
const codes = new Set(["PLANNING_DISABLED", "PLANNING_ARGUMENTS_INVALID", "PLANNING_CONFIG_MISSING",
  "PLANNING_CONFIG_INVALID", "PLANNING_SCHEMA_NOT_READY", "PLANNING_CATALOG_UNAVAILABLE"]);

function localDatabase(value: string | undefined): string {
  if (!value) return fail("PLANNING_CONFIG_MISSING");
  let url: URL;
  try { url = new URL(value); } catch { return fail("PLANNING_CONFIG_INVALID"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
      || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.pathname.length < 2 || url.search || url.hash) return fail("PLANNING_CONFIG_INVALID");
  return value;
}

async function catalog(env: RunnerEnv) {
  const config = parseRunnerConfig(env);
  let manifests: AgentManifest[] = providerManifests(config, env);
  try {
    manifests = [...await discoverOllamaManifests(new OllamaClient(config), config,
      AbortSignal.timeout(Math.min(config.timeoutMs, 2000))), ...manifests];
  } catch { /* Offline local discovery cannot upgrade any candidate's health. */ }
  const now = new Date().toISOString();
  // Same candidate policy as stream-runtime's private agentCandidatesFromManifests.
  // Manifest loaders/config are shared; no CLI-supplied identities or health claims.
  const agents = AgentCandidateSchema.array().parse([
    { agentId: "queen-router-v1", displayName: "Queen Router", capabilities: ["plan", "completion"],
      tags: ["planner", "local-private"], provider: "codex", ownership: "local-private",
      selectableBy: "assigned-task", status: "online", costPer1kTokensUsd: 0, latencyMs: 0,
      qualityScore: 0.99, firstSeenAt: now, modelTag: "codex-local-queen", modelDigest: "local-private",
      riskCodes: ["local-private-preview"] },
    ...manifests.map(manifest => ({
      agentId: manifest.id, displayName: manifest.displayName,
      capabilities: [...new Set([...manifest.capabilities, "judge", "red_team", "final_arbitration"])],
      tags: [manifest.provider, manifest.ownership, manifest.access.selectableBy, manifest.model.license, ...manifest.capabilities],
      license: manifest.model.license, provider: manifest.provider, ownership: manifest.ownership,
      selectableBy: manifest.access.selectableBy, status: manifest.health.status,
      costPer1kTokensUsd: manifest.provider === "ollama" ? 0 : 0.004,
      latencyMs: manifest.provider === "ollama" ? 1200 : 900,
      qualityScore: manifest.health.status === "offline" ? 0 : 0.8,
      firstSeenAt: manifest.health.lastVerifiedAt ?? now, modelTag: manifest.model.tag,
      modelDigest: manifest.model.digest, riskCodes: manifest.health.status === "offline" ? ["offline"] : [],
    })),
  ]);
  const available = agents.filter(agent => agent.status !== "offline" && agent.selectableBy === "public-market");
  if (new Set(available.map(agent => agent.modelTag.trim().toLowerCase())).size < 4) {
    return fail("PLANNING_CATALOG_UNAVAILABLE");
  }
  return agents;
}

export async function runLocalPlanningCli(args: string[], env: RunnerEnv,
  output: (line: string) => void = line => process.stdout.write(line + "\n")): Promise<number> {
  let sql: ReturnType<typeof postgres> | undefined;
  let saver: PostgresSaver | undefined;
  let ledger: QueenOperationLedger | undefined;
  let exitCode = 2;
  let report: object = { outcome: "error", code: "PLANNING_RUNTIME_FAILED" };
  try {
    if (env.QUEEN_LOCAL_PLANNING_ENABLED !== "true") fail("PLANNING_DISABLED");
    let references: z.infer<typeof References>;
    try {
      if (args.length !== 2 || !["--request", "--batch"].includes(args[0]!) || args[1]!.length > 16384) throw new Error();
      const value: unknown = JSON.parse(args[1]!);
      references = References.parse(args[0] === "--request" ? [value] : value);
    } catch { return fail("PLANNING_ARGUMENTS_INVALID"); }
    const databaseUrl = localDatabase(env.QUEEN_PUBLIC_DATABASE_URL);
    const checkpointUrl = localDatabase(env.QUEEN_CHECKPOINT_DATABASE_URL);
    const schema = env.QUEEN_CHECKPOINT_SCHEMA;
    if (!schema) fail("PLANNING_CONFIG_MISSING");
    if (!/^[a-z][a-z0-9_]{0,62}$/u.test(schema!)) fail("PLANNING_CONFIG_INVALID");
    const agents = await catalog(env);
    sql = postgres(databaseUrl, { max: 2, prepare: false, connect_timeout: 5, onnotice: () => undefined });
    const checkpointSql = postgres(checkpointUrl, { max: 1, connect_timeout: 5, onnotice: () => undefined });
    try {
      const tables = ["agent_market.tasks", "agent_market.queen_planning_requests",
        "queen_runtime_public.queen_workflows", "queen_runtime_public.queen_operations"];
      for (const table of tables) {
        const [row] = await sql`SELECT to_regclass(${table}) AS relation`;
        if (!row?.relation) fail("PLANNING_SCHEMA_NOT_READY");
      }
      for (const table of ["checkpoints", "checkpoint_blobs", "checkpoint_writes", "checkpoint_migrations"]) {
        const [row] = await checkpointSql`SELECT to_regclass(${`${schema}.${table}`}) AS relation`;
        if (!row?.relation) fail("PLANNING_SCHEMA_NOT_READY");
      }
    } finally { await checkpointSql.end({ timeout: 5 }); }
    // Provisioning is deliberately outside this one-shot executable.
    saver = PostgresSaver.fromConnString(checkpointUrl, { schema: schema! });
    ledger = new QueenOperationLedger(databaseUrl, "queen_runtime_public");
    const runtime = createLocalPlanningRuntime(env, { sql, authorizationSql: sql,
      checkpointer: saver, ledger, agents, queenAgentId: "queen-router-v1" })!;
    const results = await runtime.consumeBatch(references);
    report = { outcome: "batch-finished", results: results.map((result, index) => ({ index, outcome: result.outcome })) };
    exitCode = results.every(result => ["committed", "duplicate-committed"].includes(result.outcome)) ? 0 : 3;
  } catch (error) {
    const code = error instanceof Error && codes.has(error.message) ? error.message : "PLANNING_RUNTIME_FAILED";
    report = { outcome: "error", code };
  } finally {
    const closed = await Promise.allSettled([ledger?.close(), saver?.end(), sql?.end({ timeout: 5 })]);
    if (closed.some(result => result.status === "rejected")) {
      exitCode = 2;
      report = { outcome: "error", code: "PLANNING_CLOSE_FAILED" };
    }
  }
  output(JSON.stringify(report));
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runLocalPlanningCli(process.argv.slice(2), process.env);
}
