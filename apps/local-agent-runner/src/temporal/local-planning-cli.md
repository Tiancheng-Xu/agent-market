# Explicit local planning CLI

Run from `apps/local-agent-runner` after the host provisions existing business and
Checkpoint schemas. This executable consumes one explicit batch and exits. It
does not start a server, poll, run AWS, execute a provider, or enable frontend
queued acceptance. No Temporal Activity is registered by this CLI.

Required trusted process environment:

```text
QUEEN_LOCAL_PLANNING_ENABLED=true
QUEEN_PUBLIC_DATABASE_URL=<existing loopback PostgreSQL URL>
QUEEN_CHECKPOINT_DATABASE_URL=<existing loopback PostgreSQL URL>
QUEEN_CHECKPOINT_SCHEMA=<existing PostgresSaver schema>
```

Both URLs must use PostgreSQL and loopback hosts, with no query or fragment.
Do not put connection strings or provider keys in shell arguments or logs. The
CLI uses the exported process environment; it does not load `.env.local` or
accept a caller-supplied catalog. The host must securely export its runner config.

Catalog policy uses `parseRunnerConfig`, `providerManifests` and bounded canonical
Ollama discovery. Existing provider API-key/model-list settings apply. Configured
provider manifests remain degraded, not verified online. At least four distinct
available public model identities are required for independent execution/review
roles. The private stream-runtime candidate conversion policy is mirrored here
because its helper is not exported; a future shared extraction should update both.
Queen remains the fixed internal `queen-router-v1`. These catalog choices never
authorize tasks: persisted planning grants and current owner/task binding do.

```bash
pnpm exec tsx src/temporal/local-planning-cli.ts --request \
  '{"requestId":"<uuid>","taskId":"<uuid>","scopeId":"<uuid>"}'

pnpm exec tsx src/temporal/local-planning-cli.ts --batch \
  '[{"requestId":"<uuid>","taskId":"<uuid>","scopeId":"<uuid>"}]'
```

Replace each placeholder with its actual UUID. Exactly one argument mode is
accepted; batches contain 1-20 strict references. No extra agent/approval fields
are allowed. Output is one JSON line containing only fixed codes, array indexes
and outcomes. It excludes reference IDs, prompts, credentials and stack traces.

Exit codes: `0` means all entries committed or duplicate-committed; `2` means
disabled/config/schema/runtime/cleanup failure; `3` means a rejected/busy/uncertain
entry. A rejected result can also mean authorization storage was unavailable.
Inspect trusted host/database diagnostics before retrying; never clear or steal
an uncertain ledger claim. Success only means the plan and approval Checkpoint
were persisted. It does not mean approval, provider execution or settlement.

No migrations or `saver.setup()` run here. SQL, ledger and saver handles close in
`finally`. The public ledger and authority database share the configured public
URL. Choose the same Checkpoint database/schema as the approval-recovery host.
Stopping a process mid-operation can leave an executing/uncertain claim and
requires reconciliation.

## Verification

The integration test spawns actual CLI processes against the dedicated existing
`am_temporal_test` database on `127.0.0.1:55439`. Only its controlled fixture calls
`saver.setup()`. It uses a static provider catalog with a dummy key and performs no
provider request; this proves local planning/authorization only.

```bash
QUEEN_TEMPORAL_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55439/am_temporal_test \
  pnpm exec vitest run src/temporal/local-planning-cli.integration.test.ts
pnpm exec tsc -p tsconfig.json --pretty false
```

Temporal planning is now registered separately through `createTemporalWorker`
and `createTemporalScheduler().startPlanning`, with explicit planning config.
This CLI still does not start that Worker. Remaining system integration includes
a continuously supervised Worker, authenticated event submission, readiness/health
checks, and provider acceptance. Neither
`QUEEN_ASYNC_WORKER_READY` nor `QUEEN_ASYNC_PLANNING_ENABLED` is set by this CLI.
Frontend queued acceptance must stay gated until that consumer is actually ready.
