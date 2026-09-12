# Non-AWS long-task acceptance

Baseline before this work: `4589c72b110fbe17163320eef224bdeca2e25025`.

Current decision: **local verified / release pending**. The locally verified implementation is bound to commit `9097b4acc9461bb71fbe1983461936ca5a6af190`; this implementation commit is not yet claimed as a released production SHA. Local implementation, tests, build, visual review, production publication, Runtime availability, and external chain/cloud proof remain separate ledgers.

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
- The verified implementation commit is `9097b4acc9461bb71fbe1983461936ca5a6af190`; no PR, GitHub Actions Run, Cloudflare write, final release SHA, or production recording is claimed by this acceptance update.

## Release acceptance still required

1. Bind implementation commit `9097b4acc9461bb71fbe1983461936ca5a6af190` to a successful GitHub Actions Run and accepted PR.
2. Publish through the existing Cloudflare Git integration and record the exact deployment plus production route/readback results.
3. Record and publish a production walkthrough with a truthful coverage manifest.
4. Reconcile the final source, deployment, recording, Evidence, and architecture.
5. Send that final architecture and the remaining external boundaries to task `01a0758e-78f5-75a1-90f7-43d75de6e780`.

Structured evidence: `docs/evidence/testing/2026-09-12-non-aws-completion.json`.

Visual evidence: `docs/evidence/testing/final-visual-20260912/result.json`.
