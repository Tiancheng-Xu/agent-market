# Agent Market Phase 2 Design

> Status: approved by user delegation on 2026-08-21
> Scope: REQ-AM-01 through REQ-AM-15 closure beyond the verified V1 delivery
> Contract hash: `184ef819ebc06e6c9cf72625db93ac10da90fea9b8670d1d64c9f182d83c0e0c`

## 1. Goal

Turn the existing V1 presentation, local domain code, contracts, matcher, trainer, and AWS performance chain into a verifiable Sepolia marketplace flow. Every completion claim must bind implementation, automated tests, external readback, and Evidence.

## 2. Frozen decisions

1. Ethereum Sepolia remains the only chain, with `chainId = 11155111`.
2. Identity is MetaMask wallet-only. Login uses challenge-sign-verify and an HttpOnly session. Privy, Google login, smart wallets, and paymasters are out of scope.
3. Matching remains off-chain. Unselected Agents submit no transaction and therefore pay no application gas.
4. Ethereum gas is never refunded by Agent Market. Sent and reverted transactions consume gas according to Sepolia rules.
5. YD principal is not gas and is never silently burned. Principal, the 6% Agent bond, and simulated yield settle only through explicit contract terminal states.
6. The existing four non-upgradeable contracts remain the settlement boundary: `YDToken`, `AgentMarketEscrow`, `ArbitrationCommittee`, and `StakeYieldVault`.
7. A single UUIDv7 `request_id` spans HTTP, credential audit, PostgreSQL, outbox, SNS/SQS/DLQ, matching, training feedback, transaction intent, receipt verification, and Evidence. Only its `bytes32` hash is placed on-chain.
8. API credentials use AES-256-GCM envelopes. A compatible existing managed key or secret is reused after read-only inventory. Creating a customer-managed KMS key requires a separate cost approval.
9. The Graph is not required by the assignment and is not on the critical path. RPC receipt verification plus Blockscout transaction/event evidence is the selected V2 index/readback strategy.
10. AWS reuses the protected VPC, NAT, RDS, OIDC, and artifact foundation. No second VPC, NAT, RDS, ALB, or continuously running ECS service may be created.

## 3. Runtime architecture

```text
Browser + MetaMask
  -> Cloudflare Edge SSR and same-origin API proxy
  -> API Gateway
  -> Next.js transaction Lambda
  -> agent_market PostgreSQL schema + transactional outbox
  -> SNS -> SQS/DLQ
  -> Go matcher -> PostgreSQL + pgvector
  -> one-shot ECS gradient-boosted CTR trainer
  -> MetaMask-signed Sepolia contracts
  -> RPC receipt reconciliation + Blockscout evidence readback
  -> bilingual Evidence page
```

Cloudflare owns rendering, request boundaries, and browser telemetry. It does not own sessions, credentials, business state, or transaction truth. The transaction engine owns authentication, authorization, idempotency, task lifecycle, and receipt reconciliation. PostgreSQL owns chain-offline state and the outbox. Solidity owns token balances, escrow principal, bond, simulated yield, arbitration rulings, and unique settlement.

## 4. Wallet session contract

1. `POST /api/auth/challenge` accepts a checksummed Sepolia wallet address and returns a single-use nonce, issued time, expiry, domain, URI, chain ID, and statement.
2. The browser signs the canonical message with MetaMask.
3. `POST /api/auth/verify` recovers the signer, consumes the nonce once, creates a random opaque session ID, and returns only public wallet/session metadata.
4. The session ID is sent as `HttpOnly; Secure; SameSite=Lax; Path=/`; production expiry is 30 minutes with a 5-minute recent-auth window for credential rotation and transaction reconciliation commands.
5. State-changing API commands require session wallet ownership, `Idempotency-Key`, `X-Request-Id`, CSRF origin validation, and optimistic resource version.
6. Logout revokes the server-side session. Expired, replayed, wrong-domain, wrong-chain, and mismatched-wallet challenges fail closed.

## 5. Settlement and gas contract

1. A publisher creates and funds a task on-chain only after the off-chain draft has passed validation.
2. Candidate retrieval and ranking are off-chain. No candidate pays gas to be considered.
3. The selected Agent calls `acceptTask` and deposits the 6% YD bond. This is the first candidate-side transaction.
4. Successful delivery releases budget, bond, and funded simulated yield to the Agent.
5. Publisher-favoring timeout or arbitration returns the contract-defined principal to the publisher. This is principal settlement, not a gas refund.
6. Every on-chain caller pays their own Sepolia gas. The product never promises gas reimbursement.
7. A transaction is confirmed off-chain only when chain ID, destination, method, request reference, sender, amount, receipt status, event arguments, and confirmation depth all match the transaction intent.
8. RPC timeouts produce `verifying`, not `failed`. Reconciliation retries are idempotent and chain reorgs can move a transaction back to `verifying`.

## 6. Matching and learning

The Go matcher performs hard filtering before scoring: active status, category, required tags, endpoint health, budget compatibility, and minimum quality. pgvector supplies semantic recall. Rule scoring uses completion ability 30%, quality 25%, communication 15%, low dispute rate 15%, and completed scale 15%. The request ID seeds deterministic tie randomization. Results contain up to two top candidates and one qualified newcomer exploration candidate.

The current logistic regression trainer does not satisfy the gradient-boosting requirement. V2 uses scikit-learn `HistGradientBoostingClassifier`, emits ROC-AUC and log loss, compares against a constant baseline, and records `candidate`, `approved`, or `rejected`. Only an approved model can adjust ranking, and it cannot bypass hard filters.

## 7. Idempotency, DLQ, and recovery

1. Business writes and outbox records commit in one PostgreSQL transaction.
2. The idempotency identity is `(actor_wallet, command, resource_id, idempotency_key)`.
3. Consumers deduplicate by `event_id`; match results, feedback samples, and receipt reconciliations have database uniqueness constraints.
4. A poison message reaches the DLQ after bounded retries.
5. Replay copies the original event ID, request ID, and idempotency key. It may create one recovery audit event but cannot create a second business result.
6. Ops is read-only. It may explain queue, transaction, model, or performance state but cannot transfer funds, vote, deploy, merge, or mutate AWS resources.

## 8. AWS cost boundary

Local implementation and tests may proceed without AWS login. Before any deployment, run the AWS budget guard inventory. Reuse the current project stack where compatible. New workload resources are limited to the Next.js Lambda packaging path, matcher execution path, one-shot trainer task definition/run, bounded queues and roles, and short-retention logs. Deployment, testnet transaction submission, paid resource creation, and destructive cleanup remain explicit action-time gates.

## 9. Evidence contract

Evidence distinguishes `implemented`, `locally_verified`, `externally_verified`, `blocked`, and `planned`. Required external artifacts include deployment addresses, transaction hashes, receipt/event projections, Blockscout links, wallet roles, request ID correlation, database readback, queue/DLQ recovery, ECS task ARN and exit code, training metrics/model hash, AWS pause state, PR checks, Worker version, and public route readback. Screenshots are supporting evidence, never the sole proof.

## 10. Acceptance mapping

| V2 item | Acceptance |
| --- | --- |
| 1 | Four contracts deployed to Sepolia with verified normal and dispute transactions |
| 2 | Wallet challenge/session, authorization, credentials, and full task lifecycle are externally exercised |
| 3 | Transaction and event Evidence is linked by request ID and independently read back |
| 4 | Go matcher reads PostgreSQL/pgvector and emits deterministic explained candidates |
| 5 | One-shot ECS gradient-boosted trainer emits versioned metrics and model hash |
| 6 | Duplicate command and DLQ replay each produce one business result |
| 7 | ADR records The Graph as deferred because the assignment does not require it |
| 8 | Read-only Ops surfaces health, recovery, transaction, model, and cost boundaries |
| 9 | GitHub Actions no longer emits the Node 20 JavaScript action deprecation warning |

## 11. Non-goals

Mainnet money, real yield, cross-chain, DAO governance, upgradeable proxies, server-held user private keys, automatic arbitration, automatic production deployment, automatic paid-resource creation, and automatic model activation are excluded.
