# Agent Market System-One Dual-Backend Design

## 1. Goal

Add a provider-neutral System-One decision plane to Agent Market so that Laya can run locally for private, low-latency shadow decisions while Jev remains available as a hosted comparison backend. Neither provider receives routing, scoring-ledger, dispute, wallet, permission, randomness, or settlement authority until task-specific calibration gates pass.

## 2. Current evidence

The existing Jev foundation is committed at `9902a797bb18fad0f877142cb3e671b860bd3172`. It defines strict match, quality, dispute, threshold, fallback, and evidence contracts, but it is disabled by default and is not wired into production routing.

A throwaway local spike ran `@receptron/laya@0.1.1` on Apple M5 under Node `v22.23.2` with the ONNX model pinned to Hugging Face revision `68f27dfe5a27a54fb2b1fefc432f43f972e90868`. The downloaded graph and data files matched these SHA-256 values:

- `laya.onnx`: `a874eb254b58b0fcb1e7ad56fbb188c29d64e08c9a46b689433e1f52c66dba1e`
- `laya.onnx.data`: `487746363a8da57bcadb4345352997d22a0fb90d70aa22c6856668d023242aba`

The model used about 1.6 GiB on disk, loaded in 702 ms, and produced warm CPU p50 latency of 99–169 ms across synthetic match, quality, and dispute inputs. Laya returned valid distributions, but match and dispute confidence were only `0.113` and `0.1994`.

The same three synthetic inputs were sent to Jev `1.13.0`. Observed latency ranged from 275–1,842 ms. Jev strongly preferred the deterministic match candidate, strongly rated the completed result, and had low confidence on the dispute route. Both Laya and Jev returned fractional expected scores (`3.183` and `3.97`), revealing that the current Jev adapter's integer-only score parser would reject a valid live response.

These three cases prove compatibility and expose contract issues; they do not establish comparative accuracy or calibration.

## 3. External evidence and limits

Laya is an Apache-2.0 open-weight model with a MIT Node runtime. Its own documentation reports strong local latency and typed `choice`, `score`, and `noul` outputs, but also says the base checkpoints are near chance on its typed-decisions benchmark, the reported leading result comes from a checkpoint fine-tuned on that benchmark's training split, Jev numbers were not measured in the same run, and high-cardinality choices remain a weakness. Agent Market must therefore treat Laya as a fast local model to calibrate, not as a drop-in proof of superiority.

## 4. Non-negotiable authority boundary

The deterministic host remains authoritative for:

- eligibility, capability, license, health, budget, data-boundary, and risk gates;
- the candidate pool supplied to a decision provider;
- seeded shuffle or Chainlink VRF;
- score-ledger writes and reputation changes;
- Judge independence and permitted dispute routes;
- human review, wallet operations, permissions, funds, contracts, and settlement;
- final verification and release approval.

Laya and Jev may only recommend among host-supplied choices or return an expected score. A provider result is evidence, never authorization.

## 5. Architecture

### 5.1 Provider-neutral contract

Introduce a `SystemOneDecisionProvider` interface with three methods:

```ts
type SystemOneDecisionProvider = {
  provider: "laya" | "jev";
  match(decision: AgentMatchDecisionV1): Promise<SystemOneDecisionResult>;
  scoreQuality(decision: AgentQualityDecisionV1): Promise<SystemOneDecisionResult>;
  routeDispute(decision: DisputeRouteDecisionV1): Promise<SystemOneDecisionResult>;
};
```

The normalized observed result records provider, actual model revision, selected value or fractional expected score, probabilities, confidence, margin, latency, usage when available, and a hash of the normalized result. Provider-specific fields do not leak into Queen or Matcher code.

### 5.2 Laya provider

The Laya adapter runs only inside the local Agent Runner process. It loads a pinned local ONNX bundle from a configured directory, never downloads weights during a task, uses CPU by default, and exposes readiness separately from process health. Model files stay outside Git and browser bundles.

The initial implementation uses the verified English checkpoint because Agent Market sends bucketed English codes and descriptions. Multilingual or fine-tuned checkpoints require a separate frozen evaluation and new pinned hashes.

### 5.3 Jev provider

The Jev adapter remains server-side and uses the existing macOS Keychain-to-environment launch boundary. It sends only opaque references, HMACs, bucketed attributes, reason codes, and permitted choices. It never sends raw prompts, conversations, source code, local paths, wallets, credentials, or database rows.

The live response parser must accept fractional expected scores from `0` through `4`, while probability labels remain the discrete levels `0` through `4`.

### 5.4 Dual-shadow coordinator

The only new deployable mode in this phase is `dual-shadow`. For every eligible sampled decision:

1. Run the deterministic baseline.
2. Run Laya locally.
3. Optionally run Jev on the same sanitized state when the remote comparison budget and privacy policy allow it.
4. Normalize and validate both results.
5. Record agreement, disagreement, abstention, latency, model version, and result hashes.
6. Return the deterministic baseline to the host workflow regardless of provider output.

There is no `laya-primary` or `jev-primary` mode in this phase. A missing model, missing key, timeout, malformed distribution, out-of-pool choice, low confidence, low margin, or provider disagreement preserves the deterministic result.

## 6. Configuration and lifecycle

Configuration is explicit and defaults off:

```text
SYSTEM_ONE_SHADOW_MODE=off|dual-shadow
LAYA_MODEL_DIR=/absolute/pinned/model/path
LAYA_MODEL_REVISION=68f27dfe5a27a54fb2b1fefc432f43f972e90868
LAYA_TIMEOUT_MS=2000
JEV_SHADOW_ENABLED=false
JEV_SHADOW_TIMEOUT_MS=3000
```

`TYPESAFE_API_KEY` remains secret-only and is never stored in configuration files. Startup validates the Laya file hashes before marking the provider ready. Shutdown closes the ONNX session. Turning `SYSTEM_ONE_SHADOW_MODE=off` is the kill switch and must require no model or key.

## 7. Evaluation and promotion gates

The existing six synthetic cases remain contract tests, not accuracy evidence. Promotion requires a frozen, labeled, sanitized dataset drawn from Agent Market decision shapes with difficult and negative cases.

For each decision type compare deterministic baseline, Laya, and Jev on:

- exact choice accuracy or score MAE;
- selective accuracy after abstention;
- coverage and fallback rate;
- hard-filter and out-of-pool violations, both required to remain zero;
- Brier score and expected calibration error;
- p50/p95 latency and local memory use;
- Jev request volume and actual cost;
- critical false routes, required to remain zero.

No provider becomes authoritative until the frozen blind evaluation passes, thresholds are versioned, and a shadow observation window shows zero authority violations. High-risk disputes always retain human or host review even after promotion.

## 8. Evidence and privacy

Evidence stores only schema version, decision type and opaque ID, provider, policy and model versions, input-shape HMAC, result hash, confidence, margin, latency, usage, baseline agreement, accepted/abstained/fallback state, and fallback reason.

Evidence must not store API keys, raw prompts, private messages, source code, local paths, wallet identity, full Agent output, or production database records.

## 9. Deployment and rollback

This phase deploys to the local Agent Runner only. It creates no AWS, Cloudflare, database, chain, or paid shared resources. The ONNX bundle is pre-provisioned and hash-verified before launch. Production rollout order is:

1. fix the fractional-score parser;
2. add provider-neutral contracts and adapters under tests;
3. run the frozen offline comparison;
4. enable `dual-shadow` locally with zero authority;
5. observe and review Evidence;
6. decide in a later change whether either provider earns bounded authority.

Rollback sets `SYSTEM_ONE_SHADOW_MODE=off`, restarts the local runner, and optionally unloads the external model cache. The deterministic routing path remains unchanged throughout.

## 10. Acceptance criteria

- Node 22 tests and typechecks pass.
- A real fractional Jev score is accepted and normalized without rounding.
- Laya runs from the pinned local bundle without network access.
- Both providers reject malformed distributions and out-of-pool choices.
- Dual-shadow never changes the deterministic route, score ledger, dispute state, shuffle, permission, fund, wallet, or chain state.
- Missing Laya files and missing Jev credentials fail closed to the deterministic baseline.
- Evidence contains no forbidden raw or secret fields.
- No new AWS, Cloudflare, database, or chain resource is created.
