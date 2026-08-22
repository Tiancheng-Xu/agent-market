# Phase 2 Feature Design

The canonical design is `docs/superpowers/specs/2026-08-21-agent-market-phase2-design.md` under Contract `184ef819ebc06e6c9cf72625db93ac10da90fea9b8670d1d64c9f182d83c0e0c`.

The implementation preserves Cloudflare Edge SSR, sends authenticated commands to the Next.js transaction engine, commits business state and outbox records in PostgreSQL, performs matching in Go with pgvector, trains a one-shot gradient-boosted model in ECS, and lets MetaMask sign every Sepolia write. RPC and Blockscout provide independent receipt and event evidence. The Graph is deliberately deferred.

Gas paid to Ethereum is non-refundable. Unselected candidates do not transact. YD principal and bond remain governed by explicit escrow states rather than being treated as gas.
