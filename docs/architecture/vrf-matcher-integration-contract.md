# W6 actual matcher boundary and minimum cross-process contract

Implementation update: see [vrf-matching-connected.md](vrf-matching-connected.md).
The document below records the earlier proposed boundary, not the latest delivery status.

2026-09-09. Source inspection only in this step. This is a proposed integration
contract, not an implemented call-chain or a successful VRF fulfillment report.
No new service, shared schema change, Go code change, live database operation,
chain transaction, AWS operation or Git operation was performed.

## Verified ownership of the current path

The existing candidate-selection path is:

```text
services/matcher-go/internal/handler/sqs.go: HandleMessage
  -> services/matcher-go/internal/store/postgres.go: Postgres.Process
     -> claimEventSQL (deduplicate consumer + event ID)
     -> lockTaskSQL (matching task + request ID, FOR SHARE)
     -> recallSQL (database eligibility/semantic recall)
     -> ranking.Select(candidates, event.RequestID, event.ModelVersion)
     -> persistCandidateSQL (agent_market.match_candidates)
```

The handler source was read; no SQS/AWS call was made. `Process` itself is a
local SQL transaction and can later be exercised directly without AWS.

TE's task POST creates a funding-pending draft. TE's `OrderService` applies order
commands with optimistic versioned storage; it does not run this recall/ranking
path. The domain `TaskAggregate.assign` is not evidence of a production matcher
entrypoint. Chain `assignAgent` projection explicitly produces manual review
because assignment-wallet projection is missing. Replacing or adding a TE-only
matching route would leave the Go write path able to bypass a VRF ledger.

Current matcher SQL derives status=active, available=true, embedding validity,
capability containment, category, required tags and minimum budget from database
rows. It also reads score history. It does not check owner-only/delegated caller
scope or a VRF mode/ledger. `owner_wallet` existing on the agents table alone is
not a permission policy. Do not manufacture an authorization verdict or accept
client-supplied candidates as a substitute.

TE approval code reads the workflow from `queen_runtime_public.queen_workflows`
and uses graph revision, `snapshot.graphConfirmedRevision` and `snapshot.runId`
as readiness guards. The older migration also contains an `agent_market` workflow
table. Actual configured namespace must be used; do not guard a stale duplicate
table and claim the running graph is locked.

## Minimum contract (proposal, not added to shared contracts)

The existing processes should exchange a durable selection intent in their shared
PostgreSQL boundary, rather than requiring a new HTTP service or queue. Existing
`match.requested.v1` need not carry candidate arrays or determine selection mode.
Both sides read the server-owned selection intent by task ID.

```typescript
type SelectionIntentV1 = {
  schemaVersion: "selection-intent.v1";
  taskId: string;                 // stable canonical task UUID
  taskRevision: number;
  graphRevision: number | null;
  workflowRecordVersion: number | null;
  mode: "ranked" | "vrf-exploration"; // explicit, persisted, not changed on retry
  requestId: string;
  matchJobId: string;
  modelVersion: string;
  policyVersion: string;
  callerPrincipalId: string;      // from authenticated server context
  authorizationRevision: string; // from authoritative permission source
};

type QualifiedPoolSnapshotV1 = {
  taskId: string;
  taskRevision: number;
  poolRevision: number;
  authorizationRevision: string;
  policyVersion: string;
  modelVersion: string;
  evaluatedAt: string;            // fixed for time-dependent ranking inputs
  taskMaterialDigest: string;     // requirements/category/tags/budget etc.
  eligibilityEvidenceDigest: string;
  poolDigest: string;
  candidates: Array<{
    agentId: string;
    agentRevision: number;
    modelTag: string;
    weight: number;               // versioned server policy, never client input
  }>;
};

type SelectionDecisionV1 =
  | { mode: "ranked"; status: "ranked"; candidateIds: string[] }
  | { mode: "vrf-exploration"; status: "oracle_pending";
      taskId: string; taskRevision: number; poolRevision: number;
      poolDigest: string; commitment: string; requestId: string | null }
  | { mode: "vrf-exploration"; status: "verified";
      taskId: string; taskRevision: number; poolRevision: number;
      poolDigest: string; commitment: string; requestId: string;
      selectedAgentId: string; evidenceRef: string }
  | { status: "stale" | "task_locked" | "authorization_unavailable" };
```

The `verified` branch is a FUTURE acceptance shape. The existing adapter cannot
produce it and no real evidence is available. A fully populated JSON object or
passing synthetic tests is not sufficient to enable it.

The authoritative source and revision contract for caller authorization must be
resolved at the existing registry boundary before enabling VRF. Unknown permission
is an explicit failure for that VRF intent, not a public-pool default. Missing mode
must not silently be classified as VRF. Existing explicitly non-VRF tasks follow
their existing ranked mode; a VRF-bound task cannot switch modes to escape pending.
A one-time legacy-mode mapping, if needed, must be explicit and audited.

## Required transaction ownership and order

Both existing writers must participate. Holding a lock in TE alone does not protect
against a Go transaction that ignores the ledger, or a workflow writer with no
compatible version guard.

1. Read/lock the canonical task row `FOR UPDATE`; validate its request, expected
   version, matching status, and that no assignment/deal has already been accepted.
2. Lock the current workflow record or its approved revision guard using the actual
   configured schema. Confirm no confirmed graph, active run or locked assignment
   can be replaced. Follow the same lock order in every participating writer.
   If a workflow row does not yet exist, serialize its creation through the same
   task lock or a task-scoped advisory lock; locking a nonexistent row is insufficient.
3. Read the persisted selection mode and stable task ledger BEFORE recall/ranking.
   For a previously bound VRF task, return its stored decision or stale/locked
   condition. Never re-enter ranking, recall a replacement pool, or change its mode.
4. For a first VRF intent, derive the eligible pool using the real database task
   requirements/category/tags, availability, capabilities, budget, model identity,
   caller authorization and fixed policy inputs. Snapshot agent revisions and
   qualification evidence. Lock relevant source rows, or use serializable isolation
   with revision validation and transaction retries; prevent newly qualifying-row
   phantoms as well as updates to existing candidates. Every authorization/registry
   writer must participate in the revision/locking contract.
5. Canonicalize the immutable pool and invoke `VrfBindingAdapter.freeze` through
   `SqlVrfBindingStore` on the SAME transaction client. Persist the selection intent,
   snapshot, ledger and event claim atomically. No unlock/relock gap or independent
   adapter connection. Do not rely on the current unqualified SQL table search_path;
   agree a single schema for the ledger before sharing it with Go.
6. Commit a VRF pending decision without calling `ranking.Select` or writing a
   fabricated winner. A successful event-consumption claim must not strand work:
   persist the pending request/observation work atomically for the existing polling
   or worker mechanism to resume. Do not invent a new service.
7. A future authenticated oracle reader validates real coordinator receipts, chain,
   selector, original request, commitment, confirmations and canonical block before
   producing an evidence-backed selection. On application, repeat task/workflow/
   mode/revision locks and the one-time compare-and-set before writing a candidate
   decision. A late result for an accepted deal or confirmed graph is recorded as
   non-applicable; it never overwrites either. Oracle delay never authorizes reroll.

A receipt's arbitrary address string is not authenticated fulfillment. The current
adapter `recordCallback` only quarantines locally bound claims and cannot serve as
the evidence-backed application step. Do not expose it as a browser-writable route.

## Minimal required code scope for actual connection

- Go `Postgres.Process` must branch on authoritative mode before `ranking.Select`
  and candidate writes, participate in shared task/workflow/ledger locks, and return
  an explicit pending outcome for VRF. Its existing `ProcessResult` only contains
  duplicate/candidates; an empty candidate list must not ambiguously mean pending.
- The TE matching coordinator must expose the authoritative snapshot/transaction
  composition over existing SQL storage. It may call the existing TypeScript SQL
  adapter in-process; Go reads the same persisted binding instead of executing TS
  or accepting a caller-crafted commitment. Keep ABI digest construction in one
  reviewed implementation, or add cross-language golden-vector parity tests.
- Both candidate-consumption/assignment writers must enforce the persisted mode and
  task/workflow revision. Shared storage schema changes are needed for intent,
  snapshot and guard ownership. These changes exceed the TE-only scope of this turn.
- No Web, commercial, risk, queenGateway, Temporal or shared event-schema change is
  proposed here. Changes to workflow writers, if required for lock participation,
  need an explicitly bounded separate scope before any all-writers guarantee.

## Required real PostgreSQL acceptance tests (not yet executed)

Use a dedicated local PostgreSQL/pgvector database, two independent connections,
and the actual Go `Process` plus TE transaction composition. Do not connect to a
production database or execute external transport handlers. A local PGlite unit
run is not the requested multi-process PostgreSQL concurrency evidence.

- Two distinct event IDs/match jobs for the same VRF task: one snapshot/binding;
  no second rank call or second pool, including different matching revisions.
- Concurrent tag/availability/authorization edits versus snapshot creation:
  serializable retry or revision conflict, never a mixed qualification snapshot.
- Old task revision, old graph revision, wrong pool digest and callback replay:
  no candidate or assignment mutation, with the original reservation retained.
- A confirmed/accepted graph/deal racing with a late verified result: the existing
  commitment wins; callback cannot replace it, independent of commit order.
- A ranked-mode task progresses during a VRF oracle outage; a VRF task cannot
  change to ranked mode or use a random/local seeded fallback.
- Restart between pending-intent commit and fulfillment processing: existing
  pending work is resumable and uniqueness survives both process restarts.

## Delivery status

| Layer | Status |
| --- | --- |
| Solidity selector | Implemented, locally tested in previous turn; not deployed |
| TS binding + dedicated SQL adapter | Implemented, locally tested in previous turn |
| Real matcher ownership inspection | Completed this turn; Go owns recall/ranking/candidate writes |
| Cross-process integration contract | Specified here; not yet implemented |
| TE-to-Go binding guard in running matching path | NOT connected |
| Authoritative authorization/revision snapshot | NOT connected |
| Shared PostgreSQL concurrency acceptance | NOT executed |
| Real oracle fulfillment and verified selection application | Pending external evidence and integration |

Fixed `pending` is an honest adapter limitation, not completion of VRF functionality.
