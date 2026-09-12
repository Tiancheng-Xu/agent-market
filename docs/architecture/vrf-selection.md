# VRF qualified-agent exploration selection

Status: implemented and verified locally on 2026-09-09. No public-chain transactions,
deployment, Chainlink subscription operations, or AWS operations were performed.
This is an advisory exposure selector, not a production VRF completion claim.

## Scope and trust boundary

`VRFExplorationSelector` draws from a frozen qualified-agent pool for discovery,
new-agent exposure, or a previously defined equal-score exploration policy. It has
no escrow, token, staking, judge, arbitration, award, or settlement calls. Its result
MUST NOT determine dispute resolution, ownership of funds, stake forfeiture, or
replace Judge / Final Arbiter decisions.

The immutable `freezer` attests eligibility and policy inputs. It must be the
platform's authorized admission service, not an arbitrary task publisher. VRF
proves randomness through the trusted coordinator; it does not prove that agents
are qualified or that a weight policy is fair. The contract validates pool shape,
uniqueness, ordering and eligible-only positive weights; external qualification
claims remain attestations, not on-chain credential verification.

The integration must derive one canonical task fingerprint from a stable task
identity in a fixed application namespace. Do not include retry counters, policy
versions, timestamps, pool contents, salts, or user-selected randomness in this
identity. One application task must bind permanently to one selector address and
one fingerprint. The contract prevents rerolls for the same fingerprint even
across policy versions. It cannot recognize semantically identical tasks given
new IDs or prevent an operator deploying another selector. The application must
reject these aliases and must not cherry-pick between deployments or tasks.

## Current official API checked

The official Chainlink v2.5 docs and current `chainlink-evm/develop` sources were
read on 2026-09-09:

- [VRF security considerations](https://docs.chain.link/vrf/v2-5/security)
- [Current VRFV2PlusClient](https://github.com/smartcontractkit/chainlink-evm/blob/develop/contracts/src/v0.8/vrf/libraries/VRFV2PlusClient.sol)
- [Current IVRFCoordinatorV2Plus](https://github.com/smartcontractkit/chainlink-evm/blob/develop/contracts/src/v0.8/vrf/interfaces/IVRFCoordinatorV2Plus.sol)

These are mutable upstream references, not a pinned deployment audit. The minimal
local interface matches the subscription request tuple:

```solidity
struct RandomWordsRequest {
    bytes32 keyHash;
    uint256 subId;
    uint16 requestConfirmations;
    uint32 callbackGasLimit;
    uint32 numWords;
    bytes extraArgs;
}
function requestRandomWords(RandomWordsRequest calldata req)
    external returns (uint256 requestId);
```

Requests use one word. `extraArgs` is `abi.encodeWithSelector` with the first four
bytes of `keccak256("VRF ExtraArgsV1")` followed by ABI-encoded `nativePayment`.
Both LINK and native billing refer to the external subscription, not value sent
to this consumer. No dependencies or package locks were changed. The local test
fixture compiles its mock using the already installed Hardhat transitive `solc`.

Chainlink recommends `VRFConsumerBaseV2Plus`. To meet the existing-dependency and
minimal-interface constraint, this consumer implements its authenticated raw
entrypoint directly and pins the coordinator immutably. It does not implement
coordinator migration or the full subscription management interface. A future
migration requires a separate design that preserves task uniqueness and existing
pending requests; redeployment must never be used to reroll pending tasks.

## Public application interface

```solidity
constructor(
    address coordinator_, address freezer_, bytes32 keyHash_,
    uint256 subscriptionId_, uint16 confirmations_,
    uint32 callbackGasLimit_, bool nativePayment_, uint256 timeoutSeconds_
);
struct Candidate { bytes32 agentId; uint32 weight; bool eligible; }
function freeze(bytes32 taskFingerprint, bytes32 policyVersion,
    bytes32 eligibilityCommitment, Candidate[] calldata candidates) external;
function requestSelection(bytes32 taskFingerprint) external returns (uint256 requestId);
function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
function finalize(bytes32 taskFingerprint) external returns (bytes32 selectedAgent);
function isOverdue(bytes32 taskFingerprint) external view returns (bool);
function getPool(bytes32 taskFingerprint) external view returns (Candidate[] memory);
```

`selections(taskFingerprint)` returns the following named tuple, in order:

| Field | Solidity type | Meaning |
| --- | --- | --- |
| commitment | bytes32 | Complete frozen snapshot digest |
| policyVersion | bytes32 | Nonzero immutable policy/version digest |
| eligibilityCommitment | bytes32 | Nonzero digest of qualification evidence |
| totalWeight | uint256 | Sum of eligible weights |
| requestId | uint256 | Original coordinator request, zero before request |
| requestedAt | uint256 | Request timestamp, zero before request |
| randomWord | uint256 | Original received word; zero is a valid result |
| selectedAgent | bytes32 | Selected agent; zero before finalization |
| state | uint8 | None=0, Frozen=1, Requested=2, RandomReady=3, Selected=4 |

`requestTask(requestId)` maps a request to its task. Unknown requests map to zero;
zero task fingerprints are forbidden. All constructor settings, `DOMAIN`, and
`MAX_CANDIDATES` have public getters. No settings can change after deployment.

Constructor validation requires a contract coordinator, nonzero freezer/key/subId,
3..200 confirmations, at least 150000 callback gas, and a 60-second to 30-day
operational timeout. These checks do not establish the target network's valid
keyHash, coordinator identity, subscription authorization, minimum confirmations,
or maximum callback gas. Those must be verified before any future deployment.

## Frozen commitment

IDs are nonzero, unique, ascending `bytes32` values; the full pool has 1..128
entries. Eligible entries require a positive uint32 weight. Ineligible entries
require zero weight. An all-ineligible pool is rejected. The complete input pool,
including excluded entries, remains readable. Pool evidence should include the
rules, credential/score snapshot, exclusion reasons, and candidate provenance;
keep private data off chain and retain only reproducible public-safe digests.

```solidity
keccak256(abi.encode(
    keccak256("AGENT_MARKET_EXPLORATION_V1"),
    block.chainid,
    address(this),
    taskFingerprint,
    policyVersion,
    eligibilityCommitment,
    candidates
))
```

ABI types are `bytes32,uint256,address,bytes32,bytes32,bytes32,
(bytes32,uint32,bool)[]`. This commits candidate order, IDs, eligibility, weights,
task identity, policy version, qualification evidence and chain/contract domain.
Freeze has no replacement, delete, amendment, or reset operation. Coordinator and
request configuration are immutable at the committed contract address.

## State and manipulation resistance

```text
None --authorized freeze--> Frozen --anyone requests--> Requested
Requested --coordinator's original callback--> RandomReady
RandomReady --anyone finalizes--> Selected
Requested --timeout elapses--> Requested (isOverdue=true)
```

- Inputs freeze before requesting randomness; no caller can replace them later.
- Request state changes before the external coordinator call, blocking a second
  request for the same task during that call.
- A successful request is permanent. Zero/colliding IDs revert the entire request.
  A coordinator revert rolls back the entire transaction, allowing retry only
  because no randomness request was successfully created.
- Callbacks use request ID, never arrival order. Only the immutable coordinator
  may call the entrypoint; this includes rejecting calls from the freezer.
- Callback work is constant: store one word, update state, emit an event. It makes
  no external calls and does not scan the pool. Unknown, duplicate, or incorrectly
  sized word arrays are ignored with an event. A malformed authenticated callback
  leaves the task pending; the real service may not retry such a failure.
- Timeout is an operational signal, not cancellation. Late valid results remain
  binding. No fallback randomness, manual winner, alternative request, result
  expiry, or retry path exists. Service outages can leave a task pending forever;
  the UI should show this honestly and operators may restore service/funding.
- Anyone can finalize, removing an owner-only opportunity to withhold finalization.
  Zero is a valid random word. Finalization has no time-based branch or caller
  input; the first recorded word determines the only possible winner forever.

The weighted ticket is `randomWord % totalWeight`, selecting the first eligible
cumulative interval containing that ticket. Example weights `[1,0,3]` allocate
`0` to agent 1 and `1..3` to agent 3; the excluded agent can never win. Total weight
is below 2^39, so modulo's statistical distance from exact uniformity is below
2^-217 for a uniform 256-bit input. This negligible bias is explicitly accepted
for non-financial exposure; this is not a claim of exact unbiased sampling.
There is no operator-selected rejection or reroll mechanism.

## Events and client behavior

| Event | Payload after indexed fields |
| --- | --- |
| PoolFrozen(taskFingerprint indexed, commitment indexed) | policyVersion, eligibilityCommitment |
| SelectionRequested(taskFingerprint indexed, requestId indexed) | commitment |
| RandomnessReceived(taskFingerprint indexed, requestId indexed) | randomWord |
| CallbackIgnored(requestId indexed) | none |
| AgentSelected(taskFingerprint indexed, requestId indexed, agentId indexed) | commitment |

Clients must check `state`, not truthiness of `randomWord`, and bind observed
requests/results to the configured chain and selector address. Recompute the
commitment from `getPool` and the frozen metadata. Display `isOverdue` as waiting,
not failed/cancelled. Finalization may be performed by any application actor, but
only the recorded eligible winner may be shown for this task. Never turn a mock
callback or a local transaction receipt into a real VRF verification badge.

Custom errors: `Unauthorized`, `OnlyCoordinator`, `InvalidConfig`, `InvalidPool`,
`AlreadyFrozen`, `InvalidState`, `InvalidRequestId` (all without parameters).

## Local verification

Executed from the worktree root with `/bin/bash`, `login:false`:

```bash
pnpm --filter @agent-market/contracts exec hardhat test --network hardhat test/VRFExplorationSelector.test.ts
pnpm --filter @agent-market/contracts exec hardhat test --network hardhat
pnpm --filter @agent-market/contracts exec tsc -p tsconfig.json --noEmit
```

Results: 13/13 dedicated VRF tests, 34/34 full local Hardhat tests, TypeScript exit
0. The first dedicated run failed for the expected missing new contract artifact;
the implementation then passed. Solidity 0.8.28, optimizer 200 runs, local chain
31337. No network fork or public RPC was used by the VRF tests.

Tests cover independent commitment reproduction, frozen version replay, access
control, official request encoding, weighted interval boundaries and excluded
candidates, out-of-order/duplicate/unknown/malformed callbacks, valid zero words,
late fulfillment without reroll, failed/coordinator-colliding request rollback,
invalid pools, and the maximum 128-candidate uint32-weight pool. The mock forwards
only 150000 gas to the callback. Maximum-pool local finalization used 433469 gas;
freezing used 6086089 gas. Request gas includes mock storage and is not a live
Chainlink billing estimate. Tests do not verify cryptographic VRF proofs.

## Real VRF readback gaps (NOT completed)

1. No deployed selector address, deployment receipt, verified bytecode, or
   immutable-configuration readback on a public network.
2. No verified network-specific coordinator/keyHash/gas/confirmation settings or
   funded subscription/consumer-registration readback.
3. No real RandomWordsRequested transaction, oracle proof verification,
   RandomWordsFulfilled receipt, coordinator success flag, or confirmed callback.
4. No public-chain commitment/pool/result reconciliation, finalization receipt,
   confirmations/reorg assessment, or real callback-gas and billing measurement.
5. No runtime/UI integration proving canonical task uniqueness, qualification
   evidence correctness, absence of cross-deployment rerolls, or guaranteed
   consumption of the selected advisory result.

These are explicit follow-up acceptance gaps, not evidence produced by this
local task. Any public-chain transaction requires separate authorization; this
work does not execute it. No new dependency is required from the parent agent.
