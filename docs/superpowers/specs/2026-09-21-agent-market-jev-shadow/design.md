# Agent Market Jev Shadow Design

## Outcome

Add Jev as an optional, server-side, typed recommendation layer for Queen local
routing, task-specific quality evidence, and existing AI dispute routes. The
existing deterministic rules remain authoritative. The Go Marketplace Matcher
is a separate follow-on integration because it has a different ranking model
and hard-filter boundary.

## Phase 1 decision flow

```text
synthetic allowlisted snapshot
-> strict local schema validation
-> disabled-by-default Jev adapter with injected transport
-> response/schema/pool/threshold validation
-> observed evidence or deterministic fallback
```

Phase 1 does not wire production ranking or the current StateGraph. It proves the
contracts and adapter with synthetic fixtures only, leaving the baseline byte-for-byte
unchanged.

## Supported decisions

- `agent_match`: Choice among opaque per-decision candidate references that have
  already passed implemented deterministic gates.
- `agent_quality`: five-level Score stored as task evidence only; it cannot update
  the authoritative reputation ledger.
- `dispute_route`: Choice among current AI routes: `judge`, `red_team`, `repair`,
  or `ai_final_arbiter_review`.
- Shuffle is outside this Jev plan. Current SHA-256 tie ordering remains the
  deterministic authority; future seeded shuffle or VRF work needs its own design.

## Safety boundaries

- Jev cannot restore an ineligible candidate or authorize access, spending,
  settlement, chain transactions, destructive actions, or wallet roles.
- Boundary objects reject raw prompts, source code, private chat, local paths,
  wallet identity, secrets, and full Agent output.
- `TYPESAFE_API_KEY` is server-side only. Tests inject a fake transport.
- `JEV_SHADOW_ENABLED` defaults to false. No real Agent Market data is sent in
  Phase 1.
- Timeout, authentication failure, rate limits, server errors, invalid schema,
  out-of-pool choice, or uncalibrated thresholds all fall back deterministically.
- A Choice or Score is invalid unless its probability keys are allowlisted, sum
  to approximately one, and make the returned option a highest-probability result.
- Candidate references are random opaque IDs scoped to one decision. Correlation
  fields are HMAC-shaped values; raw internal IDs never cross the boundary.

## Evidence and rollout

Valid synthetic responses are `observed`, never `accepted`. Frozen synthetic cases
execute the real adapter against an injected transport and compare the existing
routing evaluation before and after; the evidence artifact is checked against those
derived results rather than trusting fixture claims. Production thresholds
require a labeled development/calibration/blind-test split. The five-case routing
set is smoke coverage, not calibration evidence.

The implementation base is `30ffe80bd289cea1b3d55dfc08bd90e3bc05ebe1`.
The overlapping dirty worktree was checkpointed separately and remains untouched.
