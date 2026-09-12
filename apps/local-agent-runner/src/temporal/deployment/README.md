# W10 production Runtime executable preparation

Status: preparation only, production blocked. No unit installed, service started,
cloud modified, or existing local service touched. No `.env` content was read.

## Repository evidence and reusable candidates

- `apps/local-agent-runner/package.json` has only `runtime:dev` ->
  `tsx src/runtime-server.ts`; there is no verified production start script.
- `runtime-server.ts` composes Node HTTP, provider manifests, HMAC signing and
  `openQueenRuntimePersistence`. It binds loopback and loads local development
  environment. This is reusable source, not an approved production entrypoint.
- `stream-runtime.ts` exposes `/healthz`; a health response alone does not prove
  a continuously polling Temporal consumer or authoritative approval readiness.
- `temporal/worker.ts` and `client.ts` register verified-local planning/approval
  work; injected SQL/ledger/saver lifecycles can be reused. Current Temporal config
  permits loopback only and does not wire production mTLS credentials.
- `apps/web/wrangler.jsonc` is a Web deployment candidate, not proof of a long-lived
  native Node/Temporal Runtime host. No account/address values were inspected.
- No existing Runner systemd, launchd, PM2, compose, Dockerfile or production host
  deployment success was found in the targeted repository configuration search.
  Service Dockerfiles elsewhere are for different components and were not reused.

Actual production host: **undetermined**. The supplied systemd unit is a proposed
Linux delivery option, not evidence that the user has a Linux host. Node/tsx is
reused; no heavy supervisor dependency is introduced. Parent task must select and
verify the host before adopting/installing the template. The temporary Temporal
SQLite server remains a development test resource only.

## Files and commands

`runtime-supervisor.mjs` uses Node built-ins. Supported actions are `preflight`,
`health`, `run` and `stop`, with an absolute policy JSON path as the second argument.
It prints fixed gate names/statuses, never environment values, raw probe output,
stack traces or endpoint addresses. Production code must log separately through
an approved sanitized channel; child stdout/stderr are not forwarded by this guard.

Reproduce the safe local preparation checks from the runner package:

```bash
pnpm exec vitest run src/temporal/deployment/runtime-supervisor.test.mjs
node src/temporal/deployment/runtime-supervisor.mjs preflight \
  "$PWD/src/temporal/deployment/runtime-supervisor.policy.example.json"
```

Tests: 3/3 pass. Empty-config preflight: expected exit 2. No passing production
probe, live auth/provider request, systemd installation or real supervisor start
has been validated. The `.service` template has not been verified on a selected
Linux host. `preparation.evidence.json` records only these limited results.

Parent-controlled deployment sequence, **not executed**:

1. Supply a reviewed production entry and eight reviewed host probe modules. Pin
   each exact file SHA-256 in the root-controlled policy; do not pin dev scripts
   as substitutes. Pin the release/dependency tree and make ancestors read-only.
2. Provision host service identity/directories, runtime secrets and authenticated
   production infrastructure independently. Adapt `/usr/bin/node`, release paths,
   `/etc/agent-market/runtime.env` and writable state path to that verified host.
3. Run preflight under the same user/environment as the service. Install the unit
   only after all gates pass and parent task approves the concrete deployment.
4. Parent runs `systemctl start agent-market-runtime.service`; the template runs
   preflight and foreground guard, with restart rate limits and group termination.
5. Parent runs the guard's `health` action with the same environment, and systemd
   status separately. Runtime health additionally requires `consumerReady=true`.
6. Parent stops only this unit with `systemctl stop agent-market-runtime.service`
   (or guard `stop /absolute/policy.json`). Stop does not depend on healthy secrets
   or policy, and targets no other service. No script runs daemon-reload or enable.

The guard checks before spawning and periodically while running, with one bounded
probe at a time, no overlapping monitor loop. A failed health gate SIGTERMs the
child; systemd's group stop timeout bounds final cleanup. This is not zero-latency
revocation: application request authorization must recheck revoked/expired grants
on every protected operation. Public routing must consult health and reject until
the authenticated consumer is ready; process start alone cannot open routing.

## Required keys (values never included in evidence)

Existing Runtime keys required by the guard:

```text
AGENT_RUNTIME_PUBLIC_KEY_ID
AGENT_RUNTIME_PUBLIC_SECRET
AGENT_RUNTIME_OWNER_KEY_ID
AGENT_RUNTIME_OWNER_SECRET
QUEEN_PUBLIC_DATABASE_URL
QUEEN_OWNER_DATABASE_URL
QUEEN_CHECKPOINT_DATABASE_URL
QUEEN_CHECKPOINT_SCHEMA
QUEEN_TEMPORAL_ADDRESS
QUEEN_TEMPORAL_NAMESPACE
QUEEN_TEMPORAL_TASK_QUEUE
```

Proposed deployment-contract keys, not yet wired into the existing Runtime:

```text
AGENT_RUNTIME_PRODUCTION_ENABLED=true
AGENT_RUNTIME_PUBLIC_ORIGIN
QUEEN_TEMPORAL_TLS_CA_FILE
QUEEN_TEMPORAL_TLS_CERT_FILE
QUEEN_TEMPORAL_TLS_KEY_FILE
AGENT_RUNTIME_REVOCATION_URL
AGENT_RUNTIME_PROVIDER_SIGNING_KEY_ID
```

The actual production entry must consume/configure these correctly. Their presence
does not prove enforcement; the relevant independent probes must verify it.
The guard rejects forced `QUEEN_ASYNC_WORKER_READY=true` and
`QUEEN_ASYNC_PLANNING_ENABLED=true` and never sets either. Local planning/Temporal
opt-in choices belong in the reviewed entry/config, not inferred from readiness.

Existing provider catalog candidates use configured credentials such as
`DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`/`KIMI_API_KEY`,
`QWEN_API_KEY`/`DASHSCOPE_API_KEY`, `ZHIPU_API_KEY`/`ZAI_API_KEY`/`BIGMODEL_API_KEY`.
Select only the providers actually used. Those API tokens do not by themselves
prove request signature, scope binding, key rotation or revocation requirements.

## Independent host probe contract

All eight `policy.probes.<gate>.path` and `.sha256` pairs are required, as are
`entry.path`, `entry.sha256`, `entry.args`, `cwd`, `healthIntervalSeconds`,
`service=agent-market-runtime`, `environment=production`, `version=1`.
The example intentionally leaves entry/probe paths empty so it cannot start.
All policy/entry/probe files must reject group/world writes. Host installation
must protect parent directories and dependencies; file hashing alone cannot
protect a writable runtime or malicious trusted host administrator.

Each probe is a reviewed server-only Node module invoked with `--mode preflight`
or `--mode health`, and `--challenge <nonce>`, timeout 10 seconds. It returns one
JSON object with service, gate, mode, challenge, observedAt (within 30 seconds),
entrySha256, verified=true and the following checks. The supervisor never accepts
cached JSON files or environment booleans as probe success. A pinned script is a
trust boundary, not magical verification: each implementation must perform the
actual independent negative/positive checks and be reviewed by the parent.

| Gate | Required checks |
| --- | --- |
| tls | certificateValid, hostnameVerified, plaintextRejected |
| authentication | unsignedRejected, wrongScopeRejected, replayRejected |
| database | tlsVerified, leastPrivilege, schemasReady, checkpointBindingVerified |
| temporal | tlsVerified, authenticated, namespaceAuthorized, durableStorage, notDevServer |
| backup | encrypted, restoreVerified, rpoMet, rtoMet |
| providerSigning | requestSignatureVerified, keyIdentityVerified, payloadScopeBound |
| revocation | expiredRejected, revokedRejected, rotationVerified |
| readiness | dependenciesChecked, failsClosed, noForcedReady, consumerConfigured; health also consumerReady |

Backup provider/location, encryption key reference, restore evidence source,
maximum restore-evidence age and RPO/RTO targets are missing external decisions.
The backup probe must resolve actual approved policy and fresh restore evidence,
not create backups or resources as a side effect. Auth/revocation/signature probes
must use isolated approved canary identities; never mutate real orders. Preflight
readiness verifies the configured consumer and default-deny routing policy without
claiming a process is already running. Health verifies actual authorized polling.

No host probes are fabricated here because no production endpoints, backup policy,
supervisor host or production entry have been established. All remain blocked.

## Parent-reported limited host inventory

The parent task supplied a read-only observation, not independently rechecked by
this worker: process inventory using only PID/comm found an Ollama application
process and two Temporal binaries. The binary at
`/tmp/agent-market-temporal.m7smAO/temporal` belongs to the task test service. The
binary at `/tmp/am-temporal-tools-20260909/temporal` has unknown ownership and must
not be stopped. An executable path alone is not authority over a running process.

No cloudflared process was found in that inventory. A filename-filtered search
of `~/Library/LaunchAgents`, maximum depth 1, using agent*market/cloudflared/ollama/
queen/temporal names found no matching files. This limited observation does not
establish that all production hosts, tunnels or service configurations are absent.
The Ollama process does not establish a production Runtime or Tunnel.

W10 remains blocked on an identified production host and secret/configuration
delivery. No additional placeholder probes or simulated readiness were added.
No cloud, system service or existing process was changed for this evidence update.
