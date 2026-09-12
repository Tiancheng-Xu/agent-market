# W6 connected matching implementation

2026-09-09. This is the current implementation record, superseding the disconnected
status in `vrf-matcher-integration-contract.md` and `vrf-binding-adapter.md`.

## What is connected

```text
TE POST /api/tasks/:taskId/selection
  authenticated session + recent auth + same-origin + database publisher check
  -> task advisory lock + task row lock + authoritative workflow lock
  -> qualification revision read lock
  -> database-qualified, authorized, model-deduplicated pool
  -> VrfBindingAdapter.freeze on the same SQL transaction
  -> public.vrf_exploration_bindings + vrf_selection_intents + existing outbox

existing matcher-go Postgres.Process
  -> database vrf_match_gate BEFORE normal ranking/event consumption
  -> ranked: original recall/ranking/persistence
  -> oracle_pending / binding_stale: explicit outcome, no ranked fallback
  -> verified: persist only the original binding's evidence-backed candidate

TE GET /api/tasks/:taskId/selection
  -> authenticated publisher read
  -> optional configured read-only chain-state reader, outside SQL locks
  -> lock/revalidate task, workflow, qualification and binding AGAIN
  -> dedicated immutable verified evidence + matcher wakeup in existing outbox
  -> next Go Process can resume even if the original pending event was consumed

candidate/task/workflow database triggers
  -> deny alternate candidate, mode replacement, new pool or overwritten frozen graph
```

The existing outbox/message transport was not started or exercised against AWS.
The tests pass the persisted protocol through the actual Go process implementation
in separate local processes. No new daemon, cloud resource, service or event schema
was introduced. Application deployment and cloud transport operation are not claimed.

## Files and activation

- `database/migrations/0024_vrf_matching.sql`: modes, qualification revision clock,
  intent/evidence storage, shared ledger constraints, gate functions and write guards.
- `apps/transaction-engine/src/matching/service.ts`: transaction composition,
  authoritative qualification and access checks, status and oracle application.
- `apps/transaction-engine/src/matching/http.ts`: existing session authentication,
  same-origin write protection, recent auth, server-owned configuration.
- `apps/transaction-engine/src/matching/oracle-reader.ts`: pinned-code read-only
  confirmed-chain state reader. No signer, wallet or transaction-sending operation.
- Task `selection` and agent `selection-access` API routes invoke that service.
- `services/matcher-go/internal/store/postgres.go`: actual matcher gate and verified
  candidate branch. No ranking call is made for pending, stale or verified VRF modes.
- `SqlVrfBindingStore` now explicitly uses `public.vrf_exploration_bindings` and the
  same stable task identity index as the migration, independent of search_path.

Apply migration 0024 through the normal migration procedure before running the new
matcher binary. It depends on the existing task/agent, matcher, score-event and
workflow migrations. This turn applied it ONLY in dedicated local test databases;
it did not migrate the shared application/production database.

Workflow storage is resolved to `queen_runtime_public.queen_workflows` when present,
otherwise the existing `agent_market.queen_workflows`. The chosen table must have
the installed write guard. If a runtime schema/table is created after migration,
install its guard through the normal migration path before enabling VRF; the
service fails closed when that guard is missing. It never assumes a missing guard
means the active graph is unlocked.

## Authorized mode and pool configuration

Task selection POST accepts only:

```json
{"mode":"vrf-exploration","expectedVersion":7}
```

`ranked` is the other allowed mode. The authenticated wallet must own the database
task, the task must be matching with no assigned agent, and an existing confirmed
or running workflow cannot be changed. The first configuration increments task
version and atomically persists its mode, intent, binding and outbox event. Another
configuration, including ranked-to-VRF or VRF-to-ranked after reservation, is denied.
Prior candidate writes or consumed matching events also prevent changing modes.

Existing tasks receive an explicit `ranked` migration default and continue through
the existing ranking implementation without any oracle dependency. Missing VRF
configuration does not disable ranked processing.

Agent access POST accepts only:

```json
{"access":"public-market","expectedVersion":2}
```

Only the authenticated agent owner may change access, with recent auth and a
version check. New `selection_access` defaults to `owner-only` for VRF qualification;
this does not retroactively change the legacy ranked eligibility SQL. An active
agent is not assumed publicly authorized merely because it has an owner wallet.
Public-market access or an owner match with the task publisher is required in the
VRF pool. There is no browser-supplied candidate or administrator override array.

The pool comes from database status, availability, nonzero task/agent embeddings,
capabilities, task requirements/category/tags, minimum budget, model identity and
this authorized access record. It is deduplicated by model with deterministic
semantic-distance/agent-ID ordering. The `qualified-equal-v1` policy gives each
qualified model representative weight 1. Over 128 representatives rejects the
request rather than truncating or randomly selecting a favorable pool.

## Concurrency, persistence and state protections

Both TE and Go use a task-scoped advisory lock and the task row lock. Workflow
creation/update triggers participate in the advisory lock, including the missing-row
case. Existing workflow rows are locked when snapshots are inspected. Frozen graph
or assignment changes are rejected; confirmation/run updates can make a subsequent
observation non-applicable, but cannot change the bound pool or reroll it.

A singleton qualification clock is advanced BEFORE agent or score-event write
statements. Snapshot readers hold its shared lock through commit, preventing mixed
snapshots and insertion phantoms. The stored revision is rechecked by both Go and
TE. This is deliberately conservative: even an unrelated qualification write can
make a pending VRF binding stale. Staleness never unlocks a replacement draw. The
ranked path does not depend on this qualification revision or on oracle availability.

Task material changes (requirements, tags, category, budget, embedding, status or
assignment) advance task revision even if a writer omitted an explicit increment.
Changing the bound request/publisher or switching the mode is rejected. The stable
ledger key is independent of revision, matching job, policy and selector deployment.
The SQL binding is immutable; state updates require exactly one version increment,
a valid next phase, and preservation of an already attached request key.

The original event's pending consumption is not a dead end: successful real evidence
application creates a new wakeup in the existing outbox, preserving the bound task,
request and matching job in the payload. Go's verified branch handles even an
already consumed event and inserts only the original candidate idempotently. The
outbox wakeup has its own event/request trace ID; payload requestId remains the
canonical matching task request ID.

Database guards cover bypasses through direct `match_candidates` and task agent
updates, not only calls to the new service. Candidate guards identify the task by
request ID OR the reserved match job. A confirmed graph cannot be overwritten by a
late callback, and an already assigned/completed task cannot be reassigned. Existing
order authorization and financial settlement rules remain separate; VRF is not used
to determine arbitration, fund ownership or stake disposition.

These protections assume ordinary application credentials and intact migrations.
A PostgreSQL superuser can disable triggers or replace code; no claim is made that
an application can resist its database superuser doing so.

## External oracle gate, without fabricated evidence

Configuration uses server environment only:

- `DATABASE_URL`
- `VRF_CHAIN_READER_DATABASE_URL` for the dedicated evidence recorder role
- `VRF_SELECTOR_ADDRESS`, `VRF_COORDINATOR_ADDRESS`
- For actual reads: `SEPOLIA_RPC_URL`, `VRF_SELECTOR_CODE_HASH`,
  `VRF_COORDINATOR_CODE_HASH`

The namespace is fixed to `agent-market-exploration`, chain ID to Sepolia 11155111.
The deployed runtime code hashes must come from independently checked deployment
and official coordinator evidence. No hash or address is generated as a production
substitute by this implementation. Missing pins leave the real reader disabled.

The chain-reader URL must use a different normalized database credential identity
from `DATABASE_URL` on the same PostgreSQL endpoint. Runtime initialization rejects
credential reuse or malformed URLs with symbolic errors and never logs either URL.
Missing database authorization remains fail closed: evidence is not recorded and a
VRF task stays pending.

After migration 0024, a DBA must provision a dedicated login role separately. Do
not put a password or `CREATE USER` in an application migration. The role must be
`NOINHERIT`, non-privileged, and have no memberships. Apply the parameterized grant
script as the migration owner/DBA; the ordinary app role must not own the recorder
function:

```bash
psql "$DBA_DATABASE_URL" \
  --set=vrf_chain_reader_role=agent_market_vrf_chain_reader \
  --set=app_runtime_role=agent_market_app \
  --file=database/vrf-chain-reader-grants.sql
```

The script grants only database `CONNECT`, schema `USAGE`, and `EXECUTE` on
`agent_market.vrf_record_verified_selection(uuid,text,uuid,text,jsonb)`. It revokes
reader table/sequence/function privileges before adding that single function grant,
explicitly denies direct writes to `vrf_verified_selections`, revokes recorder
execution from the app role, and aborts when its post-grant checks do not prove the
boundary.

The reader checks chain ID, both code hashes, the consumer's coordinator, frozen
commitment/policy/eligibility/total weight, nonzero original request, and fulfilled
consumer state at a block with 12 confirmations. The selected interval is recomputed
from that original word. State 3 (authenticated randomness received) permits the
same deterministic off-chain choice; state 4 additionally must match the consumer's
finalized selected key. Canonical block hash is checked again through a fresh RPC
call. Each RPC request has an 8-second timeout. No chain transaction is sent.

This trusts the configured RPC and pinned, independently vetted contract deployments;
it reads the confirmed result of the coordinator's proof verification rather than
recomputing a cryptographic VRF proof off chain. A malicious/misconfigured RPC or
incorrectly approved code pins remain external trust risks. Deep reorg monitoring
after evidence application is not implemented in this step.

The private reader application path re-locks all authoritative revisions after the
external read, then writes an immutable evidence record and wakeup. The SQL insert
guard requires that private reader context and checks the matching binding/request,
word range, weighted winner and evidence structure. There is no public route that
accepts `verified`, a winner, randomWord, code hashes, evidence or an admin override.
The earlier `recordCallback` hook still quarantines claims and cannot itself create
verified evidence or authorize assignment.

Current external status: NO deployed selector was verified, NO subscription was
created/funded, NO real oracle response was fetched, and NO public-chain transaction
was sent. The code's real evidence path is implemented but awaits those prerequisites.
It is not represented as completed verifiable fairness.

## Minimal UI response

GET returns database-backed mode and status. VRF without evidence returns the
adapter's task/pool revisions, commitment, request ID and phase, with:

```json
{"mode":"vrf-exploration","status":"pending","fairnessVerified":false,"selectedAgentId":null}
```

An unavailable configured reader adds `pendingReason: "oracle-unavailable"`.
Changed task/pool/workflow binding returns `binding_stale` or a locked-task conflict;
there is no automatic fallback. Only the private real-reader path can produce the
integrated `verified` response with selected agent and anchored evidence. Web files
were not changed.

## Executed verification

The dedicated local PostgreSQL suite used PostgreSQL **16.15**, pgvector **0.8.6**,
on loopback port 55439 in `am_vrf_w6_test`. No shared database schema was cleared.
The separate legacy harness created and removed its own randomly named test database.

- 12 new real-PG integration scenarios passed: authenticated configuration/access,
  DB-derived pool filtering, normal ranked processing, concurrent freezes/Go replays,
  qualifier write/snapshot isolation, old revisions and changed pools, callback
  quarantine/replay, direct SQL guards, confirmed/completed tasks, graph races,
  and the reader-to-wakeup-to-Go protocol.
- The positive trusted-reader protocol test injects a **synthetic reader only** into
  the local test service. It verifies SQL/Go handoff and write guards; it is NOT an
  oracle fulfillment, deployed-contract test or fairness acceptance evidence.
- Three HTTP authorization/input tests and eight existing binding tests passed.
  Combined targeted run: **23 passing**.
- Existing Go `go test ./...` passed.
- Existing real `TestPostgresPgvectorIntegration` passed through its ownership-checked
  harness, confirming legacy ranked recall/persistence under the new migration.
- TE full TypeScript check and focused new-module check passed. Earlier concurrent
  risk-module type errors were gone on the final full check; those files were not
  changed by this agent.

Commands from their respective project roots:

```bash
# TE, with the dedicated local test password supplied securely in the environment:
./node_modules/.bin/vitest run src/matching/postgres.integration.test.ts src/matching/http.test.ts src/chain/vrf-selection-binding.test.ts
./node_modules/.bin/tsc -p tsconfig.json --incremental false
# matcher-go:
go test ./...
# With a loopback-only TEST_POSTGRES_ADMIN_URL supplied securely:
go run ./cmd/integration-harness
```

The PG test file skips without `VRF_TEST_PASSWORD`; the reported passing run had
that variable supplied and actually executed all 12 scenarios. Go's ordinary unit
run similarly does not substitute for the separately executed PG harness.
