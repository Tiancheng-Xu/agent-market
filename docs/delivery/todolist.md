# Agent Market authoritative TODO

Updated: 2026-09-12
Status: **local verified / release pending**

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

- [ ] Commit the verified source state, open/merge the GitHub PR, and record the exact source SHA and successful Actions Run.
- [ ] Publish through the existing Cloudflare Git integration and read back the exact deployment, production routes, Evidence route, and real 404.
- [ ] Record the released production experience with an explicit coverage manifest. It must show Cocos Office, Queen workflow and Checkpoint boundary, task/order/reputation/risk, matching/VRF boundary, staking, arbitration, operations, and Evidence without claiming untriggered external actions.
- [ ] Publish the recording Evidence and bind it to the released source and production deployment.
- [ ] Send the final architecture, release identifiers, URLs, and remaining external boundaries to task `01a0758e-78f5-75a1-90f7-43d75de6e780`.

## Explicit external boundaries

- AWS: not run or changed in this round. Existing historical AWS Evidence keeps its original scope only.
- Sepolia: no new transaction in this round. Existing receipts are not evidence for the current uncommitted release candidate.
- Chainlink VRF: external deployment and callback are pending. Local contract, persistence, permissions, and no-reroll Gates are not oracle fulfillment.
- Temporal Runtime: production host and tunnel are pending. Local service and restart recovery do not prove production availability.
- The Graph: deferred by ADR; current readback strategy remains exact RPC plus Blockscout reconciliation.
- Source identity: the working tree is not committed, so no final SHA is recorded yet.

## Current acceptance snapshot

- Web: 50 files / 402 tests, plus wallet HTTP 1/1.
- Local Agent Runner: 17 files / 125 passed, with 8 environment-dependent tests skipped.
- Transaction Engine: 348 non-database tests passed, with 46 environment tests skipped; real PostgreSQL commercial 31, risk 9, governance 7, and VRF 14 all passed. Two full-suite resource-contention timeouts passed in isolated 12/12 runs.
- Contracts 34; trainer 33; repository/evidence 32.
- Three TypeScript typechecks, Go `vet`/`test`, and production build passed.
- Visual v4: 18 routes x 5 widths x 2 locales = 180. Zero overflow, broken images, empty buttons, page errors, and i18n findings. Cocos ready in 630-674 ms. Twelve key Chinese screenshots were manually reviewed.
- Independent final review: P0 = 0, P1 = 0; all five P2 findings were repaired and targeted checks passed.

Machine-readable detail: `docs/evidence/testing/2026-09-12-non-aws-completion.json`.
