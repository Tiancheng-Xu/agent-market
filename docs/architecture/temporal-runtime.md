# Temporal local order scheduling

Status: local SDK planning and approval-recovery integration verified against real
Temporal and PostgreSQL; production host/provider/compensation acceptance pending.
No AWS service, production deployment, chain execution or mock completion is claimed.

## Authority and scope

Temporal owns durable waits and deadline/compensation dispatch. Queen StateGraph
owns planning, approval, execution and review. PostgreSQL owns business state,
authorization, checkpoints and operation deduplication. A Temporal completion is
a scheduling result, not proof of order settlement or a chain receipt.

The workflow takes only scope/task/revision/fingerprint references. A no-payload
Signal wakes an authoritative read; it cannot approve, change a deadline, cancel
an order or authorize a refund. Signals are optional because hourly polling
recovers missed notifications. Terminal state and expired deadlines are checked
before approval dispatch. A schedule runs at most 1000 cycles and 45 days.

## Dependencies for the parent agent

Install these exact runtime dependencies in `@agent-market/local-agent-runner`:

```text
@temporalio/client@1.23.0
@temporalio/worker@1.23.0
@temporalio/workflow@1.23.0
```

This change deliberately does not edit package.json or the shared lockfile.
Package-level typechecking requires the parent to install these packages first.
The worker uses native SDK components; use a supported Node LTS and a compatible
local Temporal server. No testing SDK or mock server is included.

## Composition and environment

```text
QUEEN_TEMPORAL_ENABLED=false
QUEEN_TEMPORAL_ADDRESS=127.0.0.1:7233
QUEEN_TEMPORAL_NAMESPACE=default
QUEEN_TEMPORAL_TASK_QUEUE=queen-order-schedule-v1
```

Only literal `true` enables connections. This implementation accepts loopback
Temporal only, with no TLS/cloud credentials. Never expose the development server
to untrusted clients. Existing host SQL, PostgresSaver and QueenOperationLedger
are injected; no additional database URL is read or schema migration performed.
Use the public ledger matching the existing public approval authorization schema.
Owner/private-scope runtime composition is not supported by this approval adapter.

`createTemporalWorker(env, {sql, checkpointer, ledger, ports, authority})` is the
real SDK Worker factory. Call its `run()` in the host, await it, and call
`shutdown()` on process signals; SQL/saver/ledger remain host-owned. This source
entry expects the repository's tsx/TypeScript execution layout (`workflows.ts`).
For emitted JavaScript deployments, supply a compiled workflow bundle/path in a
future host integration before using it; this is not currently a packaged CLI.

`createTemporalScheduler(env)` opens the SDK client. An authenticated server
handler calls `start(identity)` after its order transaction commits, and calls
`notifyChanged(identity)` after relevant business state changes. A durable
outbox publisher should retry failed starts; an already-started error requires
identity verification, not a replacement workflow. Close the client on shutdown.
The deterministic workflow ID includes scope, task, revision and fingerprint;
completed IDs cannot be reused while Temporal retains their history. The durable
business ledger remains required after history retention expires.

## Actual approval recovery and required deadline host port

The approval Activity loads `approval_event` from
`agent_market.queen_planning_requests`, checks the full identity/hash/time, calls
`createQueenPlanningApprovalAuthorization`, claims `QueenOperationLedger`, then
calls `createQueenDurableApproval`. Current deadline, approval reference and
authorization are checked again after claiming. Existing StateGraph checks each
node's current authority and resumes the durable approval interrupt.

The existing durable approval entry only resumes `next=approval`. It cannot
automatically resume an executing/partially completed graph. A crashed operation
remains busy or uncertain; it requires reconciliation before any new execution.
The existing ledger uses a five-minute executing-to-uncertain threshold. Thus a
duplicate delivery during a longer activity may conservatively mark it uncertain;
this adapter never steals the claim or treats that outcome as successful.

The host must implement `ScheduleAuthority` with actual Transaction Engine data:

- `inspect`: verify scope/current graph binding and read the real order deadline,
  terminal status and current approval reference.
- `resolveDeadline`: resolve an already persisted, authorized deadline/compensation
  command as `task.resume-requested`, with a stable operation key and payload hash.
- `authorizeDeadline`: recheck current permissions, due time, order state, expected
  version and any separate compensation approval. Never reuse an execution grant.
- `executeDeadline`: dispatch the existing StateGraph/Transaction Engine command
  with atomic expected-version checks, durable node/provider deduplication and
  persistence before returning. No raw chain/provider execution in this adapter.

These business ports are required, with no permissive default. This scoped change
does not add a transaction-engine compensation endpoint or invent a refund rule.
Consequently deadline/compensation end-to-end completion remains blocked until
the parent supplies the actual authorized business composition.

## Retry, timeout and operational recovery

Read Activities have at most three attempts in two minutes. Side-effect Activities
have one attempt, a 30-minute execution timeout and a 31-minute total timeout.
Workflow retries are disabled with one maximum attempt. Ledger busy/uncertain and
write errors return `reconciliation-required`, without automatic compensation.
An Activity may still finish after its timeout; that return value is not proof
that it stopped. Operators must reconcile the database and provider state first.

Worker restart replays workflow history and durable timers. It does not override
the operation ledger. Workflow cancellation/termination stops scheduling, but is
not a business cancellation or permission to refund. An existing external effect
may continue. Do not reset workflows or clear ledger rows to bypass uncertainty.
At `schedule-limit-reached`, reconcile and establish a new authorized scheduling
generation through business policy; do not silently recycle the workflow ID.

Workflow history contains references and small outcomes only, no approval payload,
wallet secrets or database URLs. Protect Temporal storage and access accordingly.

## Local verification and remaining services

The configuration unit test is not evidence of Temporal execution. Real acceptance
needs the installed SDK, local Temporal gRPC at 127.0.0.1:7233, a disposable local
PostgreSQL database with existing Queen schemas and PostgresSaver tables, and real
business authority/graph ports. No AWS queue is needed. A persistent local dev
server can be started by the host with:

```bash
temporal server start-dev --ip 127.0.0.1 --db-filename /tmp/agent-market-temporal.sqlite
pnpm --filter @agent-market/local-agent-runner exec vitest run src/temporal/config.test.ts
pnpm --filter @agent-market/local-agent-runner typecheck
```

Required service tests: restart a worker during an outstanding timer; signal a
persisted approval and verify all real StateGraph gates/checkpoints; reject stale
approval/scope/revision/deadline; race duplicate starts and duplicate Activities;
crash after a provider result but before ledger commit and prove no second effect;
expire a real order and verify the separately authorized compensation command;
cancel during an Activity and reconcile any late result. Preserve workflow history,
database operation rows and real output references. Report these as pending until
executed against the actual services. Do not substitute mocks for this acceptance.

SDK references: [Workflow API](https://typescript.temporal.io/api/namespaces/workflow),
[Worker options](https://typescript.temporal.io/api/interfaces/worker.WorkerOptions),
[published worker versions](https://www.npmjs.com/package/%40temporalio/worker?activeTab=versions).

## Local handoff evidence (2026-09-09)

- Configuration tests: 1 file, 6 tests passed using the repository Vitest runner.
- Typecheck: blocked by exactly three TS2307 missing SDK modules (client, worker,
  workflow); SDK-dependent typing is not yet verified.
- Official macOS arm64 Temporal CLI v1.8.3 downloaded under
  `/tmp/am-temporal-tools-20260909/temporal`.
- A real persistent development server was started on `127.0.0.1:17233`, UI port
  `18233`, SQLite file `/tmp/am-temporal-tools-20260909/server.sqlite`.
  `temporal operator cluster health --address 127.0.0.1:17233` returned `SERVING`.
  Set `QUEEN_TEMPORAL_ADDRESS=127.0.0.1:17233` to use this instance.
- Independent database `am_temporal_test` created on the provided local PostgreSQL
  server at `127.0.0.1:55439`. Business/checkpoint migrations and fixtures have not
  been applied to that database by this change.
- No SDK Worker or business workflow has run yet. Server health does not satisfy
  approval recovery, restart durability or compensation acceptance.

## Superseding registered planning verification (2026-09-10 UTC)

The preceding handoff records the initial setup only. The registered
`queenPlanningRequest` Workflow now invokes `consumePlanning`, which delegates to
`createLocalPlanningRuntime`. Both workflow and Activity use maximumAttempts=1.
Strict UUID references are checked by the client, Workflow and Activity. The
Activity reloads authoritative planning records and delegates to existing
authorization, public operation ledger and durable StateGraph planning.

Enable `QUEEN_TEMPORAL_ENABLED=true` and `QUEEN_LOCAL_PLANNING_ENABLED=true` only
in a trusted host process. Pass the existing SQL/public ledger/PostgresSaver and
approval ports to `createTemporalWorker`, plus `planning: { agents, queenAgentId }`
from the host's trusted catalog. Enabling planning without that configuration
fails before connecting. Without the planning flag, existing approval Worker
composition remains compatible. Factories do not provision schemas or set frontend
readiness. The caller owns SQL/saver/ledger; Worker run owns its Temporal connection.

The SDK client `startPlanning({ requestId, taskId, scopeId })` starts exactly one
planning Workflow with a SHA-256 identity bound to all three references and
REJECT_DUPLICATE. Client and Worker must share namespace and queue configuration.
Activity execution is capped at four minutes and total scheduling at five minutes;
the Workflow execution limit is six minutes. Unknown results never trigger another
Activity or compensation. A timed-out Activity may still finish and requires
reconciliation. The durable ledger still guards duplicate work after Temporal
history retention or when a raw SDK caller uses another workflow ID.

Real service checks used `127.0.0.1:7239` (health SERVING) and dedicated PostgreSQL
`127.0.0.1:55439/am_temporal_test`, without restarting either service. SDK Workers
ran on isolated test queues; only those test Workers were stopped after testing.

```bash
QUEEN_TEMPORAL_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55439/am_temporal_test \
QUEEN_TEMPORAL_TEST_ADDRESS=127.0.0.1:7239 \
pnpm exec vitest run src/temporal/planning-temporal.integration.test.ts \
  src/temporal/runtime.integration.test.ts src/temporal/config.test.ts
pnpm exec tsc -p tsconfig.json --pretty false
```

Results: 3 files / 8 tests passed, typecheck exit 0. Verified actual Activity
history reports consumePlanning and maximumAttempts=1; planning creates a real
approval Checkpoint; duplicate IDs reject; alternate workflow IDs return
duplicate-committed; invalid input never schedules an Activity; missing/expired/
wrong-scope records reject without ledger claims; busy/uncertain claims do not
replay. Original approval rejection recovery and worker-replacement timer tests
also passed. Catalog/provider ports are controlled local fixtures, not real
provider, refund, chain or production proof.

Remaining delivery: production supervisor/process lifecycle, authenticated HTTP
submission and authorization boundaries, readiness monitoring, actual provider
acceptance and real business compensation composition. No continuously ready
production consumer or frontend queued-acceptance readiness is claimed.

## Local runtime acceptance update: 2026-09-09

An actual loopback Temporal service (CLI 1.8.3 / Server 1.31.2), SDK 1.23.0 Worker,
and PostgreSQL passed the composite runtime integration test. It covers Worker
replacement with a durable timer, one deadline effect, uncertain-effect replay
suppression, persisted rejected approval, scope binding and expiry checks.
Evidence: `../evidence/testing/2026-09-09-temporal-local-runtime.json`.

This is stronger than adapter-only tests but is NOT full server/machine restart
or production business-host acceptance. Deadline effects are test SQL writes;
no model call, refund, chain transaction or AWS operation was performed. The
production authority/host wiring remains an active task, not a completed result.
