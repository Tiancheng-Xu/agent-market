# Agent Market Bilingual Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complete Chinese/English interface to every Agent Market Web route without changing SSR correctness, business data, Evidence semantics, or deployment architecture.

**Architecture:** A dependency-free `LanguageProvider` owns `en | zh-CN`, exposes a typed translation function, and persists explicit user choice after hydration. Server rendering and the first browser render always use English; an effect restores the stored preference only after hydration.

**Tech Stack:** React 19, TypeScript, React Router, Vitest, React Web Streams, Vite, Cloudflare Workers Static Assets.

**Spec:** `docs/superpowers/specs/2026-08-20-bilingual-web-design.md`

## Global Constraints

- Support only `en` and `zh-CN` in phase one.
- Keep SSR and the first browser render in English.
- Persist only the locale identifier in `localStorage`.
- Do not translate user data, addresses, hashes, URLs, code paths, protocol names, or SVG internals.
- Do not add a third-party translation service or runtime dependency.
- Preserve Evidence ledger values and external-verification boundaries.

---

### Task 1: Typed i18n core

**Files:**
- Create: `apps/web/src/i18n/translations.ts`
- Create: `apps/web/src/i18n/LanguageProvider.tsx`
- Create: `apps/web/src/i18n/LanguageProvider.test.tsx`

**Interfaces:**
- Produces: `type Locale = "en" | "zh-CN"`.
- Produces: `useLanguage(): { locale: Locale; setLocale(locale: Locale): void; t(key: TranslationKey): string }`.
- Produces: `LanguageProvider({ children, storage? })` with English initial state.

- [ ] **Step 1: Write failing tests for English initial state, Chinese switching, persistence, and invalid stored-value fallback.**

```tsx
expect(screen.getByTestId("locale")).toHaveTextContent("en");
await user.click(screen.getByRole("button", { name: "中文" }));
expect(storage.setItem).toHaveBeenCalledWith("agent-market-locale", "zh-CN");
```

- [ ] **Step 2: Run the focused test and confirm the provider is missing.**

Run: `pnpm --filter @agent-market/web test -- src/i18n/LanguageProvider.test.tsx`
Expected: FAIL because `LanguageProvider` does not exist.

- [ ] **Step 3: Implement the typed dictionaries and provider.**

```tsx
export type Locale = "en" | "zh-CN";
export type TranslationKey = keyof typeof en;
export function useLanguage() { return useContext(LanguageContext); }
```

- [ ] **Step 4: Run the focused test and confirm all locale cases pass.**

Run: `pnpm --filter @agent-market/web test -- src/i18n/LanguageProvider.test.tsx`
Expected: PASS.

### Task 2: Shell and route copy migration

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/Shell.tsx`
- Modify: `apps/web/src/components/Ui.tsx`
- Modify: `apps/web/src/data.ts`
- Modify: `apps/web/src/lib/domain.ts`
- Modify: `apps/web/src/pages/HomePage.tsx`
- Modify: `apps/web/src/pages/DirectoryPages.tsx`
- Modify: `apps/web/src/pages/WorkflowPages.tsx`
- Modify: `apps/web/src/pages/ControlPages.tsx`
- Modify: `apps/web/src/pages/EvidencePage.tsx`
- Modify: `apps/web/src/pages/NotFoundPage.tsx`
- Modify: `apps/web/src/evidence/FullChainEvidence.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `LanguageProvider` and `useLanguage` from Task 1.
- Produces: one global `中文 / EN` toggle and translated route content.

- [ ] **Step 1: Add a failing render test proving the Shell can switch a representative route to Chinese without remounting Router state.**
- [ ] **Step 2: Wrap `App` in `LanguageProvider`, localize Shell labels, and add an accessible 44 px language toggle.**
- [ ] **Step 3: Replace static interface copy in every route with translation keys while retaining fixture and Evidence values unchanged.**
- [ ] **Step 4: Add responsive CSS for the toggle and screenshot cards at 375, 390, 430, and 1440 px widths.**
- [ ] **Step 5: Run Web tests.**

Run: `pnpm --filter @agent-market/web test`
Expected: PASS.

### Task 3: Sanitized delivery screenshots and truthful Evidence

**Files:**
- Create: `apps/web/public/evidence/aws-cloudformation-stack.png`
- Create: `apps/web/public/evidence/aws-runtime-exit-zero.png`
- Create: `apps/web/public/evidence/github-actions-success.png`
- Create: `apps/web/public/evidence/cloudflare-edge-ssr.png`
- Modify: `docs/evidence/testing/2026-08-20-performance-observability.json`
- Modify: `docs/evidence/requirements.yaml`
- Modify: `apps/web/src/pages/EvidencePage.tsx`
- Modify: `apps/web/src/evidence/FullChainEvidence.tsx`

**Interfaces:**
- Consumes: sanitized screenshots captured only after external readback.
- Produces: public screenshot cards with captions, timestamps, and lifecycle status.

- [ ] **Step 1: Capture project-only AWS, Actions, and Cloudflare views with account IDs, emails, ARNs, secrets, and unrelated resources excluded.**
- [ ] **Step 2: Record the real ECS `exitCode=0`, SQS/DLQ depth, Worker SSR status, and deployment identifiers in Evidence JSON.**
- [ ] **Step 3: Advance only requirements supported by implementation, tests, deployment readback, and reproducible evidence.**
- [ ] **Step 4: Render bilingual screenshot cards and replace stale deployment limitations with current truthful limitations.**

### Task 4: End-to-end verification and release

**Files:**
- Modify: `apps/web/wrangler.jsonc`
- Modify: Evidence deployment records only when production readback succeeds.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: verified custom-domain Worker SSR, one persisted performance run, and paused project-specific AWS consumers.

- [ ] **Step 1: Run repository verification and Web production build.**

Run: `pnpm verify && pnpm --filter @agent-market/web build`
Expected: all checks pass.

- [ ] **Step 2: Deploy the Worker and verify `/evidence`, a task workspace, and a missing route using `Accept: text/html`.**
Expected: `200/200/404`, each with `x-agent-market-render-mode: ssr`.

- [ ] **Step 3: Switch `agent-market.baby2b.online` to the verified Worker, run one browser performance sample, and read it back through AWS/PostgreSQL.**
- [ ] **Step 4: Update public Evidence, verify the public readback, then disable the event-source mapping and confirm ECS running count is zero.**
- [ ] **Step 5: Push the final commit and confirm GitHub Actions and Cloudflare production status.**
