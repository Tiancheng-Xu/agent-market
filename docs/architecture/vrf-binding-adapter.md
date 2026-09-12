# W6 VRF binding adapter handoff

Implementation update: [vrf-matching-connected.md](vrf-matching-connected.md) records
the subsequently connected TE/Go path, SQL guards, and external evidence gate.

Local implementation, 2026-09-09. No deployment, subscription funding, chain
transaction, external database migration, AWS, or Git operation was executed.
All callback/randomness fixtures are synthetic. Real oracle evidence is pending.

## Existing integration gaps confirmed by source inspection

| Existing component | Observed behavior | Remaining connection |
| --- | --- | --- |
| `packages/contracts/contracts/VRFExplorationSelector.sol` | Frozen weighted qualified pool, one request per task, coordinator-only callback | No public deployment or genuine request/fulfillment readback |
| `apps/transaction-engine/src/domain/tasks.ts` | Task ID, status and monotonically incremented `version` | Authoritative version snapshot must be supplied to this adapter |
| `packages/shared-contracts/src/events.ts` | `match.requested.v1` has taskId, eventId, requestId, matchJobId, modelVersion | Does not contain qualified-pool revision/digest or task revision |
| `apps/local-agent-runner/src/queen-ranking.ts` | Qualification filters, model deduplication, history ranking and local seeded cold-start shuffle | Existing local seed is not Chainlink VRF; obtain a versioned eligible exposure pool before using adapter |

No shared event schema, matching entry, ranking rule, task aggregate, Web,
commercial feature, Temporal component or reconciliation implementation was changed.
The adapter is implemented but is not wired into those shared entrypoints.

## New independent modules

- `apps/transaction-engine/src/chain/vrf-selection-binding.ts`: strict preparation,
  persistent state transitions, quarantined callback binding and minimal UI view.
- `apps/transaction-engine/src/chain/vrf-selection-binding-store.ts`: parameterized
  SQL storage in its own `vrf_exploration_bindings` table. Explicit initialization;
  never runs implicitly or connects to any database itself.
- `apps/transaction-engine/src/chain/vrf-selection-binding.test.ts`: real local
  PGlite storage tests, synthetic callbacks. Existing dependencies only.

## Proposed composition shape (no shared schema change yet)

```typescript
type VrfBindingInput = {
  task: { id: string; version: number; status: TaskStatus };
  match: {
    taskId: string; eventId: string; requestId: string;
    matchJobId: string; modelVersion: string;
  };
  pool: {
    taskId: string; taskRevision: number; revision: number;
    policyVersion: string; modelVersion: string;
    evidenceDigest: string; // nonzero bytes32 digest of qualification evidence
    candidates: Array<{ agentId: string; weight: number }>;
  };
};
```

The parent must construct this input from authoritative task/match/pool snapshots,
not HTTP request bodies or an administrator's self-attested candidate list. The
pool is qualified-only and model-deduplicated by the existing admission/ranking
policy. This module validates identity, shape, positive uint32 weights, duplicate
IDs and snapshot provenance; it does not independently reimplement qualification
or invent a weight policy. It must not silently use a revision inferred from wall
time. The existing matcher does not yet expose this snapshot contract.

Use one fixed namespace and one shared persistent store for the application.
Within a database transaction, lock/read the task and pool revisions, then invoke
the adapter through a transaction-bound SQL client. This ensures the supplied
`current` snapshot remains current through the state transition. The module's own
compare-and-set protects its ledger; it cannot lock external task/pool rows that
have not been connected. This authoritative snapshot integration remains pending.

`VrfSqlClient.query<T>(sql, params)` returns `{ rows: T[] }`. A parent-owned wrapper
can adapt the existing SQL client without changing its shared configuration.
Initialize this dedicated table via the parent's approved local migration path;
only in-memory PGlite initialization was exercised here. Do not create a fresh
store or namespace for each request, process or admin retry.

## Stable identity and contract compatibility

`taskKey` and `taskFingerprint` are the same digest:

```text
keccak256(abi.encode(keccak256("AGENT_MARKET_TASK_V1"), namespace, task.id))
```

No revision, matching round, deployment or policy version is part of that key.
Changing any of those cannot create a second row in the same application store.
Agent string IDs map to deterministic bytes32 keys with the separate
`AGENT_MARKET_AGENT_V1` domain. Candidates sort by their encoded key before hashing,
so enumeration order cannot change the pool. Raw task/agent IDs must already be
canonical registry IDs; aliases cannot be discovered from strings by this module.

The pool digest commits every qualified candidate key and weight. The policy
commitment covers policy/model versions. The eligibility commitment covers the
task fingerprint, task revision, pool revision, pool digest, qualification evidence
and match event/request/job identities. The final `commitment` uses the exact
Solidity `AGENT_MARKET_EXPLORATION_V1` ABI encoding, chain ID and selector address.

Future contract freeze arguments, without sending them in this task:

```typescript
[
  binding.taskFingerprint,
  binding.policyVersion,
  binding.eligibilityCommitment,
  binding.candidates.map(c => ({ agentId: c.agentKey, weight: c.weight, eligible: true }))
]
```

## State and rejection guarantees

`freeze(current)` writes the local ledger only; it does not freeze a deployed
contract. One primary-key row per stable task rejects even identical repeated
freezes, policy/revision changes and alternate deployment attempts. There is no
admin bypass, reset, delete, replacement draw or timeout reroll method.

`bindRequest(current, requestId)` accepts one nonzero canonical uint256 request ID
claim. It does not verify that an actual coordinator emitted that ID. SQL CAS
allows only one transition from `awaiting_request` to `awaiting_oracle`. A unique
chain/selector/request key additionally prevents reusing one request for two tasks.

`recordCallback(current, claim)` compares task key, fingerprint, both revisions,
pool digest, policy, commitment, chain, selector, coordinator and original request.
It recomputes the weighted interval from the bounded uint256 word and checks the
claimed agent belongs to that exact interval. Invalid claims do not consume the
slot; competing valid claims cannot both pass SQL CAS. Replayed callbacks are
rejected. A changed current task/pool/match binding is rejected as stale, while the
original ledger remains permanently reserved; staleness never unlocks another draw.

A bound claim moves only to `callback_bound` and is quarantined. This method MUST
NOT be exposed as a public unauthenticated callback route: a matching string
address does not authenticate a caller, and a fabricated first claim could consume
that quarantined slot. Only a future trusted coordinator-receipt reader should
supply it. The Solidity contract provides actual callback sender authentication.
There is no off-chain proof verifier or verified-result promotion path here.

A malicious database operator can delete records, and a server operator can use a
new namespace/store. Prevent those administrative escapes with permissions and a
single authoritative registry. This module does not claim to resist administrators
who can rewrite its persistence or replace its code.

## Minimal UI interface

`adapter.view(current)` returns:

```typescript
{
  taskId: string;
  taskRevision: number;
  poolRevision: number;
  poolDigest: string;
  commitment: string;
  requestId: string | null;
  phase: "awaiting_request" | "awaiting_oracle" | "callback_bound";
  status: "pending";
  oracleEvidence: "pending";
  fairnessVerified: false;
  selectedAgentId: null;
  pendingReason: "request-not-observed" | "oracle-fulfillment-unverified";
}
```

Display a waiting state plus task/pool versions. `callback_bound` means local
binding validation only; do not label it verifiably fair or use its quarantined
candidate for matching, arbitration, settlement, stake disposition or payment.
A stale-view error should be displayed as a binding mismatch needing investigation,
not an invitation to reroll. No existing Web file was edited.

## Verification and evidence gaps

Executed with `/bin/bash`, `login:false`, in `apps/transaction-engine`:

```bash
./node_modules/.bin/vitest run src/chain/vrf-selection-binding.test.ts
./node_modules/.bin/tsc -p tsconfig.json --incremental false
```

Eight dedicated tests passed with a real local SQL engine. Coverage includes
Solidity-compatible commitment encoding, enumeration invariance, revision/pool
changes, invalid eligibility snapshot shape, adapter recreation using the same
store, concurrent freezes/requests/callbacks, replay rejection and invariant
pending UI state. TypeScript passed. These tests neither read a real chain nor
verify a Chainlink cryptographic proof.

Pending acceptance work: authoritative versioned qualification snapshot adapter;
transactional locking of current task/pool during integration; production SQL
composition/migration; matcher wiring; authenticated coordinator request/receipt
reader; actual deployment/configuration/subscription readback; real fulfillment
and confirmation/reorg verification; and a separately reviewed evidence-gated
promotion path. None is represented as complete by the local callback tests.

## Reader regression handoff

`readers.unlock.test.ts` adds 13 tests for failed unlock recovery, shared concurrent
attempts, three-attempt network/timeout/5xx limits, no automatic 4xx retry, JSON
parse failure cache clearing, successful unlock caching and downstream failures.
The production reader was changed concurrently before this agent's patch applied;
the patch was not applied and the other writer's fix was preserved. Together with
existing reader tests, all 15 passed against the current reader.

External unavailability should be distinguished by the parent from transaction
failure or an invalid chain receipt: retain verification pending with a dependency
unavailable reason, record attempt count/next check time, and use bounded scheduled
backoff. Authentication/configuration 4xx should surface a configuration issue;
429 should be scheduled according to rate limits rather than immediately retried.
The current compatible `BLOCKSCOUT_UNAVAILABLE` error does not expose those
subcategories. This delivery does not change broad reconciliation behavior.
