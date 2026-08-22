# Agent Market Local Ollama Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `personal-ai-agent-runtime:v4.1` 自动接入为 Agent Market 默认 owner-trained 本地 Agent，接入 DeepSeek/Kimi/Qwen/Zhipu provider API，并按 C 方案交付可复用线上真实 Agent 对话模块。

**Architecture:** 异步控制面维护注册、heartbeat、lease 与结果；本机 runner 主动出站轮询。同步聊天数据面使用 Cloudflare Worker + Tunnel + Local Stream Runtime，Runtime 才能访问 `127.0.0.1:11434` 和 provider API。生产发布仍为 `manual-pending`。

**Tech Stack:** TypeScript 7、Node.js 22、Zod 4、Vitest 4、React 19、Vite 7、Cloudflare Edge SSR、Ollama HTTP API。

**Spec:** `docs/superpowers/specs/2026-08-22-agent-market-local-ollama-agent/design.md`

## Global Constraints

- Ollama origin 必须严格为 `http://127.0.0.1:11434`。
- 默认模型固定为 `personal-ai-agent-runtime:v4.1`，启动时核对 digest。
- 不 pull、不删除模型；embedding-only 模型不得注册为聊天 Agent。
- 浏览器、公开 Evidence 和 Git 仓库不得包含凭据、完整 prompt、私有路径或模型权重。
- Worker 到 Runtime 必须签名；Tunnel 不是授权边界。
- DeepSeek/Kimi/Qwen/Zhipu 必须标记为 `third-party/provider-api`，不得写成自训练或本地权重。
- 不修改或启动 AWS；只允许 PR/Preview；生产 `manual-pending`。

---

### Task 1: Shared Local Agent Contracts

**Files:**
- Create: `packages/shared-contracts/src/local-agent.ts`
- Modify: `packages/shared-contracts/src/index.ts`
- Test: `packages/shared-contracts/src/local-agent.test.ts`

**Interfaces:**
- Produces: `AgentManifestSchema`, `AgentTaskLeaseSchema`, `AgentTaskResultSchema`, `SignedRequestHeadersSchema` and inferred types.
- Consumes: no runtime network or secrets.

- [ ] Write failing schema tests for owner-trained identity, third-party metadata, digest, payload limits and embedding exclusion.
- [ ] Run `pnpm --filter @agent-market/shared-contracts test` and confirm the new exports are missing.
- [ ] Implement strict Zod schemas and canonical constants.
- [ ] Run shared-contract tests and typecheck.
- [ ] Record N4 review and T1 checkpoint without committing.

### Task 2: Ollama Discovery and Adapter

**Files:**
- Create: `apps/local-agent-runner/package.json`
- Create: `apps/local-agent-runner/tsconfig.json`
- Create: `apps/local-agent-runner/src/config.ts`
- Create: `apps/local-agent-runner/src/ollama-client.ts`
- Create: `apps/local-agent-runner/src/model-registry.ts`
- Test: `apps/local-agent-runner/src/ollama-client.test.ts`
- Test: `apps/local-agent-runner/src/model-registry.test.ts`

**Interfaces:**
- Produces: `loadRunnerConfig(env)`, `OllamaClient`, `discoverAgentManifests(client, allowlist)`.
- Consumes: shared Agent Manifest schemas.

- [ ] Write tests rejecting non-loopback origins and filtering embedding models.
- [ ] Write mock `/api/tags`, `/api/show`, `/api/chat` tests for discovery, digest binding, timeout and cancellation.
- [ ] Implement minimal fetch client and metadata mapper.
- [ ] Verify no test pulls or deletes models and logs do not contain prompt bodies.
- [ ] Run runner unit tests and typecheck, then record T2 review/checkpoint.

### Task 3: Signed Control Plane and Runner Lifecycle

**Files:**
- Create: `apps/local-agent-runner/src/signing.ts`
- Create: `apps/local-agent-runner/src/control-plane-client.ts`
- Create: `apps/local-agent-runner/src/runner.ts`
- Create: `apps/local-agent-runner/src/cli.ts`
- Test: `apps/local-agent-runner/src/signing.test.ts`
- Test: `apps/local-agent-runner/src/runner.integration.test.ts`

**Interfaces:**
- Produces: `signBody`, `verifySignedBody`, `ReplayGuard`, `ControlPlaneClient`, `LocalAgentRunner`.
- Consumes: discovered manifests and `OllamaClient.chat()`.

- [ ] Write HMAC tests for valid signature, stale timestamp, replayed nonce, modified body and unknown key.
- [ ] Write integration test for register→heartbeat→lease→chat→result→offline plus duplicate lease idempotency.
- [ ] Implement bounded polling, max concurrency 2, 120-second default timeout, AbortSignal and graceful stop.
- [ ] Verify structured logs contain IDs/stages only.
- [ ] Run integration/type tests and record T3 review/checkpoint.

### Task 4: Agent Market Local Agent UI

**Files:**
- Create: `apps/web/src/local-agents/catalog.ts`
- Create: `apps/web/src/pages/LocalAgentsPage.tsx`
- Create: `apps/web/src/pages/LocalAgentsPage.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/data.ts`
- Modify: `apps/web/src/ssr/routeDefinitions.ts`
- Modify: `apps/web/src/i18n/translations.ts`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: `/agents/local` route and static verified-local catalog snapshot.
- Consumes: public-safe manifest fields only; never consumes Ollama URL or signing credentials.

- [ ] Write failing route/UI tests for default owner-trained model, digest, offline/pending-cloud labels and third-party attribution.
- [ ] Implement page and navigation with one responsive component tree.
- [ ] Add complete Chinese translations and route-aware SSR summary.
- [ ] Assert the browser bundle contains no `11434`, key material or private paths.
- [ ] Run Web tests/typecheck/build and record T4 review/checkpoint.

### Task 4b: Live Chat Data Plane and Mastra-style Playground

**Files:**
- Create: `packages/shared-contracts/src/live-chat.ts`
- Create: `apps/local-agent-runner/src/stream-runtime.ts`
- Modify: `apps/local-agent-runner/src/ollama-client.ts`
- Modify: `apps/web/src/pages-worker.ts`
- Create: `apps/web/src/pages/LocalAgentsPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/data.ts`
- Modify: `apps/web/src/ssr/routeDefinitions.ts`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: reusable Chat Request, SSE Event, Health and Error contracts; Worker gateway; local runtime handler; Mastra-style live chat UI.
- Consumes: Agent manifests, provider clients, Ollama loopback client and Worker runtime secrets.

- [x] Freeze public-safe chat request, SSE event, health and error schemas.
- [x] Add Local Stream Runtime with Worker request signature verification.
- [x] Add Ollama streaming adapter and provider API chat path.
- [x] Add Worker `/agent/chat` and `/agent/healthz` with CORS, body limit, optional Turnstile, runtime signing and SSE passthrough.
- [x] Add `/agents/local` playground with owner-trained local model, DeepSeek and Kimi provider selection.
- [x] Run shared, runner, Web tests and typecheck.

### Task 5: Architecture, Evidence and Real Smoke

**Files:**
- Create: `docs/architecture/agent-market-local-agent-architecture.mmd`
- Create: `docs/architecture/agent-market-local-agent-sequence.mmd`
- Create: `apps/web/public/architecture/local-agent-architecture.svg`
- Create: `apps/web/public/architecture/local-agent-sequence.svg`
- Create: `docs/evidence/testing/2026-08-22-local-agent-smoke.json`
- Create: `scripts/validate-local-agent-evidence.mjs`
- Create: `scripts/validate-local-agent-evidence.test.mjs`
- Modify: `apps/web/src/pages/EvidencePage.tsx`
- Modify: `scripts/verify-all.mjs`
- Modify: `scripts/verify-all.test.mjs`

**Interfaces:**
- Produces: machine-checked sanitized evidence and public diagrams.
- Consumes: runner test output and one real local model response.

- [ ] Add validator tests rejecting secrets, private paths, digest mismatch, fake cloud completion and edited model answer.
- [ ] Generate diagrams from committed Mermaid sources.
- [ ] Run one safe prompt through `personal-ai-agent-runtime:v4.1`; record model tag/digest, duration, prompt hash and unedited safe answer.
- [ ] Add Evidence sections for registration, invocation, failure/retry, offline and pending-cloud boundary.
- [ ] Run Evidence validator and Web build, then record T5 review/checkpoint.

### Task 6: Feature QA and Preview Delivery

**Files:**
- Create: `.tc-flow/qa/feature-result.json`
- Create: `.tc-flow/memory/agent-market-local-ollama-agent-fa5a1112.md`
- Create: `.tc-flow/memory/INDEX.md`
- Create: `.tc-flow/run-memory.md`
- Create: `.tc-flow/run-result.json`
- Modify: `README.md`

**Interfaces:**
- Produces: reviewed Feature, PR, Preview and `production: manual-pending` RunResult.
- Consumes: all Task checkpoints and sanitized diffs.

- [ ] Run runner/shared/Web tests, typecheck, build and root `pnpm verify`.
- [ ] Check 375, 390, 430 and 1440 layouts plus SSR/404/asset matrices.
- [ ] Run public-content, PII/secret scan and central repository policy audit.
- [ ] Perform isolated review, repair only reported issues, then rerun full Feature QA.
- [ ] Commit as repository owner, push, create PR, verify remote Gate and Cloudflare Preview; do not merge or publish production.
