# Agent Market Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a verifiable Sepolia Agent Market flow with wallet sessions, deterministic matching, gradient-boosted learning, recovery, read-only Ops, and complete Evidence.

**Architecture:** Preserve the V1 Cloudflare Edge SSR boundary and existing Solidity, Next.js, Go, Python, PostgreSQL, and AWS modules. Add stable adapters around wallet authentication, transaction intents and reconciliation, pgvector matching, model lifecycle, and recovery rather than moving business truth into the UI or Edge.

**Tech Stack:** React 19, Vite 7, Next.js 16, TypeScript, Solidity 0.8.28, Hardhat, ethers 6, Go, PostgreSQL/pgvector, Python 3.14, scikit-learn 1.8, AWS Lambda/SNS/SQS/DLQ/ECS, Cloudflare Workers, Blockscout.

**Spec:** `docs/superpowers/specs/2026-08-21-agent-market-phase2-design.md`

## Global Constraints

- Sepolia chain ID is exactly `11155111`.
- Gas is never reimbursed; unselected candidates submit no transaction.
- YD principal and the 6% bond settle only through explicit contract states.
- The Graph, Privy, paymasters, mainnet, and customer-managed KMS creation are outside this Contract.
- Production, paid AWS writes, Sepolia transaction submission, and destructive cleanup require action-time approval.
- Every new behavior follows test-first red-green-refactor.
- Concurrency is at most two and parallel workers must have disjoint write sets.

---

### Task 1: Shared contracts and PostgreSQL lifecycle

**Files:**
- Create: `database/migrations/0003_phase2_lifecycle.sql`
- Create: `packages/shared-contracts/src/auth.ts`
- Create: `packages/shared-contracts/src/transactions.ts`
- Modify: `packages/shared-contracts/src/events.ts`
- Modify: `packages/shared-contracts/src/index.ts`
- Test: `packages/shared-contracts/src/contracts.test.ts`
- Test: `apps/transaction-engine/src/persistence/schema.test.ts`

**Interfaces:**
- Produces `WalletChallengeV1`, `WalletSessionV1`, `TransactionIntentV1`, `TransactionVerificationV1`, `DlqReplayV1`, and versioned domain event envelopes.
- Produces tables for challenges, sessions, idempotency records, chain transactions, match candidates, feedback, model versions, and replay audits.

- [ ] Add failing schema and shared-contract tests for strict fields, expiry, chain ID, unique idempotency identity, event ID deduplication, and encrypted credential envelope columns.
- [ ] Run `pnpm --filter @agent-market/shared-contracts test` and `pnpm --filter @agent-market/transaction-engine test -- schema.test.ts`; confirm failures are caused by missing V2 types and migration.
- [ ] Implement the strict shared types and additive migration. Do not alter the verified performance tables.
- [ ] Re-run the two targeted suites and confirm they pass.

### Task 2: Contract deployment, request references, and gas policy

**Files:**
- Create: `packages/contracts/scripts/deploy-sepolia.ts`
- Create: `packages/contracts/src/deployment-manifest.ts`
- Create: `packages/contracts/test/DeploymentManifest.test.ts`
- Modify: `packages/contracts/hardhat.config.ts`
- Modify: `packages/contracts/contracts/AgentMarketEscrow.sol`
- Modify: `packages/contracts/test/SettlementFlow.test.ts`

**Interfaces:**
- Produces a sanitized deployment manifest containing chain ID, addresses, deploy transaction hashes, deployer address, and block numbers without keys or RPC URLs.
- `AgentMarketEscrow` events expose the approved `bytes32 requestRef` while preserving unique settlement and existing principal rules.

- [ ] Add failing tests for request reference propagation, no candidate-side transaction before selection, terminal-state uniqueness, and manifest validation.
- [ ] Run `pnpm --filter @agent-market/contracts test`; confirm the new assertions fail against the current ABI.
- [ ] Add request references and the deterministic deployment script with environment-only RPC/private-key inputs.
- [ ] Re-run contract tests and compile. Do not submit a Sepolia transaction in this task.

### Task 3: Wallet challenge and HttpOnly session

**Files:**
- Create: `apps/transaction-engine/src/auth/challenge.ts`
- Create: `apps/transaction-engine/src/auth/session.ts`
- Create: `apps/transaction-engine/src/auth/auth-store.ts`
- Create: `apps/transaction-engine/src/auth/challenge.test.ts`
- Create: `apps/transaction-engine/src/auth/session.test.ts`
- Create: `apps/transaction-engine/src/app/api/auth/challenge/route.ts`
- Create: `apps/transaction-engine/src/app/api/auth/verify/route.ts`
- Create: `apps/transaction-engine/src/app/api/auth/logout/route.ts`
- Modify: `apps/transaction-engine/package.json`

**Interfaces:**
- `issueChallenge(address, requestContext)` returns a canonical single-use Sepolia message.
- `verifyChallenge(message, signature)` returns an opaque session record only when the recovered signer and stored challenge match.
- Routes set and clear `agent_market_session` with `HttpOnly; Secure; SameSite=Lax; Path=/`.

- [ ] Write failing tests for success, nonce replay, expiry, domain mismatch, chain mismatch, wallet mismatch, cookie flags, logout, and recent-auth checks.
- [ ] Run the two auth tests and verify expected failures.
- [ ] Implement the smallest store-agnostic services and Next.js route adapters using ethers signature recovery.
- [ ] Re-run auth tests, transaction-engine typecheck, and build.

### Task 4: Transaction intents, receipt reconciliation, and Evidence projection

**Files:**
- Create: `apps/transaction-engine/src/chain/intents.ts`
- Create: `apps/transaction-engine/src/chain/reconcile.ts`
- Create: `apps/transaction-engine/src/chain/evidence.ts`
- Create: `apps/transaction-engine/src/chain/reconcile.test.ts`
- Create: `apps/transaction-engine/src/app/api/transactions/intents/route.ts`
- Create: `apps/transaction-engine/src/app/api/transactions/verify/route.ts`
- Create: `scripts/blockchain/readback-agent-market.mjs`
- Modify: `apps/transaction-engine/src/domain/tasks.ts`
- Modify: `apps/transaction-engine/src/domain/tasks.test.ts`

**Interfaces:**
- Produces unsigned transaction intents; the browser wallet remains the only signer.
- Reconciliation accepts an injected chain reader and returns `verifying`, `confirmed`, `failed`, or `reorged` with a sanitized Evidence projection.
- The Blockscout script reads environment-provided public addresses/hashes and writes only bounded JSON projections.

- [ ] Write failing tests for wrong chain, destination, sender, selector, request reference, amount, failed receipt, insufficient confirmations, idempotent confirmation, and reorg rollback.
- [ ] Run targeted transaction-engine tests and confirm expected failures.
- [ ] Implement intent and reconciliation services, API adapters, and task states `funding_pending`, `funded`, `disputed`, `settled`, and `refunded`.
- [ ] After Blockscout unlock and schema probing, implement the bounded readback script. Do not query or submit live chain data before the external-write gate.

### Task 5: Go pgvector matcher and deterministic exploration

**Files:**
- Create: `services/matcher-go/internal/store/postgres.go`
- Create: `services/matcher-go/internal/store/postgres_test.go`
- Create: `services/matcher-go/internal/handler/sqs.go`
- Create: `services/matcher-go/internal/handler/sqs_test.go`
- Modify: `services/matcher-go/internal/ranking/rank.go`
- Modify: `services/matcher-go/internal/ranking/rank_test.go`
- Modify: `services/matcher-go/cmd/matcher/main.go`
- Modify: `services/matcher-go/go.mod`

**Interfaces:**
- Repository query performs hard filters and pgvector recall before ranking.
- Ranking returns at most two top candidates plus one qualified newcomer, with a deterministic request-ID seed and per-component explanations.
- SQS handling deduplicates by event ID and writes one match result transactionally.

- [ ] Add failing ranking, SQL contract, duplicate-event, poison-message, and deterministic replay tests.
- [ ] Run `cd services/matcher-go && go test ./...`; confirm the new tests fail for missing adapters.
- [ ] Implement the PostgreSQL repository, SQS handler, and weighted ranking without bypassing hard filters.
- [ ] Run `go vet ./...` and `go test ./...`.

### Task 6: Gradient-boosted CTR model lifecycle

**Files:**
- Modify: `services/trainer/src/agent_market_trainer/contracts.py`
- Modify: `services/trainer/src/agent_market_trainer/train.py`
- Modify: `services/trainer/tests/test_train.py`
- Create: `services/trainer/src/agent_market_trainer/model_store.py`
- Create: `services/trainer/tests/test_model_store.py`

**Interfaces:**
- `train_model` uses `HistGradientBoostingClassifier` and emits ROC-AUC, log loss, constant-baseline log loss, model hash, algorithm parameters, and lifecycle status.
- A model is `approved` only when ROC-AUC is at least 0.60 and log loss beats baseline; activation remains a separate manual command.

- [ ] Replace the current algorithm assertions with failing gradient-boosting, metrics, baseline, rejection, deterministic-hash, and no-PII tests.
- [ ] Run `services/trainer/.venv/bin/pytest -q`; confirm failures reference the current logistic-regression artifact.
- [ ] Implement gradient boosting and model persistence with deterministic JSON serialization.
- [ ] Re-run the Python suite and build the trainer container locally without publishing it.

### Task 7: DLQ replay, read-only Ops, and AWS workload boundary

**Files:**
- Create: `apps/transaction-engine/src/recovery/replay.ts`
- Create: `apps/transaction-engine/src/recovery/replay.test.ts`
- Create: `apps/transaction-engine/src/ops/health.ts`
- Create: `apps/transaction-engine/src/ops/health.test.ts`
- Create: `apps/transaction-engine/src/app/api/ops/health/route.ts`
- Modify: `infra/aws/template.yaml`
- Modify: `infra/aws/template.test.mjs`
- Modify: `scripts/aws/pause-agent-market.sh`

**Interfaces:**
- Replay preserves original event, request, and idempotency identities and creates one recovery audit record.
- Ops returns redacted health only and exposes no mutation command.
- IaC remains workload-only, bounded-concurrency, short-retention, and pauseable.

- [ ] Add failing tests for one-result replay, read-only Ops, least-privilege IAM, no shared-foundation creation, bounded concurrency, and reversible pause coverage.
- [ ] Run targeted transaction-engine and IaC tests and confirm expected failures.
- [ ] Implement recovery/Ops and additive workload IaC without deploying it.
- [ ] Re-run targeted tests and generate a change-set preview only after AWS read-only login is restored.

### Task 8: Evidence, Actions runtime, and delivery gates

**Files:**
- Modify: `README.md`
- Modify: `docs/evidence/requirements.yaml`
- Modify: `apps/web/src/pages/EvidencePage.tsx`
- Modify: `apps/web/src/evidence/FullChainEvidence.tsx`
- Modify: `.github/workflows/verify.yml`
- Modify: `.github/workflows/project-delivery.yml`
- Create: `docs/architecture/adr/0001-defer-the-graph.md`
- Create: `docs/evidence/testing/2026-08-21-phase2-local-verification.json`

**Interfaces:**
- Evidence exposes only statuses supported by current tests or external readback.
- Actions use JavaScript action releases that run natively on Node 24 and retain repository policy gates.
- The ADR records why RPC plus Blockscout is sufficient for the assignment-critical path.

- [ ] Add failing Evidence validator assertions for V2 implementation/test/deployment/transaction fields and forbidden completion overclaims.
- [ ] Update Actions and documentation, keeping deployment and production statuses pending until external verification exists.
- [ ] Run task-level suites, full `pnpm verify`, repository policy audit, secret/PII scan, SSR route matrix, and sanitized diff review.
- [ ] Create a PR only after N4-N7 pass. Merge, Sepolia submission, AWS deployment, Cloudflare production deployment, and cleanup remain explicit user gates.
