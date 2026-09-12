import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { Wallet } from "ethers";
import postgres from "postgres";
import { expect, it } from "vitest";
import type { AgentCandidate } from "@agent-market/shared-contracts";
import { createTemporalWorker } from "../../../local-agent-runner/src/temporal/worker";
import { createTemporalScheduler } from "../../../local-agent-runner/src/temporal/client";
import { QueenOperationLedger } from "../../../local-agent-runner/src/queen-operation-ledger";
import { QueenWorkflowEventSchema } from "../../../local-agent-runner/src/queen-workflow-event";
import { queenTaskThreadId } from "../../../local-agent-runner/src/queen-task-graph";
import { createPagesHandler } from "../../../web/src/pages-worker";
import { createQueenPlanningClient, QUEEN_PLANNING_OPERATIONS, queenPlanningStatusLabel,
  type QueenPlanningStatus } from "../../../web/src/lib/queenPlanningClient";
import { PostgresAuthStore } from "../auth/auth-store";
import { WalletAuthService } from "../auth/session";
import { resetAuthRuntimeForTests, setAuthServiceForTests } from "../auth/runtime";
import { POST as challenge } from "../app/api/auth/challenge/route";
import { POST as verify } from "../app/api/auth/verify/route";
import { POST as logout } from "../app/api/auth/logout/route";
import { POST as graphql } from "../app/api/queen/graphql/route";
import { getOrderRuntime, resetOrderRuntimeForTests } from "./order-runtime";

// Resolve the existing Runner dependency without adding it to TE or Web bundles.
const runnerRequire = createRequire(new URL("../../../local-agent-runner/package.json", import.meta.url));
const { PostgresSaver } = runnerRequire("@langchain/langgraph-checkpoint-postgres");
const reportPath = new URL("./queen-planning-http.integration.report.json", import.meta.url);

// This Node integration test imports the Web Edge handler outside Vite's type entry.
// Declare only its optional build-version field, without a permissive index signature.
declare global {
  interface ImportMetaEnv {
    readonly VITE_APP_VERSION?: string;
  }
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LOOPBACK_LISTENER_REQUIRED");
  return address.port;
}
async function close(server: Server | undefined) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function bridge(origin: () => string, dispatch: (request: Request) => Promise<Response>) {
  return async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of incoming) {
        bytes += chunk.length;
        if (bytes > 32_768) throw new Error("LOCAL_HTTP_BODY_LIMIT");
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const response = await dispatch(new Request(new URL(incoming.url ?? "/", origin()), {
        method: incoming.method ?? "GET", headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(503, { "content-type": "application/json" });
      outgoing.end('{"error":"LOCAL_HTTP_ADAPTER_UNAVAILABLE"}');
    }
  };
}
function candidate(agentId: string, capabilities: string[]): AgentCandidate {
  return { agentId, displayName: agentId, capabilities, tags: [], provider: "qwen",
    ownership: "third-party/provider-api", selectableBy: "public-market", status: "degraded",
    costPer1kTokensUsd: 0.01, latencyMs: 100, qualityScore: 0.9, firstSeenAt: new Date().toISOString(),
    modelTag: agentId, modelDigest: "provider-managed", riskCodes: [] };
}

it.skipIf(process.env.QUEEN_HTTP_INTEGRATION !== "1")("real local HTTPS client -> Edge -> TE -> PG -> existing Temporal planning Worker", async () => {
  const base = new URL(process.env.QUEEN_TEMPORAL_TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55439/am_temporal_test");
  const temporalAddress = process.env.QUEEN_TEMPORAL_TEST_ADDRESS ?? "127.0.0.1:7239";
  if (base.hostname !== "127.0.0.1" || base.port !== "55439" || base.pathname !== "/am_temporal_test"
      || temporalAddress !== "127.0.0.1:7239") throw new Error("DEDICATED_LOCAL_SERVICES_REQUIRED");
  const runId = randomUUID().replaceAll("-", "");
  const databaseName = `w2_http_${runId}`;
  const database = new URL(base); database.pathname = `/${databaseName}`;
  const admin = postgres(base.toString(), { max: 1, connect_timeout: 3, onnotice() {} });
  const sql = postgres(database.toString(), { max: 3, connect_timeout: 3, onnotice() {} });
  const originalEnv = Object.fromEntries(["DATABASE_URL", "AUTH_ORIGIN", "QUEEN_ASYNC_PLANNING_ENABLED", "QUEEN_ASYNC_WORKER_READY"]
    .map(key => [key, process.env[key]]));
  const checks: string[] = [];
  let stage = "create-isolated-database";
  let passed = false;
  let created = false;
  let te: Server | undefined, edge: Server | undefined;
  let saver: InstanceType<typeof PostgresSaver> | undefined;
  let ledger: QueenOperationLedger | undefined;
  let worker: Awaited<ReturnType<typeof createTemporalWorker>>;
  let scheduler: Awaited<ReturnType<typeof createTemporalScheduler>>;
  let running: Promise<void> | undefined;
  let runtimeSql: ReturnType<typeof postgres> | undefined;
  let forbiddenCalls = 0;
  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    // Exact checked-in migrations, only inside this run's new database.
    for (const file of ["migrations/0001_agent_market_core.sql", "migrations/0003_phase2_lifecycle.sql",
      "queen-runtime-scopes.sql", "queen-planning-requests.sql"]) {
      const migration = postgres(database.toString(), { max: 1, onnotice() {} });
      try { await migration.unsafe(await readFile(new URL(`../../../../database/${file}`, import.meta.url), "utf8")); }
      finally { await migration.end({ timeout: 3 }); }
    }
    checks.push("isolated-database-created-from-real-migrations");
    process.env.DATABASE_URL = database.toString();
    resetOrderRuntimeForTests();
    setAuthServiceForTests(new WalletAuthService(new PostgresAuthStore(sql)));
    runtimeSql = getOrderRuntime().sql;

    stage = "real-http-listeners";
    let teOrigin = "";
    const routeHandlers: Record<string, (request: Request) => Promise<Response>> = {
      "/api/auth/challenge": challenge, "/api/auth/verify": verify, "/api/auth/logout": logout, "/api/queen/graphql": graphql,
    };
    te = createServer(bridge(() => teOrigin, async request => {
      const handler = routeHandlers[new URL(request.url).pathname];
      return request.method === "POST" && handler ? handler(request) : new Response(null, { status: 404 });
    }));
    teOrigin = `http://127.0.0.1:${await listen(te)}`;
    // TLS key and certificate are ephemeral, held only in memory. No global TLS bypass.
    const { stdout: pem } = await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", "/dev/stdout", "-out", "/dev/stdout", "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1"], { maxBuffer: 32_768 });
    const cert = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/u)?.[0];
    const key = pem.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/u)?.[0];
    if (!cert || !key) throw new Error("EPHEMERAL_LOCAL_TLS_UNAVAILABLE");
    const pages = createPagesHandler(); // Real default fetch connects Edge to TE over loopback TCP.
    let publicOrigin = "";
    edge = createHttpsServer({ cert, key }, bridge(() => publicOrigin, request => pages.fetch(request, {
      ASSETS: { fetch: async () => new Response(null, { status: 404 }) }, TRANSACTION_ENGINE_ORIGIN: teOrigin,
    })));
    publicOrigin = `https://127.0.0.1:${await listen(edge)}`;
    process.env.AUTH_ORIGIN = publicOrigin;
    // Local test-process admission only. Does not modify any deployment flags.
    process.env.QUEEN_ASYNC_PLANNING_ENABLED = "true";
    process.env.QUEEN_ASYNC_WORKER_READY = "true";

    function browser() {
      let cookie = "";
      const transport: typeof fetch = async (input, init) => new Promise<Response>((resolve, reject) => {
        const url = new URL(String(input), publicOrigin);
        if (url.origin !== publicOrigin) { reject(new Error("LOOPBACK_HTTP_ONLY")); return; }
        const headers = new Headers(init?.headers);
        if (!headers.has("origin")) headers.set("origin", publicOrigin);
        if (cookie) headers.set("cookie", cookie);
        const request = httpsRequest(url, { ca: cert, method: init?.method ?? "GET",
          headers: Object.fromEntries(headers), ...(init?.signal ? { signal: init.signal } : {}) }, incoming => {
          const chunks: Buffer[] = [];
          incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
          incoming.on("error", reject);
          incoming.on("end", () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              if (Array.isArray(value)) value.forEach(item => responseHeaders.append(name, item));
              else if (value !== undefined) responseHeaders.set(name, value);
            }
            const newCookie = incoming.headers["set-cookie"]?.[0];
            if (newCookie) cookie = newCookie.split(";", 1)[0]!;
            const code = incoming.statusCode ?? 503;
            resolve(new Response(code === 204 ? null : Buffer.concat(chunks), { status: code, headers: responseHeaders }));
          });
        });
        request.on("error", reject);
        request.setTimeout(15_000, () => request.destroy(new Error("LOCAL_HTTP_TIMEOUT")));
        request.end(typeof init?.body === "string" ? init.body : undefined);
      });
      const post = (path: string, body: unknown) => transport(path, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      return { transport, post,
        // Only the local UI veto is injected; HTTP authenticates the real cookie on every request.
        client: () => createQueenPlanningClient({ fetch: transport, assertSession() {} }),
        async login(wallet: ReturnType<typeof Wallet.createRandom>) {
          const challengeResponse = await post("/api/auth/challenge", { address: wallet.address });
          expect(challengeResponse.status).toBe(201);
          const issued = await challengeResponse.json() as { message: string };
          const response = await post("/api/auth/verify", { message: issued.message, signature: await wallet.signMessage(issued.message) });
          expect(response.status).toBe(200);
          expect(response.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Lax");
          const verified = await response.json() as { session: { sessionId: string } };
          return verified.session.sessionId;
        },
      };
    }

    stage = "software-wallet-http-authentication";
    const ownerWallet = Wallet.createRandom(), otherWallet = Wallet.createRandom();
    const owner = browser(), other = browser(), anonymous = browser();
    const sessionId = await owner.login(ownerWallet);
    await other.login(otherWallet);
    const [authRows] = await sql`SELECT count(*)::integer AS n, bool_and(consumed_at IS NOT NULL) AS consumed
      FROM agent_market.wallet_challenges`;
    expect(authRows).toMatchObject({ n: 2, consumed: true });
    const [sessions] = await sql`SELECT count(*)::integer AS n, bool_and(octet_length(session_hash) = 32) AS hashes_only
      FROM agent_market.wallet_sessions`;
    expect(sessions).toMatchObject({ n: 2, hashes_only: true });
    checks.push("real-https-challenge-signature-verify-cookie-and-postgres-auth");

    stage = "existing-temporal-worker-start";
    saver = PostgresSaver.fromConnString(database.toString(), { schema: `w2_http_${runId}` });
    await saver.setup();
    ledger = new QueenOperationLedger(database.toString(), "queen_runtime_public");
    const denied = async (): Promise<never> => { forbiddenCalls++; throw new Error("HTTP_TEST_PLANNING_ONLY"); };
    const env = { QUEEN_TEMPORAL_ENABLED: "true", QUEEN_LOCAL_PLANNING_ENABLED: "true",
      QUEEN_TEMPORAL_ADDRESS: temporalAddress, QUEEN_TEMPORAL_TASK_QUEUE: `w2-http-${runId}` };
    worker = await createTemporalWorker(env, { sql, checkpointer: saver, ledger,
      ports: { authorize: denied, plan: denied, execute: denied, judge: denied, redTeam: denied, repair: denied, finalize: denied },
      authority: { inspect: denied, resolveDeadline: denied, authorizeDeadline: denied, executeDeadline: denied },
      planning: { queenAgentId: "queen-http-fixture", agents: [candidate("queen-http-fixture", ["plan"]),
        candidate("executor-http-fixture", ["completion"]), candidate("judge-http-fixture", ["judge"]),
        candidate("red-http-fixture", ["red_team"]), candidate("final-http-fixture", ["final_arbitration"])] },
    });
    running = worker!.run();
    scheduler = await createTemporalScheduler(env);

    const client = owner.client();
    async function seedTask() {
      const taskId = randomUUID();
      // Open task is a DB fixture, not a funded/on-chain task claim.
      await sql`INSERT INTO agent_market.tasks (id, publisher_wallet, title, description, requirements, budget_atomic, request_id)
        VALUES (${taskId}, ${ownerWallet.address.toLowerCase()}, 'W2 local HTTP fixture',
          'High risk controlled planning fixture, not a model result', ARRAY['Persisted requirement only'], 100, ${randomUUID()})`;
      const initial = await client.read(taskId);
      expect(initial).toMatchObject({ task: { taskId, taskVersion: 1, status: "open" }, request: null, canApprove: false, executionVerified: false });
      return initial;
    }
    async function plan(initial: QueenPlanningStatus) {
      const queued = await client.propose(initial.task);
      expect(queued).toMatchObject({ status: "queued", duplicate: false });
      expect(await client.propose(initial.task)).toEqual({ ...queued, duplicate: true });
      const before = await client.read(initial.task.taskId);
      expect(before).toMatchObject({ request: { planningOperationStatus: "unobserved", plan: null }, canApprove: false, executionVerified: false });
      expect(queenPlanningStatusLabel(before)).toContain("Execution not verified");
      const [row] = await sql`SELECT request.event, request.payload, request.allowed_action, outbox.status
        FROM agent_market.queen_planning_requests request JOIN queen_runtime_public.queen_outbox outbox
          ON outbox.event_id::text = request.event ->> 'eventId' WHERE request.id = ${queued.requestId}`;
      expect(row!.allowed_action).toBe("plan");
      expect(row!.status).toBe("pending");
      expect(JSON.stringify(row!.payload)).toContain("Persisted requirement only");
      const event = QueenWorkflowEventSchema.parse(row!.event);
      // Trusted test-host dispatch of a persisted outbox reference, not a browser worker operation.
      const handle = await scheduler!.startPlanning({ requestId: queued.requestId, taskId: initial.task.taskId, scopeId: event.scopeId });
      expect(await handle.result()).toEqual({ outcome: "committed" });
      const history = await handle.fetchHistory();
      const activities = history.events?.filter(entry => entry.activityTaskScheduledEventAttributes);
      expect(activities).toHaveLength(1);
      expect(activities![0]!.activityTaskScheduledEventAttributes?.activityType?.name).toBe("consumePlanning");
      const [operation] = await sql`SELECT status FROM queen_runtime_public.queen_operations WHERE operation_key = ${event.operationKey}`;
      expect(operation!.status).toBe("committed");
      const checkpoint = await saver.getTuple({ configurable: { thread_id: queenTaskThreadId(event) } });
      expect(checkpoint?.checkpoint.channel_values.status).toBe("awaiting_approval");
      expect(checkpoint?.checkpoint.channel_values.planRef).toMatch(/^queen-plan:/u);
      const committed = await client.read(initial.task.taskId);
      expect(committed).toMatchObject({ canApprove: true, executionVerified: false,
        request: { requestId: queued.requestId, graphRevision: event.graphRevision, taskFingerprint: event.taskFingerprint,
          planningOperationStatus: "committed", plan: { graph: { taskId: initial.task.taskId, graphRevision: event.graphRevision } } } });
      expect(queenPlanningStatusLabel(committed)).toContain("Planning: committed");
      expect(queenPlanningStatusLabel(committed)).toContain("Execution not verified");
      return { committed, event };
    }
    const rawConfirm = (status: QueenPlanningStatus, overrides: Record<string, unknown> = {}) => ({
      operationName: "ConfirmTaskGraph", query: QUEEN_PLANNING_OPERATIONS.ConfirmTaskGraph,
      variables: { input: { taskId: status.task.taskId, taskVersion: status.task.taskVersion,
        requestId: status.request!.requestId, graphRevision: status.request!.graphRevision,
        taskFingerprint: status.request!.taskFingerprint, approved: true, ...overrides } },
    });
    async function error(response: Response, expectedStatus: number, code: string) {
      expect(response.status).toBe(expectedStatus);
      expect(await response.json()).toEqual({ data: null, errors: [{ message: code, extensions: { code } }] });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }

    stage = "task-version-propose-worker-committed-http-readback";
    const initial = await seedTask();
    const { committed, event } = await plan(initial);
    checks.push("http-task-version-propose-queued-duplicate-real-worker-committed-ledger-checkpoint-readback");

    stage = "http-identity-and-exact-approval-binding";
    await expect(other.client().read(initial.task.taskId)).rejects.toThrow("QUEEN_TASK_UNAVAILABLE");
    await expect(anonymous.client().read(initial.task.taskId)).rejects.toThrow("AUTH_SESSION_INVALID");
    await error(await other.post("/api/queen/graphql", rawConfirm(committed)), 404, "QUEEN_TASK_UNAVAILABLE");
    await error(await owner.post("/api/queen/graphql", rawConfirm(committed, { graphRevision: 2 })), 409, "QUEEN_APPROVAL_VERSION_MISMATCH");
    await error(await owner.post("/api/queen/graphql", rawConfirm(committed, { taskFingerprint: `sha256:${"0".repeat(64)}` })), 409, "QUEEN_APPROVAL_VERSION_MISMATCH");
    await error(await owner.transport("/api/queen/graphql", { method: "POST",
      headers: { origin: "https://foreign.example", "content-type": "application/json" }, body: JSON.stringify(rawConfirm(committed)) }), 403, "AUTH_ORIGIN_MISMATCH");
    const approval = await client.confirm(committed, true);
    expect(approval).toMatchObject({ status: "queued", duplicate: false });
    expect(await client.confirm(committed, true)).toEqual({ ...approval, duplicate: true });
    const after = await client.read(initial.task.taskId);
    expect(after).toMatchObject({ canApprove: false, executionVerified: false,
      request: { planningOperationStatus: "committed", approval: { approvalId: approval.approvalId, approved: true,
        authorizationCurrent: true, operationStatus: "unobserved" } } });
    expect(queenPlanningStatusLabel(after)).toContain("recording is not execution");
    const [recorded] = await sql`SELECT approval_payload, approval_event FROM agent_market.queen_planning_requests WHERE id = ${committed.request!.requestId}`;
    expect(recorded!.approval_payload).toMatchObject({ graphRevision: event.graphRevision, taskFingerprint: event.taskFingerprint, approved: true });
    expect(recorded!.approval_payload.assignmentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(await sql`SELECT event_id FROM queen_runtime_public.queen_outbox WHERE event_id = ${recorded!.approval_event.eventId}`).toHaveLength(1);
    expect(await sql`SELECT operation_key FROM queen_runtime_public.queen_operations WHERE operation_key = ${recorded!.approval_event.operationKey}`).toHaveLength(0);
    const [snapshot] = await sql`SELECT snapshot FROM queen_runtime_public.queen_workflows WHERE task_id = ${initial.task.taskId}`;
    expect(snapshot!.snapshot.runId).toBeNull();
    expect(snapshot!.snapshot.graphConfirmedRevision).toBeNull();
    expect((await saver.getTuple({ configurable: { thread_id: queenTaskThreadId(event) } }))?.checkpoint.channel_values.status).toBe("awaiting_approval");
    checks.push("http-origin-other-wallet-missing-session-and-exact-revision-fingerprint-denials");
    checks.push("http-confirm-queued-duplicate-real-approval-outbox-no-execution-or-approval-ledger-claim");

    stage = "expired-revoked-authorizations-remain-readable-but-unapprovable";
    for (const reason of ["expired", "revoked"] as const) {
      const planned = await plan(await seedTask());
      const requestId = planned.committed.request!.requestId;
      if (reason === "expired") await sql`UPDATE agent_market.queen_planning_requests SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${requestId}`;
      else await sql`UPDATE agent_market.queen_planning_requests SET status = 'revoked' WHERE id = ${requestId}`;
      const historical = await client.read(planned.committed.task.taskId);
      expect(historical).toMatchObject({ canApprove: false, executionVerified: false, request: { authorizationCurrent: false, planningOperationStatus: "committed" } });
      expect(historical.request!.plan).not.toBeNull();
      expect(queenPlanningStatusLabel(historical)).toContain("expired / revoked / stale");
      await error(await owner.post("/api/queen/graphql", rawConfirm(planned.committed)), 409, "QUEEN_APPROVAL_TASK_CONFLICT");
      await expect(client.propose(historical.task)).rejects.toThrow("QUEEN_PLANNING_RECONCILIATION_REQUIRED");
      checks.push(`real-pg-${reason}-grant-denies-http-approval-and-reproposal-preserves-history`);
    }

    stage = "historical-query-producer-gates-and-session-revocation";
    process.env.QUEEN_ASYNC_WORKER_READY = "false";
    expect((await client.read(initial.task.taskId)).executionVerified).toBe(false);
    await expect(client.propose(initial.task)).rejects.toThrow("QUEEN_ASYNC_PLANNING_DISABLED");
    process.env.QUEEN_ASYNC_PLANNING_ENABLED = "false";
    expect((await client.read(initial.task.taskId)).request!.plan).not.toBeNull();
    expect((await owner.post("/api/auth/logout", {})).status).toBe(204);
    const [revoked] = await sql`SELECT revoked_at IS NOT NULL AS revoked FROM agent_market.wallet_sessions WHERE id = ${sessionId}`;
    expect(revoked!.revoked).toBe(true);
    await expect(owner.client().read(initial.task.taskId)).rejects.toThrow("AUTH_SESSION_INVALID");
    // Session expiry is a DB clock fixture, not a wallet clock or an auth-service stub.
    const expiringSession = await other.login(otherWallet);
    await sql`UPDATE agent_market.wallet_sessions SET issued_at = clock_timestamp() - interval '2 days',
      expires_at = clock_timestamp() - interval '1 day' WHERE id = ${expiringSession}`;
    await expect(other.client().read(initial.task.taskId)).rejects.toThrow("AUTH_SESSION_INVALID");
    expect(forbiddenCalls).toBe(0);
    checks.push("history-readable-with-producer-gates-closed-real-pg-session-logout-and-expiry-denied");
    checks.push("ui-client-queued-committed-executionVerified-false-boundaries-and-zero-execution-ports");
    passed = true;
    stage = "complete";
  } finally {
    // Only this test's listeners, worker client, pools and database are owned here.
    await close(edge); await close(te);
    if (running) { worker!.shutdown(); await running; }
    await scheduler?.close(); await ledger?.close(); await saver?.end();
    await runtimeSql?.end({ timeout: 5 });
    resetOrderRuntimeForTests(); resetAuthRuntimeForTests();
    await sql.end({ timeout: 5 });
    if (created) await admin.unsafe(`DROP DATABASE "${databaseName}"`);
    await admin.end({ timeout: 5 });
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await writeFile(reportPath, JSON.stringify({ schemaVersion: "w2-local-http.v1", recordedAt: new Date().toISOString(),
      status: passed ? "passed" : "blocked", stage, checks,
      transport: "real loopback HTTPS client to Edge, loopback HTTP Edge to actual TE route handlers",
      postgresPort: 55439, temporalPort: 7239, sharedServicesRestarted: false,
      isolatedDatabaseRemoved: created, realWalletAuthAndBusinessServices: true,
      planningRuntime: "existing createTemporalWorker/createTemporalScheduler; real PG authorization/ledger/PostgresSaver",
      fixtureBoundary: "software wallets in memory; open task SQL fixtures; static provider catalog; deterministic planning, no provider/model execution",
      dispatchBoundary: "test-owned trusted host dispatches persisted outbox reference; production outbox poller/supervisor not validated",
      httpBoundary: "actual handlers hosted by test Node adapters, not a deployed Next.js server or browser UI automation",
      executionVerified: false, productionVerified: false, secretsIncluded: false,
      forbiddenActions: "no chain, AWS, Git, Cloudflare deployment or shared-service restart",
    }, null, 2) + "\n");
  }
}, 120_000);
