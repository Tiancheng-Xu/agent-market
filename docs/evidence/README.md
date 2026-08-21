# Agent Market Evidence

This directory records reproducible project evidence. Architecture, plans, UI references, and code existence are not completion proof by themselves.

## Current snapshots

- `delivery/2026-08-20-progress-log.md`: implementation and delivery status by runtime.
- `testing/2026-08-20-foundation-gates.json`: machine-readable local gate results.
- `requirements.yaml`: canonical REQ-AM-01 through REQ-AM-15 status ledger.
- `phase2-local-validation.json`: bilingual V1/V2 truth boundary and public Evidence source. V2 never inherits V1 production status.
- `deployment/2026-08-21-cloudflare-pages-v2-production.json`: Git-integrated Pages deployment, Actions identifiers, SSR/deep-link/404 readback, and production screenshot binding.

## Evidence rules

- Local test output may prove local behavior only.
- AWS, Cloudflare, and Sepolia require official external readback.
- Screenshots must be sanitized and tied to a command, resource, deployment, or transaction identifier.
- Demo fixtures and Stitch boards are never delivery evidence.
- Shared infrastructure must not be attributed to Agent Market without project-specific ownership proof.
- Public status uses only `verified-local`, `verified-production`, `pending-external`, and `deferred`.
- A V2 item cannot be `verified-production` until fresh V2 external identifiers and readback are recorded.
