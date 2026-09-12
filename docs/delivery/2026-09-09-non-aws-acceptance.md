# Non-AWS long-task acceptance

Baseline before this work: `4589c72b110fbe17163320eef224bdeca2e25025`.

Current decision: **production released / UI recording verified**. The released source is main `2dfe6d0aa6fa40b65762c07ed687921233b0e0c6`, main Actions Run `34697552824` succeeded, and Cloudflare production deployment `d8cf5994-ce54-47f1-8979-0c799eca8b79` passed route and real-404 readback. Local implementation, tests, build, visual review, production publication, Runtime availability, and external chain/cloud proof remain separate ledgers.

## Accepted local implementation

| Area | Accepted evidence |
| --- | --- |
| Web | 50 files / 402 tests passed; wallet HTTP 1/1 passed; production build passed |
| Transaction Engine | 348 non-DB tests passed; 46 environment tests skipped |
| Real PostgreSQL | commercial 31, risk 9, governance 7, and VRF 14 passed |
| Resource-contention isolation | Two full-suite timeout groups each passed in isolated 12/12 runs |
| Local Agent Runner | 17 files / 125 tests passed; 8 environment-dependent tests skipped |
| Contracts and trainer | contracts 34; trainer 33 |
| Static/tooling Gates | repository/evidence 32; three TypeScript typechecks; Go `vet` and `test` passed |
| Visual v4 | 18 routes x 5 widths x 2 locales = 180; zero overflow, broken images, empty buttons, page errors, and i18n findings |
| Cocos | Ready in 630-674 ms at all five widths |
| Human visual review | 12 key Chinese screenshots reviewed at 390 and 1920 widths |
| Independent review | P0 = 0, P1 = 0; five P2 findings repaired and targeted checks passed |

The accepted implementation includes L1-L4, deterministic and explainable matching, reputation, P+A+B symmetric deposits, commercial reconciliation, governance, StateGraph branches, durable Checkpoint recovery, local Temporal, Outbox/queue boundaries, dual-scope Runtime HMAC, wallet/session safety, Chainlink VRF no-reroll behavior, Cocos Office, and bilingual responsive routes.

## Acceptance boundaries

- PostgreSQL and Temporal results are `verified-local`. They do not prove a production Runtime host, tunnel, database, or continuous service.
- The VRF Gate proves local contract, persistence, role isolation, and no-reroll behavior. External Chainlink deployment and callback remain pending.
- No AWS operation or Free Plan change occurred in this round.
- No new Sepolia transaction occurred in this round.
- The Graph remains deferred.
- The production recording is a 331.7-second H.264/AAC Chrome capture with Mandarin narration and SHA-256 `e7e651d220c44f5910bb67fcce760b4cb91dcece88003240e307c3eb65449d9d`. It records production UI and status boundaries, not wallet, AWS, Sepolia, Chainlink or Temporal execution.

## Final closeout still required

1. Publish the new recording asset and truthful coverage manifest through the final Evidence PR.
2. Read back the final Evidence deployment and recording URL.
3. Send the final architecture and remaining external boundaries to task `01a0758e-78f5-75a1-90f7-43d75de6e780`.

Structured evidence: `docs/evidence/testing/2026-09-12-non-aws-completion.json`.

Visual evidence: `docs/evidence/testing/final-visual-20260912/result.json`.
