# Agent Market Web and Evidence Implementation Plan

## Objective

Build the production React/Vite/Tailwind shell for all PRD routes and a truthful Evidence surface that renders the approved architecture, request sequence, requirement ledger, verification outputs, AWS screenshots, and delivery limitations.

## Boundaries

- Stitch is a visual reference; PRD and architecture are the behavioral source of truth.
- Demo fixtures are visibly labeled and never promoted to Evidence.
- MetaMask is client-only and restricted to Sepolia (`11155111`).
- Evidence is generated from `docs/evidence/requirements.yaml`.
- Cloudflare uses Pages Git Integration. GitHub Actions verifies but does not deploy.
- AWS screenshots may be added only after live readback and sanitization.

## Batch W1

1. Create `apps/web` with React, TypeScript, Vite, Tailwind, BrowserRouter, and shared responsive shell.
2. Implement all 15 PRD routes from one component tree.
3. Implement disconnected, wrong-network, connecting, and Sepolia wallet states.
4. Add truthful demo fixtures, empty states, transaction progress, errors, and 404.

## Batch W2

1. Add Evidence generator and 15-requirement registry.
2. Add architecture and request-lifecycle Mermaid sources plus public SVG renders.
3. Add local verification, delivery, limitations, and screenshot sections.
4. Add Baby2B publication manifest and non-deploy verification caller.

## Exit Gate

- Web tests, typecheck, and production build pass.
- 375, 390, 430, and 1440 layouts have no root horizontal overflow.
- Built output contains a non-empty `index.html` and SPA deep-link fallback.
- No private paths, secrets, fake hashes, fake deployments, or unmarked fixture data enter the public artifact.
- AWS, GitHub Actions, Cloudflare, and Sepolia remain unverified until live external readback exists.
