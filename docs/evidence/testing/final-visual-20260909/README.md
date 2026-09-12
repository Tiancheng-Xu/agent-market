# Final frontend visual / deep-route Gate, 2026-09-09

## Verdict: FAIL, not release or business acceptance

One authorized `npm run build` emitted the current client and SSR worker, then exited 1: `Edge bundle contains browser-only marker: window.ethereum`. The audit served those emitted assets and that worker, not an older successful build. `asset-hashes.json` identifies the exact compiled inputs. No source fixes were made during this Gate.

## Findings requiring owners' decisions

| ID | Severity | Evidence and scope |
| --- | --- | --- |
| F1 | Blocker | Edge build verification rejects `window.ethereum`. Observed import path: `apps/web/src/ssr/ServerApp.tsx:4` imports ControlPages OpsPage; `apps/web/src/pages/ControlPages.tsx:6` imports GovernancePanel and line 77 renders it. Emitted `_worker.js:11163` includes the wallet provider; GovernancePanel at 11403 references authentication at 11443. Browser rendering success does not clear this packaging boundary. |
| F2 | Medium | `/agents/local`, zh-CN, all five widths: four English-only offline/login/demo explanatory paragraphs (exact text in matrix.json summary.untranslated). Manual order-page review additionally found short English labels `Evidence before settlement`, `View explainable matches`, `ACCEPTANCE CONTRACT`, missed by the long-text heuristic. See local-language-1440-zh.png and order-layout-1440-zh.png. |
| F3 | Medium | `/tasks/task-research-brief` desktop contract panel stretches with 414-548 px blank lower area across 1440/1920 and zh/en. `.order-contract-card,.reputation-card{min-height:100%}` exists in `apps/web/src/order.css:1`. At 1440 zh the reputation score wraps `52.4` into separate lines and dimension labels are squeezed/overlap. Screenshot establishes the defect; risk CSS was not changed and exact repair remains the owner's decision. |

Additional build warning: main client chunk 558.86 kB (180.67 kB gzip) exceeds the 500 kB warning threshold. No performance budget or production performance claim is made.

## Exact matrix

Each row was directly navigated at 375, 390, 430, 1440 and 1920 px, in zh-CN and en: 10 combinations per route, 180 total. Browser pathname matched every requested deep link. No route was replaced by the root page. Unreachable routes: **none**. `/missing` intentionally returns 404 and renders the not-found route.

| Deep route | HTTP | Completed combinations |
| --- | --- | --- |
| `/` | 200 | 10/10 |
| `/agents` | 200 | 10/10 |
| `/agents/new` | 200 | 10/10 |
| `/agents/local` | 200 | 10/10 |
| `/agents/personal-image-agent` | 200 | 10/10 |
| `/tasks` | 200 | 10/10 |
| `/tasks/new` | 200 | 10/10 |
| `/tasks/task-research-brief` | 200 | 10/10 |
| `/tasks/task-research-brief/matches` | 200 | 10/10 |
| `/tasks/task-research-brief/workspace` | 200 | 10/10 |
| `/office` | 200 | 10/10 |
| `/dashboard` | 200 | 10/10 |
| `/staking` | 200 | 10/10 |
| `/committee` | 200 | 10/10 |
| `/disputes/dispute-demo` | 200 | 10/10 |
| `/ops` | 200 | 10/10 |
| `/evidence` | 200 | 10/10 |
| `/missing` | 404 expected | 10/10 |

Machine-readable detail: matrix.json and matrix.csv. Completed does not mean visual PASS: F2/F3 remain. Across the matrix: document horizontal overflow 0, broken images 0, empty buttons 0, page exceptions 0, pathname mismatches 0. Out-of-viewport visible DOM check also found none; intentionally panned ReactFlow viewport content was excluded. DOM boundary checks cannot detect all internal text collisions, as F3 demonstrates. English-locale Chinese-text heuristic found none; Chinese-language completeness is not established by that heuristic.

## Targeted actual interactions

`interactions.json` records all five widths; these interaction probes supplement the bilingual matrix, not every possible action in every combination.

- Agents to Tasks navigation used actual mouse clicks after a nonzero document scroll. All five reset scroll to top. Mobile More opened, navigated to Ops, and closed at all three mobile widths; desktop Ops links worked at both desktop widths.
- Ops displayed the governance panel, wallet/authentication boundary and NOT QUERIED / no live readback status at all widths. It did not claim backend success or grant a role.
- Local displayed eight actual ReactFlow nodes and eight edges; actual zoom-in control changed the viewport transform at all widths. Offline and local-demo labels remained present. This is visual fixture graph rendering, not a persisted Queen workflow or real agent execution.
- Cocos engine reported ready/game-start and advancing frames. All five widths had 16 OfficeRoot children and three desk hit nodes; canvas dimensions matched render-window dimensions (341x212, 356x222, 396x247, 759x474, 970x606).
- An actual mouse hit on the projected second engine desk caused the real `agent-market.office.select-desk.v2` event, changed the inspector and matched its task link at all five widths. No selection message was forged. The existing demo task ID is a visual fixture, not transaction evidence.
- `canvas-language.json`: actual Cocos Label heading was rendered correctly in all ten width/locale combinations, not merely in the surrounding HTML.
- Targeted probes initially used insufficient route/zoom settle time; final observations wait for the Ops panel and the zoom transition. Those preliminary timing artifacts are not product findings.

## Offline readbacks and limits

Actual HTTP calls to the local compiled worker, without configured backend environment:

| Endpoint | Result |
| --- | --- |
| `/agent/healthz` | 200, offline, RUNTIME_OFFLINE, empty agents |
| `/api/governance/events` | 503, TRANSACTION_ENGINE_OFFLINE |
| `/api/tasks/11111111-1111-4111-8111-111111111111/risk-context` | 503, TRANSACTION_ENGINE_OFFLINE |

These are genuine local HTTP readbacks, not successful production backend access. The UUID above is a synthetic read-only fixture identifier. The promised 18-route matrix uses the existing fixture order route, not a signed-in live UUID order. Authenticated governance mutations, real persisted workflow, wallet signatures, chain transactions and production business correctness remain outside this visual Gate. No wallet provider was injected for this run. Prior Mock EIP1193 W7 evidence still does not prove a real external signature or chain success.

## Isolation, method and retained evidence

- Existing `scripts/visual-route-audit.mjs` was used as the basis, with temporary-only additions for sparse screenshots, continued matrix execution and DOM/runtime metrics. Existing `apps/web/scripts/validate-rendering-runtime.mjs` informed the compiled-worker Node adapter. This is not Cloudflare/workerd runtime-parity validation.
- Dedicated loopback HTTP port 4198, exec session 60177; dedicated headless Chrome profile and CDP port 9418, exec session 72099. No frontmost Chrome, CDP9226, recordings, cloud commands, Git or real chain transactions were used. Shutdown is recorded in lifecycle.json.
- Eight representative screenshots are scaled without retouching into contact-sheet.jpg. Only three full-size supporting PNGs are retained here, rather than 180 screenshots. The public evidence directory mirrors only the compact summary and contact sheet.
- Evidence strips temporary/workspace paths and long hex identifiers. Public fixture task labels are retained for reproducibility. No cookies, signatures, session values, credentials or browser profile are archived.
- `summary.json`, `matrix.json`, `matrix.csv`, `interactions.json`, `canvas-language.json`, `asset-hashes.json`, `contact-sheet.jpg` and the three supporting PNGs are durable project artifacts, not temporary-only deliverables.
