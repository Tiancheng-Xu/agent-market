# Agent Market authoritative TODO

Updated: 2026-09-26
Status: **complete / production Evidence verified**

This is the single active delivery queue. Historical checklists are evidence of
their own time and scope, not current work queues. The implementation follows
the user's software-design principles: deep modules, small interfaces, explicit
authority, bounded failure, deterministic Gates before model judgment, and
falsifiable acceptance.

## Completed non-AWS scope

- [x] L1/L2 product foundations: eligibility, deterministic ranking, seeded cold-start exploration, explainable matching, five-dimension reputation, and risk-aware symmetric deposits.
- [x] L3 commercial ledger: finalized Queen graph binding, parent/child orders, budget conservation, immutable quote identity, publisher and assigned-Agent confirmations, claims, reconciliation, and additive platform fee.
- [x] L4 governance and operations: scoped roles, emergency halt, compensation review, two-person review, audit records, and deny-by-default HTTP boundaries.
- [x] Queen StateGraph: `Queen -> Agent -> Judge -> Red Team/Repair -> Final Arbiter -> Evidence`, including explicit conditional branches.
- [x] Durable Checkpoint and local Temporal recovery: confirmation pauses, deadlines, restart recovery, and no replay of uncertain side effects.
- [x] SNS/SQS/DLQ-shaped local planning flow with Outbox authority checks; messages transport work but never grant permission.
- [x] Runtime HMAC split into public and owner keys with key-to-scope ACL and fail-closed legacy-key handling.
- [x] Wallet/session safety, recent-auth write Gates, account/network switch invalidation, exact resource identity, and same-origin Edge routes.
- [x] Chainlink VRF integration contract, frozen candidate pool, independent reader role, one callback, and no-reroll behavior verified locally.
- [x] Cocos Office, local workflow diagram, task/order/reputation/risk surfaces, Committee/Operations surfaces, route scroll reset, responsive layout, and bilingual copy.
- [x] Local code Gates, real local PostgreSQL suites, production build, final independent review, and the fresh 180-combination visual Gate.
- [x] Final P2 repairs: pure GET selection, wallet/session identity alignment, arbitration i18n, independent VRF reader principal, and current dual-key Temporal preparation Evidence.

## Active release queue

- [x] Commit and merge the verified source: main `2dfe6d0aa6fa40b65762c07ed687921233b0e0c6`; successful main Actions Run `34697552824`.
- [x] Publish through Cloudflare Git integration: production deployment `d8cf5994-ce54-47f1-8979-0c799eca8b79`; required routes returned 200 and an unknown route returned a real 404.
- [x] Record the released production experience with Cocos Office, Queen StateGraph and Checkpoint, task/order/reputation/risk, matching/VRF boundary, staking, arbitration, operations, and Evidence. The 331.7-second H.264/AAC artifact passed the audio Gate and is bound to the released source and deployment.
- [x] Publish the recording Evidence through PR #27, merged as main `a9278665d25dad64ab22477a10a39974a2712744`; PR Verify Run `34705871834` succeeded and Cloudflare Production deployment `de287f0d-8e89-4eca-bb0c-b08a1fb5af8f` passed manifest, video Range, reciprocal-link and real-404 readback.
- [x] Send the final architecture, release identifiers, URLs, and remaining external boundaries to task `01a0758e-78f5-75a1-90f7-43d75de6e780`.

## Post-release extension: System-One Jev/Laya shadow integration (2026-09-24)

Status: **implemented; Node 22 verification and offline runtime evidence pass; not merged or deployed**. The deterministic baseline remains authoritative, the mode defaults to `off`, and the provider policy remains `calibrated: false` pending labeled evaluation.

- [x] Add provider-neutral decision contracts, Jev and local Laya adapters, sanitized Queen decision inputs, and dual-shadow Evidence.
- [x] Keep provider work off the request path; return the deterministic baseline immediately and drain bounded observations only during shutdown.
- [x] Preserve per-provider capacity until timed-out underlying work settles; bound shutdown waiting and defer Laya session close until inference safely settles.
- [x] Verify Node 22 local-agent-runner tests (199 passed, 8 skipped), shared-contract tests (61 passed), and local-agent-runner typecheck.
- [x] Install and hash-verify the local ONNX assets, then prove cold start and inference with DNS and outbound network unavailable; missing assets must fall back without downloads. **2026-09-25:** the pinned bundle hashes match; Node 22.23.2 completed synthetic match, quality, and dispute inferences inside a network-denied OS sandbox (`fetch` calls: 0). The full Agent Runner suite passed 199 tests (8 skipped) and typecheck passed. Evidence: `docs/evidence/testing/2026-09-25-laya-offline-smoke.json`.
- [x] Re-run the full Agent Runner suite on Node 22 after the 2026-09-25 Score/probability expected-value guard. **2026-09-26:** Node 22.23.1 passed 203 tests (8 skipped across 7 skipped files); Agent Runner typecheck, repository validation, Evidence validation, and `git diff --check` also passed.
- [ ] Run a frozen, de-identified, labeled evaluation for each decision type; review calibration, abstention, disagreement, latency, and cost before any provider can affect a workflow. The current 13-case fixture remains synthetic-only; the three-case real-model offline smoke proves runtime readiness only, not decision quality. A representative labeled dataset, calibration results, and Jev comparison are still absent.
- [ ] After those gates, open a PR and run repository CI plus the required preview/readback before considering production rollout.

## Explicit external boundaries

- AWS: this round performed only read-only STS authentication probes; all eight local profiles were unavailable, so no live inventory or resource change occurred. Existing historical AWS Evidence keeps its original scope only.
- Sepolia: no new transaction in this round. Existing receipts are not evidence for the current uncommitted release candidate.
- Chainlink VRF: external deployment and callback are pending. Local contract, persistence, permissions, and no-reroll Gates are not oracle fulfillment.
- Temporal Runtime: production host and tunnel are pending. Local service and restart recovery do not prove production availability.
- The Graph: deferred by ADR; current readback strategy remains exact RPC plus Blockscout reconciliation.
- Recording identity: `ce7e4fb873ab007130b4052759ac5af66fb5dd37b403852d6210ea1ce8daac2e`, captured from production source `2dfe6d0aa6fa40b65762c07ed687921233b0e0c6` without wallet, AWS, Sepolia, GitHub, or Cloudflare mutation during capture.

## Current acceptance snapshot

- Web: 50 files / 402 tests, plus wallet HTTP 1/1.
- Local Agent Runner: 17 files / 125 passed, with 8 environment-dependent tests skipped.
- Transaction Engine: 348 non-database tests passed, with 46 environment tests skipped; real PostgreSQL commercial 31, risk 9, governance 7, and VRF 14 all passed. Two full-suite resource-contention timeouts passed in isolated 12/12 runs.
- Contracts 34; trainer 33; repository/evidence 32.
- Three TypeScript typechecks, Go `vet`/`test`, and production build passed.
- Visual v4: 18 routes x 5 widths x 2 locales = 180. Zero overflow, broken images, empty buttons, page errors, and i18n findings. Cocos ready in 630-674 ms. Twelve key Chinese screenshots were manually reviewed.
- Independent final review: P0 = 0, P1 = 0; all five P2 findings were repaired and targeted checks passed.

Machine-readable detail: `docs/evidence/testing/2026-09-12-non-aws-completion.json`.
