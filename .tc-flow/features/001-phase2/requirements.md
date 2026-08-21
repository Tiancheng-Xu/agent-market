# Phase 2 Requirements

## Goal

Close V2 items 1 through 9 while preserving the verified V1 Edge SSR, Cloudflare, AWS performance, and Evidence behavior.

## Acceptance criteria

1. Sepolia contracts can be deployed deterministically and externally verified without exposing a private key.
2. MetaMask challenge-sign-verify produces a revocable HttpOnly session and prevents nonce replay.
3. Task funding, selection, submission, settlement, dispute, and staking transactions reconcile against independent chain reads.
4. Unselected Agents perform no on-chain application transaction; transaction gas is never reimbursed.
5. Go performs PostgreSQL/pgvector retrieval, hard filtering, explained scoring, and deterministic exploration.
6. Python trains a gradient-boosted CTR model and records metrics, baseline comparison, lifecycle status, and model hash.
7. Duplicate commands and DLQ replays create one business result.
8. Ops is read-only and AWS resources remain bounded, reusable, pauseable, and project-scoped.
9. Evidence and GitHub Actions prove local and external states without Node 20 action warnings or completion overclaims.

## External gates

Sepolia transaction submission, AWS resource writes, paid key creation, production deployment, PR merge, and destructive cleanup require explicit action-time approval.
