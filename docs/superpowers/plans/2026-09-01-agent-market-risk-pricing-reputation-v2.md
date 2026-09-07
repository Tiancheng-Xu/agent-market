# Agent Market Risk Pricing and Reputation V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explainable Risk Assessor, deterministic symmetric-deposit quote engine, confidence-aware Reputation V2, authenticated quote APIs, and honest UI without deploying a new contract or claiming external verification.

**Architecture:** Shared contracts define strict inputs and versioned outputs. The local runner may extract structured risk factors, but the transaction engine alone computes rates and atomic amounts, persists immutable quotes, and gates funding on matching confirmations. Reputation remains an independent deterministic projection; UI consumes APIs and labels yield as simulation only.

**Tech Stack:** TypeScript, Zod, Vitest, PostgreSQL, Next Route Handlers, React, Vite, ReactFlow, BackstopJS, Cloudflare Pages.

**Spec:** `docs/superpowers/specs/2026-09-01-agent-market-risk-pricing-reputation-v2-design.md`

## Global Constraints

- L2 must not deploy or modify a Sepolia contract and must not send a replacement transaction for historical V3 evidence.
- `P` is task budget, `A` is the symmetric single-side refundable deposit, and `B` is the non-refundable service fee.
- Risk Assessor output never directly sets a rate and never overrides deterministic Gates.
- R5 uses 40% per side and cannot enter funding without manual approval.
- Unknown money state routes to `manual_review`; timeout is not failure and must not trigger a duplicate payment.
- Platform income from yield is simulation-only in L2; no real Yield Vault or guaranteed return copy.
- Platform must not profit directly from the direction of an arbitration decision.
- UI must preserve local/Cloudflare/AWS/Sepolia evidence boundaries.

---

### Task 1: Strict Risk Assessment and Quote Contracts

**Files:**
- Create: `packages/shared-contracts/src/risk-pricing.ts`
- Create: `packages/shared-contracts/src/risk-pricing.test.ts`
- Modify: `packages/shared-contracts/src/index.ts`

**Interfaces:**
- Produces: `RiskAssessmentInputSchema`, `RiskAssessmentSchema`, `RiskQuoteSchema`, `RiskFactorName`, `RiskQuote`, `RiskTier`.
- Consumers: Tasks 2, 3, 5, 6, and 7.

- [ ] **Step 1: Write failing schema tests**

```ts
it("rejects assessor-controlled rates and incomplete factors", () => {
  expect(RiskAssessmentSchema.safeParse({
    schemaVersion: "1", assessorAgentId: "risk-v1", depositRateBps: 4000, factors: [], requiredGates: [],
  }).success).toBe(false);
});

it("requires all eight unique factors", () => {
  const assessment = assessmentFixture();
  expect(RiskAssessmentSchema.parse(assessment).factors).toHaveLength(8);
});
```

- [ ] **Step 2: Run shared-contract tests and observe failure**

Run: `pnpm --dir packages/shared-contracts test -- risk-pricing.test.ts`

Expected: FAIL because `risk-pricing.ts` does not exist.

- [ ] **Step 3: Implement strict contracts**

```ts
export const RiskFactorNameSchema = z.enum([
  "complexity", "acceptanceAmbiguity", "externalDependency", "dataSensitivity",
  "financialRisk", "irreversibility", "deadlineRisk", "agentUncertainty",
]);

export const RiskAssessmentSchema = z.strictObject({
  schemaVersion: z.literal("1"),
  assessorAgentId: z.string().min(1).max(160),
  factors: z.array(z.strictObject({
    name: RiskFactorNameSchema,
    score: z.number().int().min(0).max(100),
    reasonCodes: z.array(z.string().regex(/^[A-Z0-9_]{3,80}$/u)).min(1).max(8),
  })).length(8),
  requiredGates: z.array(z.string().regex(/^[a-z0-9-]{3,80}$/u)).max(16),
  assessedAt: z.string().datetime(),
}).superRefine(rejectDuplicateFactorNames);
```

`RiskQuoteSchema` must include UUID quote/task IDs, `riskVersion`, rule version, score, tier, deposit rate, budget/deposit atomic strings, factors, gates, SHA-256 task fingerprint, timestamps, status, and `manualApprovalRequired`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --dir packages/shared-contracts test -- risk-pricing.test.ts && pnpm --dir packages/shared-contracts typecheck`

Expected: PASS with duplicate, missing, unknown, and assessor-controlled rate cases rejected.

- [ ] **Step 5: Commit Task 1 files**

```bash
git add packages/shared-contracts/src/risk-pricing.ts packages/shared-contracts/src/risk-pricing.test.ts packages/shared-contracts/src/index.ts
git commit -m "feat(risk): define strict assessment and quote contracts"
```

### Task 2: Deterministic Risk and Symmetric Deposit Engine

**Files:**
- Create: `apps/transaction-engine/src/application/risk-pricing-engine.ts`
- Create: `apps/transaction-engine/src/application/risk-pricing-engine.test.ts`

**Interfaces:**
- Consumes: `RiskAssessment`, `RiskQuote` from Task 1.
- Produces: `calculateRiskQuote(input): RiskQuote`, `allocateAgentDeposits(input): AgentDepositAllocation[]`.

- [ ] **Step 1: Write failing deterministic and conservation tests**

```ts
it("maps score 67 to R4 and symmetric 25 percent deposits", () => {
  const quote = calculateRiskQuote({ assessment: assessmentAtScore(67), budgetAtomic: "10000", ...fixedContext });
  expect(quote).toMatchObject({ tier: "R4", depositRateBps: 2500, publisherDepositAtomic: "2500", agentTeamDepositAtomic: "2500" });
});

it("allocates every atomic unit exactly once", () => {
  const allocations = allocateAgentDeposits({ totalAtomic: "101", nodes: weightedNodes() });
  expect(allocations.reduce((sum, item) => sum + BigInt(item.depositAtomic), 0n)).toBe(101n);
});
```

- [ ] **Step 2: Run the focused test and observe failure**

Run: `pnpm --dir apps/transaction-engine test -- risk-pricing-engine.test.ts`

Expected: FAIL because the engine functions are undefined.

- [ ] **Step 3: Implement weighted integer arithmetic**

```ts
const weights = { complexity: 20, acceptanceAmbiguity: 15, externalDependency: 10, dataSensitivity: 15, financialRisk: 15, irreversibility: 10, deadlineRisk: 5, agentUncertainty: 10 } as const;

export function scoreAssessment(assessment: RiskAssessment): number {
  return Math.round(assessment.factors.reduce((sum, factor) => sum + factor.score * weights[factor.name], 0) / 100);
}
```

Use `BigInt` for all atomic amounts. Allocate floors first, then assign residual atomic units by descending exact weight and ascending Agent ID. Hash canonical JSON containing task, budget, permissions, DAG revision, and assignments. Never hash timestamps.

- [ ] **Step 4: Verify all tier boundaries and rerun behavior**

Run: `pnpm --dir apps/transaction-engine test -- risk-pricing-engine.test.ts && pnpm --dir apps/transaction-engine typecheck`

Expected: PASS for scores 20/21/40/41/60/61/80/81, deterministic hashing, zero/negative budget rejection, and allocation conservation.

- [ ] **Step 5: Commit Task 2 files**

```bash
git add apps/transaction-engine/src/application/risk-pricing-engine.ts apps/transaction-engine/src/application/risk-pricing-engine.test.ts
git commit -m "feat(risk): calculate deterministic symmetric deposits"
```

### Task 3: Risk Assessor Runtime Role

**Files:**
- Create: `apps/local-agent-runner/src/risk-assessor.ts`
- Create: `apps/local-agent-runner/src/risk-assessor.test.ts`
- Modify: `apps/local-agent-runner/src/queen-orchestrator.ts`

**Interfaces:**
- Consumes: `RiskAssessmentInputSchema` from Task 1.
- Produces: `assessTaskRisk(input, executeAgentText): Promise<RiskAssessment>` and execution role `risk_assessor`.
- Does not produce a rate, tier, deposit amount, transaction, or settlement decision.

- [ ] **Step 1: Write failing role-boundary tests**

```ts
it("returns all eight factors but no monetary fields", async () => {
  const result = await assessTaskRisk(inputFixture(), deterministicAssessor);
  expect(result.factors).toHaveLength(8);
  expect(result).not.toHaveProperty("depositRateBps");
  expect(result).not.toHaveProperty("budgetAtomic");
});

it("fails closed on malformed model JSON", async () => {
  await expect(assessTaskRisk(inputFixture(), async () => "not-json")).rejects.toThrow("RISK_ASSESSMENT_INVALID");
});
```

- [ ] **Step 2: Run local-runner tests and observe failure**

Run: `pnpm --dir apps/local-agent-runner test -- risk-assessor.test.ts`

- [ ] **Step 3: Implement the role and conservative fallback**

The model receives only title, description, requirements, declared permissions, duration, and dependency classes. Parse strict JSON with Task 1 schemas. If the model is unavailable, use a deterministic keyword/permission fallback that can only preserve or increase risk; never silently return R1.

Add `risk_assessor` to the runner's bounded execution-role union, but keep assessment outside `TaskGraph`. The assessment must complete before Queen proposes or confirms the task graph; the UI renders it as a separate preflight lane rather than an execution node.

- [ ] **Step 4: Verify independence and no secret leakage**

Run: `pnpm --dir apps/local-agent-runner test && pnpm --dir apps/local-agent-runner typecheck`

Expected: existing Queen/Judge/Red Team/Repair/Final Arbiter tests remain green; prompts contain no wallet secret, provider key, local path, or raw private artifact.

- [ ] **Step 5: Commit Task 3 files**

```bash
git add apps/local-agent-runner/src/risk-assessor.ts apps/local-agent-runner/src/risk-assessor.test.ts apps/local-agent-runner/src/queen-orchestrator.ts
git commit -m "feat(runtime): add bounded risk assessor role"
```

### Task 3B: Auditable Cold-Start Exploration

**Files:**
- Modify: `services/matcher-go/internal/ranking/rank.go`
- Modify/Create: focused tests under `services/matcher-go/internal/ranking/`

**Interfaces:**
- Keeps hard eligibility filters authoritative.
- Produces two history-ranked seats plus one eligible cold-start exploration seat by default.
- Produces sanitized audit metadata and explicit business outcome codes.

- [ ] **Step 1: Add failing reproducibility and fallback tests**

Require the same `taskId + matchingRound + policyVersion` to produce the same cold-start order, a changed round to produce a different seed, no cold-start candidate to fall back to history, and high-risk mode to disable the exploration seat.

- [ ] **Step 2: Implement seeded Fisher-Yates exploration**

Use a hash-derived local PRNG rather than global randomness. Preserve `modelTag` diversity and never allow exploration to bypass hard filters.

- [ ] **Step 3: Add auditable outcomes**

Distinguish `NO_ELIGIBLE_AGENT`, `MANUAL_REVIEW_REQUIRED`, and `MATCHING_ERROR`. Record only policy version, bounded candidate counts, selected public IDs, selection reasons, and a seed hash.

- [ ] **Step 4: Run focused Go tests**

Run: `go test ./internal/ranking/...`

Expected: deterministic selection, conservation of three seats when possible, diversity, fallback, and outcome-code tests pass.

### Task 4: Reputation V2 Projection and Anti-Abuse Gates

**Files:**
- Modify: `packages/shared-contracts/src/reputation.ts`
- Modify: `packages/shared-contracts/src/reputation.test.ts`
- Modify: `apps/transaction-engine/src/application/reputation-service.ts`
- Modify: `apps/transaction-engine/src/application/reputation-service.test.ts`

**Interfaces:**
- Produces: `ReputationV2Snapshot`, `calculateReputationV2(events)`, and five dimension scores with sample count/confidence.
- Consumers: Tasks 2, 5, and 7.

- [ ] **Step 1: Add failing formula and abuse tests**

```ts
it("shrinks a single perfect review toward the 30 point prior", () => {
  const result = calculateReputationV2([perfectAcceptedOrder()]);
  expect(result.score).toBeGreaterThan(30);
  expect(result.score).toBeLessThan(50);
  expect(result.confidence).toBe("low");
});

it("does not punish an agent who wins a dispute", () => {
  expect(calculateReputationV2([agentWonDispute()]).dimensions.disputeOutcome).toBe(100);
});
```

- [ ] **Step 2: Run shared and engine tests and observe failure**

Run: `pnpm --dir packages/shared-contracts test -- reputation.test.ts && pnpm --dir apps/transaction-engine test -- reputation-service.test.ts`

- [ ] **Step 3: Implement the five dimensions**

Apply 35/25/10/15/15 weights. Preserve the 90-day window, latest 20 events, and 30-day half-life. Use `confidence = n / (n + 10)` and `final = 30 + confidence * (raw - 30)`. Experience uses capped logarithmic scaling; dispute score considers only final attributed fault.

Retain existing eligibility gates: accepted order, publisher actor, one review per order, no self-review, no linked-wallet review.

- [ ] **Step 4: Run package tests and typechecks**

Run: `pnpm --dir packages/shared-contracts test && pnpm --dir packages/shared-contracts typecheck && pnpm --dir apps/transaction-engine test && pnpm --dir apps/transaction-engine typecheck`

- [ ] **Step 5: Commit Task 4 files**

```bash
git add packages/shared-contracts/src/reputation.ts packages/shared-contracts/src/reputation.test.ts apps/transaction-engine/src/application/reputation-service.ts apps/transaction-engine/src/application/reputation-service.test.ts
git commit -m "feat(reputation): add confidence-aware five-dimension scoring"
```

### Task 5: Quote Ledger, Confirmations, and Funding Gate

**Files:**
- Create: `database/migrations/0015_l2_risk_pricing.sql`
- Create: `apps/transaction-engine/src/application/risk-quote-store.ts`
- Create: `apps/transaction-engine/src/application/risk-quote-store.test.ts`
- Modify: `packages/shared-contracts/src/orders.ts`
- Modify: `packages/shared-contracts/src/orders.test.ts`
- Modify: `apps/transaction-engine/src/application/order-service.ts`

**Interfaces:**
- Produces: `RiskQuoteStore.create`, `findCurrent`, `confirm`, `supersede`, `requireFundingReady`.
- Extends order snapshot with quote ID/version/tier/rate and command `attach_risk_quote`.

- [ ] **Step 1: Write failing quote-ledger tests**

```ts
it("requires the publisher and every assigned agent to confirm the same final quote", async () => {
  await store.confirm(quoteId, publisherWallet, "publisher");
  await expect(store.requireFundingReady(taskId)).rejects.toThrow("RISK_QUOTE_AGENT_CONFIRMATION_REQUIRED");
  await store.confirm(quoteId, agentWalletA, "agent");
  await store.confirm(quoteId, agentWalletB, "agent");
  await expect(store.requireFundingReady(taskId)).resolves.toMatchObject({ status: "confirmed" });
});
```

- [ ] **Step 2: Run engine test and observe failure**

Run: `pnpm --dir apps/transaction-engine test -- risk-quote-store.test.ts`

- [ ] **Step 3: Add migration and transactional store**

Create `risk_quotes`, `risk_quote_agent_allocations`, and `risk_quote_confirmations`. Quotes are immutable and explicitly phased as `preliminary` or `final`; changed task fingerprint, DAG revision, assignment, or pricing policy inserts a new version and marks the previous quote `superseded`. Unique keys prevent duplicate confirmations. A preliminary quote requires publisher acknowledgement before matching; only a final quote may collect publisher plus every unique assigned Agent confirmation and become funding-ready.

Update `mark_funding_pending` so it requires an attached, confirmed, unexpired quote. R5 additionally requires `manualApprovedAt` and `manualApprovedBy` from the platform review boundary.

- [ ] **Step 4: Run migration-backed integration tests when `TEST_DATABASE_URL` exists**

Run: `pnpm --dir apps/transaction-engine test -- risk-quote-store.test.ts && pnpm --dir apps/transaction-engine typecheck`

Expected: unit tests always pass; database integration cases skip only when the configured test database is absent.

- [ ] **Step 5: Commit Task 5 files**

```bash
git add database/migrations/0015_l2_risk_pricing.sql apps/transaction-engine/src/application/risk-quote-store.ts apps/transaction-engine/src/application/risk-quote-store.test.ts packages/shared-contracts/src/orders.ts packages/shared-contracts/src/orders.test.ts apps/transaction-engine/src/application/order-service.ts
git commit -m "feat(orders): gate funding on confirmed risk quotes"
```

### Task 6: Authenticated Quote and Reputation APIs

**Files:**
- Create: `apps/transaction-engine/src/application/risk-pricing-service.ts`
- Create: `apps/transaction-engine/src/application/risk-pricing-service.test.ts`
- Create: `apps/transaction-engine/src/app/api/tasks/[taskId]/risk-quote/route.ts`
- Create: `apps/transaction-engine/src/app/api/tasks/[taskId]/risk-quote/confirm/route.ts`
- Create: `apps/transaction-engine/src/app/api/agents/[agentId]/reputation/route.ts`
- Modify: `apps/transaction-engine/src/application/order-runtime.ts`

**Interfaces:**
- POST quote consumes only task identity and an expected server-owned task fingerprint. The service reads authoritative task/DAG/assignment data and calls the bounded Risk Assessor internally; the client cannot submit assessment factors, rate, amount, or tier.
- POST confirmation consumes quote ID and expected fingerprint; actor role is derived from authenticated wallet.
- GET reputation returns public dimensions without wallet addresses or private events.

- [ ] **Step 1: Write handler tests for origin, session, role, and injected monetary fields**

```ts
it("rejects a browser supplied deposit rate", async () => {
  const response = await handler(request({ assessment: validAssessment(), depositRateBps: 1 }), taskId);
  expect(response.status).toBe(400);
});

it("does not expose raw wallet-linked reputation events", async () => {
  const body = await reputationHandler(agentId).then((response) => response.json());
  expect(JSON.stringify(body)).not.toContain("walletAddress");
});
```

- [ ] **Step 2: Run focused API tests and observe failure**

Run: `pnpm --dir apps/transaction-engine test -- risk-pricing-service.test.ts`

- [ ] **Step 3: Implement services and Route Handlers**

Follow existing `Request`/`Response` handler factories. Require same-origin POST, secure session cookie, UUID request ID, no-store response, and sanitized reason codes. Map invalid input to 400, forbidden actor to 403, missing task/agent to 404, superseded/version conflicts to 409, and unavailable stores to 503.

- [ ] **Step 4: Run all transaction-engine gates**

Run: `pnpm --dir apps/transaction-engine test && pnpm --dir apps/transaction-engine typecheck && pnpm --dir apps/transaction-engine build`

- [ ] **Step 5: Commit Task 6 files**

```bash
git add apps/transaction-engine/src/application/risk-pricing-service.ts apps/transaction-engine/src/application/risk-pricing-service.test.ts apps/transaction-engine/src/app/api/tasks apps/transaction-engine/src/app/api/agents apps/transaction-engine/src/application/order-runtime.ts
git commit -m "feat(api): expose authenticated risk quotes and public reputation"
```

### Task 7: Quote, Reputation, and Preflight UI

**Files:**
- Create: `apps/web/src/lib/riskPricingClient.ts`
- Create: `apps/web/src/components/RiskQuotePanel.tsx`
- Create: `apps/web/src/components/ReputationV2Panel.tsx`
- Create: `apps/web/src/components/risk-pricing.css`
- Create: `apps/web/src/riskPricingPresentation.test.ts`
- Modify: `apps/web/src/pages/DirectoryPages.tsx`
- Modify: `apps/web/src/pages/OrderDetailPage.tsx`
- Modify: `apps/web/src/pages/LocalAgentsPage.tsx`
- Modify: `apps/web/src/i18n/supplementalTranslations.ts`

**Interfaces:**
- `RiskQuotePanel` consumes `RiskQuote` and emits `onConfirm(quoteId, fingerprint)`.
- `ReputationV2Panel` consumes only public `ReputationV2Snapshot`.
- Task publishing cannot proceed to wallet intent until quote readiness is confirmed.

- [ ] **Step 1: Write presentation tests**

```ts
it("shows R5 as manual-review required and never as ready", () => {
  expect(quotePresentation(r5Quote({ manualApprovedAt: null })).fundingReady).toBe(false);
});

it("labels yield as simulation only", () => {
  expect(quotePresentation(r4Quote()).yieldLabel).toBe("SIMULATION_ONLY");
});
```

- [ ] **Step 2: Run web tests and observe failure**

Run: `pnpm --dir apps/web test -- riskPricingPresentation.test.ts`

- [ ] **Step 3: Build the UI from existing design tokens**

Task publishing sequence becomes `draft -> preliminary risk quote -> publisher acknowledgement -> Queen/matching -> final quote -> publisher and every assigned Agent confirmation -> wallet/intent -> receipt`. Display all eight factors, reason codes, rate, `P/A/B`, both side deposits, Agent allocations, quote expiry, and re-quote causes. The Agent card displays five dimensions, `n`, confidence, window, and update time. Add Risk Assessor as a preflight lane before the Queen DAG rather than pretending it is an execution node.

- [ ] **Step 4: Verify web behavior and SSR build**

Run: `pnpm --dir apps/web test && pnpm --dir apps/web typecheck && pnpm --dir apps/web build`

Expected: fixture pages say simulation/local; UUID pages read authenticated APIs; no wallet transaction is sent by tests.

- [ ] **Step 5: Commit Task 7 files**

```bash
git add apps/web/src/lib/riskPricingClient.ts apps/web/src/components/RiskQuotePanel.tsx apps/web/src/components/ReputationV2Panel.tsx apps/web/src/components/risk-pricing.css apps/web/src/riskPricingPresentation.test.ts apps/web/src/pages/DirectoryPages.tsx apps/web/src/pages/OrderDetailPage.tsx apps/web/src/pages/LocalAgentsPage.tsx apps/web/src/i18n/supplementalTranslations.ts
git commit -m "feat(web): explain dynamic deposits and reputation confidence"
```

### Task 8: Repository, Visual, Evidence, and Independent Review Gates

**Files:**
- Modify: `README.md`
- Create: `backstop.json`
- Modify: `package.json`
- Modify: `scripts/visual-route-audit.mjs`
- Create: `docs/evidence/testing/2026-09-01-risk-pricing-reputation-local-gates.json`
- Create: `apps/web/public/evidence/2026-09-01-risk-pricing-reputation-local-gates.json`
- Modify: `docs/evidence/requirements.yaml`
- Modify: `apps/web/src/pages/EvidencePage.tsx`
- Modify: `scripts/validate-evidence.mjs`
- Modify: `scripts/validate-evidence.test.mjs`

**Interfaces:**
- Produces deterministic local Evidence only; it must not claim new AWS, Sepolia, production runtime, or guaranteed yield evidence.

- [ ] **Step 1: Add failing Evidence validation tests**

Require schema version, build SHA, exact commands, test totals, covered routes, 375/390/430/1440 viewports, zero overflow/pageerror, and boundary flags `yieldImplemented=false`, `contractDeployed=false`, `externalVerification=false`.

- [ ] **Step 2: Add BackstopJS and stable scenarios**

Add root dev dependency `backstopjs` and scripts:

```json
{
  "visual:reference": "backstop reference --config=backstop.json",
  "visual:test": "backstop test --config=backstop.json"
}
```

Cover `/tasks/new`, one fixture task, one manual-review fixture, `/agents/:id`, `/agents/local`, and `/evidence` at 375, 390, 430, and 1440. Disable animations and freeze fixture time. Do not mask product content.

- [ ] **Step 3: Run deterministic and visual Gates**

Run:

```bash
pnpm verify
pnpm visual:reference
pnpm visual:test
node scripts/visual-route-audit.mjs
```

Expected: all deterministic gates pass; candidate diffs are reviewed rather than blindly accepted; zero root overflow and `pageerror`.

- [ ] **Step 4: Request independent review**

Review requirements: domain correctness, platform/arbitration incentive conflict, quote replay/versioning, BigInt conservation, API authorization, public-content privacy, evidence honesty, and responsive accessibility. Critical and Important findings must be zero before release.

- [ ] **Step 5: Write local Evidence and run final verification**

Run: `pnpm verify`

Record only commands actually executed and exact totals. Keep new feature status `verified-local` until a later, separately authorized external deployment and readback.

- [ ] **Step 6: Commit Task 8 files**

```bash
git add backstop.json package.json pnpm-lock.yaml scripts/visual-route-audit.mjs docs/evidence apps/web/public/evidence apps/web/src/pages/EvidencePage.tsx scripts/validate-evidence.mjs scripts/validate-evidence.test.mjs
git commit -m "test(evidence): gate risk pricing and reputation delivery"
```

## Release Boundary

After Tasks 1-8 pass, use `superpowers:finishing-a-development-branch` and `publish-baby2b-project`. Create a PR, wait for Repository Policy, Verify, and Cloudflare Preview, review Preview semantics, then merge only with explicit production authorization already present in the parent task. Do not trigger AWS or send Sepolia transactions for this L2 feature. Production Evidence must continue to label the new pricing/yield capability as local-only until independently deployed and read back.
