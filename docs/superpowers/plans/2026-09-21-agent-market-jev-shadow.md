# Agent Market Jev Synthetic Foundation Plan

> **For agentic workers:** use `superpowers:executing-plans` and implement each
> task test-first.

**Goal:** Build strict Jev decision contracts and a disabled-by-default transport
adapter that supports synthetic agent matching, task-quality scoring, and AI-only
dispute routing without changing live Agent Market behavior.

**Base:** `30ffe80bd289cea1b3d55dfc08bd90e3bc05ebe1`

## Constraints

- No real Agent Market data or live TypeSafe calls.
- No authority over selection, reputation, permissions, funds, wallets, or chain state.
- Native `fetch`; no dependency or `pnpm-lock.yaml` changes.
- No commit, push, deployment, or enabling of shadow traffic.
- Shuffle/VRF and Go Matcher integration are explicit follow-on work.

### Task 1: Strict shared contracts

- [ ] Write failing tests for match, quality, dispute, threshold, and evidence schemas.
- [ ] Implement `packages/shared-contracts/src/jev-decisions.ts` with strict Zod schemas.
- [ ] Export the contracts from `packages/shared-contracts/src/index.ts`.
- [ ] Run package tests and typecheck.

### Task 2: Bounded Jev adapter

- [ ] Write failing tests for disabled, missing-key, observed match/quality/dispute,
      out-of-pool, uncalibrated, timeout, 401, 429, 5xx, and malformed responses.
- [ ] Implement `apps/local-agent-runner/src/jev-decision-adapter.ts` with injected
      transport, one bounded request, no retry, no logging, and deterministic fallback.
- [ ] Export the adapter and parse `JEV_SHADOW_ENABLED` as false by default.
- [ ] Run targeted tests and typecheck.

### Task 3: Synthetic evidence

- [ ] Add a synthetic-only evaluation fixture and evidence artifact covering the
      three decision types and fallback preservation.
- [ ] Execute every frozen case through an injected transport and derive the
      artifact metrics from the actual results.
- [ ] Verify no private paths, secrets, raw prompts, wallet identifiers, or outputs.
- [ ] Run package verification and diff review.
