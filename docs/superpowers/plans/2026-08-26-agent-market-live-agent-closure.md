# Agent Market Live Agent Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the signed local-model and Queen GraphQL terminal-state loop with truthful, sanitized Evidence and a fresh Preview recording.

**Architecture:** Cloudflare Worker remains the public boundary and signs requests to the Local Runtime. The Runtime calls loopback Ollama or HTTPS providers, while LangGraph owns workflow state; Evidence is generated out-of-band after deterministic gates.

**Tech Stack:** TypeScript, Zod, Vitest, React, Cloudflare Workers, LangGraph, LangChain node adapters, Ollama, HMAC-SHA256, Chrome recording.

**Spec:** `docs/superpowers/specs/2026-08-26-agent-market-live-agent-closure/design.md`

## Global Constraints

- Never pull, delete, or expose Ollama models or port `11434`.
- Never publish keys, private paths, raw private prompts, model weights, or training data.
- Deterministic gates override all LLM judgments.
- No Mastra dependency and no Evidence DAG node.
- Production, AWS mutations, Sepolia transactions, and destructive actions remain action-time approval gates.

---

### Task 1: Freeze the closure contract

**Files:** `.tc-flow/{contract,state,change-manifest}.json`, `.tc-flow/events.jsonl`, this spec and plan.

- [x] Write the frozen Chinese requirements and design.
- [x] Reset only current TC Flow pointers while preserving append-only event history.
- [x] Validate the JSON contract files and mark T1 complete.

### Task 2: Verify exact local model identity

**Files:** `apps/local-agent-runner/src/model-registry.ts`, `apps/local-agent-runner/src/local-agent-runner.test.ts`, `apps/web/src/agentCatalog.ts`, `apps/web/src/agentCatalog.test.ts`.

- [x] Add failing assertions for exact tag, digest, ownership, context, license and capabilities.
- [x] Implement only proven registry/catalog gaps.
- [x] Run focused tests and record sanitized results.

### Task 3: Close signed Runtime smoke

**Files:** `apps/local-agent-runner/src/stream-runtime.ts`, `apps/local-agent-runner/src/stream-runtime.test.ts`, `apps/local-agent-runner/src/runtime-server.ts`, `docs/evidence/testing/2026-08-26-owner-trained-runtime-smoke.json`.

- [x] Gate owner scope, public rejection, replay, timeout and redacted logs.
- [x] Start Ollama only if needed and run one short signed smoke per installed model.
- [x] Stop temporary processes and save only sanitized Evidence.

### Task 4: Close Queen GraphQL terminal states

**Files:** `apps/local-agent-runner/src/queen-orchestrator.ts`, `apps/local-agent-runner/src/queen-orchestrator.test.ts`, `apps/local-agent-runner/src/stream-runtime.test.ts`, `apps/web/src/pages-worker.test.ts`.

- [x] Gate success, Provider failure, timeout, cancellation and idempotent retry.
- [x] Gate independent Execute, Judge and Final Arbiter identities and contexts.
- [x] Implement only missing transitions or cancellation propagation.

### Task 5: Align Local Agents UX

**Files:** `apps/web/src/pages/LocalAgentsPage.tsx`, `apps/web/src/pages/LocalAgentsPage.test.tsx`, `apps/web/src/i18n/translations.ts`.

- [x] Gate every terminal state, offline mode, cancellation and complete zh/en copy.
- [x] Implement the smallest UI/i18n correction.
- [x] Check 375, 390, 430, 1440, 1920 and root horizontal overflow.

### Task 6: Publish truthful local Evidence

**Files:** `apps/web/src/pages/EvidencePage.tsx`, `docs/evidence/testing/2026-08-26-queen-terminal-matrix.json`, `docs/evidence/testing/2026-08-26-live-agent-closure.json`.

- [x] Write terminal and smoke facts without raw prompts or secrets.
- [x] Upgrade pending-smoke only where current proof exists.
- [x] Run Evidence schema and public-content scans.

### Task 7: Record the post-gate workflow

**Files:** `apps/web/public/evidence/agent-market-v3-full-workflow.{mp4,png}`, `docs/evidence/testing/2026-08-26-external-chrome-full-workflow-recording.json`.

- [ ] Record wallet, Agent maintenance, task draft, DAG edit/start/terminal, committee, staking and Evidence.
- [ ] Do not send a chain transaction; keep pending boundaries visible.
- [ ] Verify media metadata and update the ledger.

### Task 8: Final gates and Preview delivery

**Files:** `.tc-flow/state.json`, `.tc-flow/events.jsonl`, `.github/workflows/verify.yml` only if a gate exposes a defect.

- [ ] Run focused tests, typecheck, build, repository policy and full `pnpm verify` after independent-review repair.
- [ ] Run secret/private-path/public-content and fresh bilingual local Preview route checks.
- [ ] Obtain independent review, repair P0/P1, create PR and Preview.
- [ ] Record `production-manual-pending`.
