# W5: real local Temporal server restart acceptance

Verified locally on 2026-09-10 UTC. Machine-readable results are in
`server-restart.evidence.json`; the executable is `server-restart-probe.ts`.
Earlier planning/approval/PostgreSQL Checkpoint evidence remains separate and was
not replaced or rerun by this probe.

## Exact scope and commands

Only this task's Temporal development server is eligible:

```text
Executable: /tmp/agent-market-temporal.m7smAO/temporal
Address: 127.0.0.1:7239
SQLite: /tmp/agent-market-temporal.m7smAO/temporal.sqlite
Arguments: server start-dev --ip 127.0.0.1 --port 7239 --headless --db-filename /tmp/agent-market-temporal.m7smAO/temporal.sqlite
Database: existing am_temporal_test on 127.0.0.1:55439
```

From `apps/local-agent-runner`:

```bash
pnpm exec tsc -p tsconfig.json --pretty false
QUEEN_TEMPORAL_SERVER_RESTART_TEST=true \
QUEEN_TEMPORAL_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55439/am_temporal_test \
pnpm exec tsx src/temporal/server-restart-probe.ts
```

Before executing, coordinate with anyone using this service. The probe checks for
running Workflows before setup and checks again before shutdown, allowing only
its two Workflow IDs. It validates a single listening PID and its exact command
against the pinned executable/SQLite path. These checks cannot replace coordination
with an idle client that may submit work later. On conflict, stop and report;
do not terminate the other workload or restart another server.

The probe gracefully SIGTERMs only that validated server PID, waits for exit, then
starts the identical command with the same SQLite file. It makes no database or
checkpoint migration. Two fixture tables/unique rows are created in the existing
dedicated test database. The existing `temporal_test_checkpoints` schema is used.
It leaves the replacement development server running and closes only its own SDK
Workers and SQL/ledger/saver/client handles. Logs are local under
`/tmp/agent-market-temporal.m7smAO/restart-probe-server.log`. No SQLite files or
database records are deleted. The startup command is not a production supervisor.

## Observed results

Typecheck and probe both exited 0. The real server process was replaced. Fresh SDK
connections after restart recovered the same order and planning Run IDs. A timer
recorded before shutdown fired naturally after restart, without a wake-up Signal.
The authorized fixture deadline wrote exactly one SQL effect through the ledger.

Before restart, the probe durably inserted a separate fixture SQL effect and then
raised an acknowledgement-loss error inside the existing operation ledger,
producing `uncertain`. Its planning Workflow was submitted with the Worker stopped.
After server restart, the real registered planning Activity returned `uncertain`,
left that ledger status intact and did not repeat the effect. A repeated SDK start
was rejected as `WorkflowExecutionAlreadyStartedError`.

```json
{
  "sameOrderRun": true,
  "samePlanningRun": true,
  "persistedTimerFired": true,
  "deadlineEffects": 1,
  "uncertainEffects": 1,
  "uncertainLedgerRetained": true,
  "duplicateWorkflowRejected": true
}
```

The evidence stores only test Workflow IDs, counts, boolean checks, local service
identity and verification time. It excludes prompts, credentials, wallet data,
connection strings and raw business snapshots. These are real Temporal/PG results
with controlled SQL effects, not proof of provider inference, refunds or chain
settlement. Passing applies to this local persistence configuration, not HA or
production recovery guarantees.

## Production configuration still required

- A supervised Worker process, shutdown/restart policy and liveness/readiness probes.
- Supported production Temporal endpoint policy, TLS/mTLS/auth secret loading,
  namespace, task queues, retention and access controls. Current config deliberately
  accepts loopback only and cannot be pointed at remote production unchanged.
- Durable production Temporal storage, backups/restore procedure, monitoring and
  availability policy instead of the development server's task-local SQLite.
- Trusted catalog/provider credentials and actual provider acceptance; no caller
  supplied identity or test catalog promoted to production authority.
- Existing public authority/ledger database and shared Checkpoint database/schema,
  provisioned grants, credentials, connection/time limits and safe secret handling.
- Authenticated HTTP submission, business compensation grants, uncertainty
  reconciliation ownership and evidence-backed consumer readiness. Neither frontend
  async/readiness flag is enabled by this probe.
- Versioned workflow bundles/worker rollout policy and history replay validation
  before deploying future workflow changes.
