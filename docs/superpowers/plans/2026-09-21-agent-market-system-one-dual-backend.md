# Agent Market System-One Dual-Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local Laya plus hosted Jev dual-shadow decision plane that records sanitized comparison evidence while the existing deterministic Agent Market workflow remains authoritative.

**Architecture:** Extract the current Jev result into a provider-neutral interface, implement Laya behind an injected lazy session loader, and compare both providers in a coordinator whose return value is always the deterministic baseline. The local runtime may preload a hash-pinned ONNX bundle only when `SYSTEM_ONE_SHADOW_MODE=dual-shadow`; off mode imports no model and requires no provider credentials.

**Tech Stack:** Node.js 22, TypeScript 7, Zod 4, Vitest 4, `@receptron/laya@0.1.1`, ONNX Runtime, native `crypto`/`fs`.

**Spec:** `docs/superpowers/specs/2026-09-21-agent-market-system-one-dual-backend/design.md`

## Global Constraints

- The deterministic host remains authoritative for eligibility, ranking, scores, disputes, shuffle, permissions, funds, wallets, contracts, and settlement.
- This phase supports only `off` and `dual-shadow`; it must not define `laya-primary` or `jev-primary`.
- Laya model revision is `68f27dfe5a27a54fb2b1fefc432f43f972e90868`; graph SHA-256 is `a874eb254b58b0fcb1e7ad56fbb188c29d64e08c9a46b689433e1f52c66dba1e`; data SHA-256 is `487746363a8da57bcadb4345352997d22a0fb90d70aa22c6856668d023242aba`.
- Laya weights remain outside Git and must never download during a task or startup.
- `TYPESAFE_API_KEY` remains server-side secret input and must never enter files, browser code, logs, fixtures, or Evidence.
- Provider inputs contain only opaque references, HMACs, bucketed state, reason codes, and host-permitted choices.
- No AWS, Cloudflare, database, chain, paid shared resource, Clash setting, or system proxy is created or changed.
- All implementation and verification run under Node `>=22 <23`; the repository lockfile changes only for the pinned Laya dependency.

## Review Focus

- Fractional `score` outputs such as `3.97` must remain fractional; validate their five-label distribution without pretending the score is a selected label.
- `off` mode must not import ONNX Runtime, stat model files, load 1.6 GiB of weights, or require a Jev key.
- A Laya choice outside the supplied candidate or route pool must fail closed exactly like Jev.
- Timeout does not cancel ONNX computation; late provider results must be ignored and never write Evidence twice.
- Dual-shadow provider disagreement or provider failure must preserve the deterministic baseline and emit only sanitized, bounded metadata.

---

### Task 1: Accept real fractional System-One scores

**Files:**
- Modify: `apps/local-agent-runner/src/jev-decision-adapter.test.ts`
- Modify: `apps/local-agent-runner/src/jev-decision-adapter.ts`

**Interfaces:**
- Consumes: live Jev `score` responses with an expected value in `[0, 4]` and probabilities keyed by `"0"` through `"4"`.
- Produces: an observed result whose `value` preserves the fractional expected score.

- [ ] **Step 1: Add a failing regression test for the observed live response shape**

Add a case using:

```ts
jevResponse({
  quality: {
    type: "score",
    score: 3.97,
    confidence: 0.98,
    probabilities: { "0": 0, "1": 0, "2": 0, "3": 0.02, "4": 0.98 },
    legend: { "0": "unusable", "1": "poor", "2": "mixed", "3": "good", "4": "excellent" },
  },
})
```

Assert that `scoreQuality(qualityDecision)` returns `status: "observed"` and `value: 3.97`. Add a second response whose probabilities sum to `0.7` and assert `invalid_response`.

- [ ] **Step 2: Run the targeted test and verify RED**

Run:

```bash
pnpm --filter @agent-market/local-agent-runner exec vitest run src/jev-decision-adapter.test.ts
```

Expected: the fractional-score test fails because `ScoreAnswerSchema` currently requires an integer.

- [ ] **Step 3: Split Choice and Score distribution validation**

Change the score schema to `z.number().min(0).max(4)`. Keep `hasValidChoiceDistribution(probabilities, allowedKeys, selectedKey)` for choice outputs. Add:

```ts
function hasValidScoreDistribution(probabilities: Record<string, number>): boolean {
  const expected = new Set(["0", "1", "2", "3", "4"]);
  const entries = Object.entries(probabilities);
  if (entries.length !== expected.size || entries.some(([key]) => !expected.has(key))) return false;
  return Math.abs(entries.reduce((sum, [, value]) => sum + value, 0) - 1) <= 0.01;
}
```

Do not round the returned score and do not require `String(score)` to be a probability key.

- [ ] **Step 4: Verify GREEN and the whole package**

Run the targeted test, then:

```bash
pnpm --filter @agent-market/local-agent-runner test
pnpm --filter @agent-market/local-agent-runner typecheck
```

Expected: all tests and typecheck pass under Node 22.

- [ ] **Step 5: Commit the regression fix**

```bash
git add apps/local-agent-runner/src/jev-decision-adapter.ts apps/local-agent-runner/src/jev-decision-adapter.test.ts
git commit -m "fix: accept fractional system-one scores"
```

### Task 2: Introduce the provider-neutral decision contract

**Files:**
- Create: `apps/local-agent-runner/src/system-one-decision-provider.ts`
- Create: `apps/local-agent-runner/src/system-one-decision-provider.test.ts`
- Modify: `apps/local-agent-runner/src/jev-decision-adapter.ts`
- Modify: `apps/local-agent-runner/src/jev-decision-adapter.test.ts`
- Modify: `apps/local-agent-runner/src/index.ts`

**Interfaces:**
- Consumes: the existing match, quality, dispute, threshold, and fallback contracts from `@agent-market/shared-contracts`.
- Produces: `SystemOneDecisionProvider`, `SystemOneDecisionResult`, and provider-neutral validation helpers used by both adapters and the coordinator.

- [ ] **Step 1: Write failing provider-contract tests**

Define the wished-for shape in the test:

```ts
const observed: SystemOneDecisionResult = {
  status: "observed",
  provider: "laya",
  decisionType: "agent_quality",
  decisionId: "quality_01",
  value: 3.183,
  confidence: 0.369,
  probabilities: { "0": 0.0247, "1": 0.0395, "2": 0.0272, "3": 0.5453, "4": 0.3633 },
  margin: 0.182,
  model: "laya@68f27dfe",
  usage: { inputTokens: 109 },
  latencyMs: 99,
};
```

Assert that `validateChoiceAnswer` rejects an out-of-pool key, `validateScoreAnswer` accepts the fractional expected score, and `probabilityMargin` returns the top-two difference.

- [ ] **Step 2: Verify RED because the module does not exist**

Run:

```bash
pnpm --filter @agent-market/local-agent-runner exec vitest run src/system-one-decision-provider.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the minimal provider-neutral module**

Export:

```ts
export type SystemOneProviderName = "laya" | "jev";
export type SystemOneDecisionResult =
  | { status: "fallback"; provider: SystemOneProviderName; decisionType: JevDecisionType; decisionId: string; reason: JevFallbackReason }
  | { status: "observed"; provider: SystemOneProviderName; decisionType: JevDecisionType; decisionId: string; value: string | number; confidence: number; probabilities: Record<string, number>; margin: number; model: string; usage: { inputTokens: number; outputTokens?: number }; latencyMs: number };

export type SystemOneDecisionProvider = {
  provider: SystemOneProviderName;
  match(decision: AgentMatchDecisionV1): Promise<SystemOneDecisionResult>;
  scoreQuality(decision: AgentQualityDecisionV1): Promise<SystemOneDecisionResult>;
  routeDispute(decision: DisputeRouteDecisionV1): Promise<SystemOneDecisionResult>;
  close?(): Promise<void>;
};
```

Move the shared probability functions into this module. They must be pure and must not know about HTTP or ONNX.

- [ ] **Step 4: Adapt Jev without changing its behavior**

Make `createJevDecisionAdapter` return `SystemOneDecisionProvider`; add `provider: "jev"` to observed and fallback results. Preserve the existing exported Jev aliases temporarily so target-worktree integration remains reviewable.

- [ ] **Step 5: Run provider and Jev tests, then package tests/typecheck**

Expected: all pass and no snapshots or fixtures contain credentials.

- [ ] **Step 6: Commit the contract extraction**

```bash
git add apps/local-agent-runner/src/system-one-decision-provider.ts apps/local-agent-runner/src/system-one-decision-provider.test.ts apps/local-agent-runner/src/jev-decision-adapter.ts apps/local-agent-runner/src/jev-decision-adapter.test.ts apps/local-agent-runner/src/index.ts
git commit -m "refactor: extract system-one provider contract"
```

### Task 3: Add the hash-pinned local Laya provider

**Files:**
- Modify: `apps/local-agent-runner/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `pnpm-workspace.yaml`
- Create: `apps/local-agent-runner/src/laya-decision-adapter.ts`
- Create: `apps/local-agent-runner/src/laya-decision-adapter.test.ts`
- Modify: `apps/local-agent-runner/src/index.ts`

**Interfaces:**
- Consumes: `SystemOneDecisionProvider`, a local model directory, pinned revision and hashes, policy, timeout, and an injected `loadSession` function.
- Produces: `createLayaDecisionAdapter(config)` with lazy `match`, `scoreQuality`, `routeDispute`, readiness, and close behavior.

- [ ] **Step 1: Add failing tests using a fake in-memory Laya session**

The fake session implements only:

```ts
type LayaSession = {
  systemOne(state: unknown, questions: Record<string, unknown>): Promise<{
    answers: Record<string, unknown>;
    usage?: { input_tokens?: number };
  }>;
  close(): Promise<void>;
};
```

Tests must prove:

- disabled mode calls neither `fs` nor `loadSession`;
- first enabled call verifies both model hashes and loads once;
- later calls reuse the same session;
- choice, fractional score, and dispute answers normalize correctly;
- low confidence, malformed distributions, out-of-pool choices, load failures, and timeouts fall back;
- `close()` closes only a loaded session and is idempotent.

- [ ] **Step 2: Verify RED because the Laya adapter does not exist**

Run the new test file and observe module-not-found.

- [ ] **Step 3: Add the pinned runtime dependency**

Add `"@receptron/laya": "0.1.1"` to local-agent-runner dependencies and `onnxruntime-node: true` to `allowBuilds` in `pnpm-workspace.yaml`. Run `pnpm install --lockfile-only` first and review that the lockfile adds only the Laya runtime tree.

- [ ] **Step 4: Implement lazy load and hash verification**

Use `createReadStream` plus `createHash("sha256")` for the two large files so startup never loads 1.6 GiB into memory. The default loader uses a dynamic import only after hashes pass:

```ts
const { Laya } = await import("@receptron/laya");
return Laya.load({ modelDir, executionProviders: ["cpu"] });
```

The adapter must never pass a repo, revision, token, or cache directory to `Laya.load`; that prevents runtime downloads.

- [ ] **Step 5: Implement provider methods from the same sanitized decision shapes**

Reuse the Jev question text and criteria. Validate output with the shared provider helpers and apply the same threshold policy. Represent the model as `laya@${revision}` and usage as `{ inputTokens }` when provided.

- [ ] **Step 6: Verify the adapter and dependency boundary**

Run local-agent-runner tests/typecheck, `pnpm install --offline --frozen-lockfile`, and a repository search proving no model binaries or local model paths are tracked.

- [ ] **Step 7: Commit the Laya provider**

```bash
git add apps/local-agent-runner/package.json pnpm-lock.yaml pnpm-workspace.yaml apps/local-agent-runner/src/laya-decision-adapter.ts apps/local-agent-runner/src/laya-decision-adapter.test.ts apps/local-agent-runner/src/index.ts
git commit -m "feat: add hash-pinned local Laya provider"
```

### Task 4: Parse fail-closed dual-shadow configuration

**Files:**
- Modify: `apps/local-agent-runner/src/config.ts`
- Modify: `apps/local-agent-runner/src/jev-decision-adapter.test.ts`
- Create: `apps/local-agent-runner/src/system-one-shadow-config.test.ts`
- Modify: `apps/local-agent-runner/src/index.ts`

**Interfaces:**
- Consumes: local runtime environment variables.
- Produces: `parseSystemOneShadowConfig(env): SystemOneShadowConfig` with an `off` discriminant or a complete `dual-shadow` configuration.

- [ ] **Step 1: Write failing configuration tests**

Pin these outcomes:

```ts
expect(parseSystemOneShadowConfig({})).toEqual({ mode: "off" });
```

For `dual-shadow`, require an absolute `LAYA_MODEL_DIR`, the exact pinned revision, integer `LAYA_TIMEOUT_MS` from 100–10,000, and a separately parsed optional Jev configuration. Reject unknown modes, relative paths, wrong revisions, and out-of-range timeouts.

- [ ] **Step 2: Verify RED, then implement the discriminated parser**

Off mode must return before reading or validating any Laya/Jev field. Do not read Keychain from application code.

- [ ] **Step 3: Run configuration, package tests, and typecheck**

- [ ] **Step 4: Commit configuration support**

```bash
git add apps/local-agent-runner/src/config.ts apps/local-agent-runner/src/jev-decision-adapter.test.ts apps/local-agent-runner/src/system-one-shadow-config.test.ts apps/local-agent-runner/src/index.ts
git commit -m "feat: add fail-closed system-one shadow config"
```

### Task 5: Compare both providers without changing deterministic decisions

**Files:**
- Create: `apps/local-agent-runner/src/system-one-shadow-coordinator.ts`
- Create: `apps/local-agent-runner/src/system-one-shadow-coordinator.test.ts`
- Modify: `apps/local-agent-runner/src/queen-orchestrator.ts`
- Modify: `apps/local-agent-runner/src/queen-orchestrator.test.ts`
- Modify: `apps/local-agent-runner/src/index.ts`

**Interfaces:**
- Consumes: deterministic baseline values, sanitized decision objects, zero to two providers, and an injected bounded Evidence sink.
- Produces: `observeMatch`, `observeQuality`, and `observeDispute`, each returning the supplied baseline unchanged after optional shadow observation.

- [ ] **Step 1: Write failing coordinator tests**

For each decision type, assert strict object identity or deep equality of the returned baseline. Cover provider agreement, disagreement, fallback, timeout, thrown error, late completion, and an Evidence sink that throws. The host result must remain unchanged in every case.

The Evidence record contains only:

```ts
{
  schemaVersion: 1,
  decisionType,
  decisionId,
  baselineResultHash,
  observations: [{ provider, status, model, resultHash, confidence, margin, latencyMs, fallbackReason }],
  agreement: "all" | "partial" | "none" | "insufficient",
}
```

No raw decision or baseline value is written.

- [ ] **Step 2: Verify RED, then implement bounded concurrent observation**

Use `Promise.allSettled` around provider calls already bounded by adapter timeouts. Hash normalized values with SHA-256. Call the sink once; swallow and expose sink failure only through an injected diagnostic callback. Never retry a provider.

- [ ] **Step 3: Add explicit Queen injection points**

Add an optional `systemOneShadow` to `QueenOrchestratorOptions`. Make the relevant internal handlers asynchronous, await the bounded shadow observation after the deterministic result is already fixed, and then return that unchanged result. After deterministic ranking, call `observeMatch` with opaque candidate references. After a Judge result is determined, call `observeQuality`/`observeDispute` without changing `recordScore`, graph edges, assignments, or GraphQL responses. Adapter timeouts cap the extra shadow latency; off mode adds no asynchronous work.

Tests must assert that the same candidate remains auto-selected, the same score event is written, and the same dispute branch is returned with shadow enabled or disabled.

- [ ] **Step 4: Run Queen tests, local-agent-runner tests, and typecheck**

- [ ] **Step 5: Commit zero-authority integration**

```bash
git add apps/local-agent-runner/src/system-one-shadow-coordinator.ts apps/local-agent-runner/src/system-one-shadow-coordinator.test.ts apps/local-agent-runner/src/queen-orchestrator.ts apps/local-agent-runner/src/queen-orchestrator.test.ts apps/local-agent-runner/src/index.ts
git commit -m "feat: observe system-one decisions without authority"
```

### Task 6: Wire local-runtime lifecycle and produce reproducible Evidence

**Files:**
- Modify: `apps/local-agent-runner/src/runtime-server.ts`
- Create: `apps/local-agent-runner/src/system-one-runtime.ts`
- Create: `apps/local-agent-runner/src/system-one-runtime.test.ts`
- Create: `apps/local-agent-runner/evaluation/system-one-dual-shadow-cases.json`
- Create: `apps/local-agent-runner/src/system-one-dual-shadow-evidence.test.ts`
- Create: `docs/evidence/testing/2026-09-21-system-one-dual-shadow-eval.json`

**Interfaces:**
- Consumes: parsed config, factories for Laya/Jev, existing synthetic decision cases, and an Evidence writer.
- Produces: an off-mode no-op or a closeable dual-shadow runtime plus a generated synthetic evaluation artifact.

- [ ] **Step 1: Write failing lifecycle tests**

Assert that off mode creates no providers. Dual-shadow creates Laya once, creates Jev only when explicitly enabled with a key, and closes loaded providers on both `SIGINT` and `SIGTERM` through one idempotent close path.

- [ ] **Step 2: Implement runtime composition**

Keep Keychain outside repository code: runtime receives `TYPESAFE_API_KEY` only from its environment. Log readiness using provider name and ready/fallback status only—never model paths, keys, raw inputs, or full outputs.

- [ ] **Step 3: Add frozen synthetic comparison cases**

Include at least: clear match, ambiguous match, fractional quality, malformed score distribution, high-risk dispute, out-of-pool choice, missing model, missing key, provider disagreement, and timeout. Fixtures use injected transports/sessions; the test makes zero real network requests.

- [ ] **Step 4: Generate Evidence from executed cases**

The test derives counts, agreement, fallback reasons, violations, and actual fake transport call counts from execution. It asserts `realTypeSafeRequests: 0`, `hardFilterViolations: 0`, `authorityMutations: 0`, and that the committed JSON equals the generated object.

- [ ] **Step 5: Run the full Node 22 gate**

Run:

```bash
pnpm --filter @agent-market/shared-contracts test
pnpm --filter @agent-market/local-agent-runner test
pnpm --filter @agent-market/shared-contracts typecheck
pnpm --filter @agent-market/local-agent-runner typecheck
node scripts/validate-repository.mjs
git diff --check
```

Also run an offline local smoke against the already hash-verified model bundle. Do not call Jev during the release gate; the earlier three-case API probe remains feasibility evidence, not a repeatable test.

- [ ] **Step 6: Commit runtime and Evidence**

```bash
git add apps/local-agent-runner/src/runtime-server.ts apps/local-agent-runner/src/system-one-runtime.ts apps/local-agent-runner/src/system-one-runtime.test.ts apps/local-agent-runner/evaluation/system-one-dual-shadow-cases.json apps/local-agent-runner/src/system-one-dual-shadow-evidence.test.ts docs/evidence/testing/2026-09-21-system-one-dual-shadow-eval.json
git commit -m "feat: wire local dual-shadow lifecycle"
```

### Task 7: Review, precise integration handoff, and local production activation

**Files:**
- Modify only if review requires it: files changed in Tasks 1–6.
- Do not modify: the dirty target worktree until its owner accepts a file-level integration sequence.

**Interfaces:**
- Consumes: the completed isolated branch, Node 22 verification output, and dirty target-worktree status.
- Produces: a reviewed commit series, exact integration order, kill-switch command, and truthful activation status.

- [ ] **Step 1: Review the branch against the design and authority boundary**

Reject any path where provider output changes ranking, score storage, dispute transitions, shuffle, permissions, funds, wallets, or chain state.

- [ ] **Step 2: Re-run the complete verification gate from a clean isolated worktree**

Record test counts, Node version, model revision/hashes, and `git status --short`. Do not call TypeSafe or expose the Keychain value.

- [ ] **Step 3: Produce a file-level integration sequence for the dirty owner worktree**

Because `packages/shared-contracts/src/index.ts`, Queen files, config, runtime, docs, and lockfile may overlap, do not merge the whole branch. Apply commits in task order, resolve each overlapping export or runtime composition deliberately, and rerun the affected tests after each commit.

- [ ] **Step 4: Activate only local `dual-shadow` after integration**

Launch the local runner with the pinned external model directory and `SYSTEM_ONE_SHADOW_MODE=dual-shadow`. Jev comparison stays disabled unless the sanitized remote-comparison gate is explicitly retained. Verify readiness, one synthetic local observation, and rollback by setting `SYSTEM_ONE_SHADOW_MODE=off` and restarting.

- [ ] **Step 5: Stop before cloud publication or authority promotion**

Do not deploy AWS/Cloudflare, push a production release, or grant provider authority in this plan. Those require the labeled evaluation and a separate production-release decision.
