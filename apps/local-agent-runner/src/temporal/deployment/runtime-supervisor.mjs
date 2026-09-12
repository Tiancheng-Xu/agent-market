import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
export const gates = {
  tls: ['certificateValid', 'hostnameVerified', 'plaintextRejected'],
  authentication: ['unsignedRejected', 'wrongScopeRejected', 'replayRejected'],
  database: ['tlsVerified', 'leastPrivilege', 'schemasReady', 'checkpointBindingVerified'],
  temporal: ['tlsVerified', 'authenticated', 'namespaceAuthorized', 'durableStorage', 'notDevServer'],
  backup: ['encrypted', 'restoreVerified', 'rpoMet', 'rtoMet'],
  providerSigning: ['requestSignatureVerified', 'keyIdentityVerified', 'payloadScopeBound'],
  revocation: ['expiredRejected', 'revokedRejected', 'rotationVerified'],
  readiness: ['dependenciesChecked', 'failsClosed', 'noForcedReady', 'consumerConfigured'],
};
export const requiredEnv = ['AGENT_RUNTIME_PRODUCTION_ENABLED', 'AGENT_RUNTIME_PUBLIC_ORIGIN',
  'AGENT_RUNTIME_PUBLIC_KEY_ID', 'AGENT_RUNTIME_PUBLIC_SECRET',
  'AGENT_RUNTIME_OWNER_KEY_ID', 'AGENT_RUNTIME_OWNER_SECRET', 'QUEEN_PUBLIC_DATABASE_URL',
  'QUEEN_OWNER_DATABASE_URL', 'QUEEN_CHECKPOINT_DATABASE_URL', 'QUEEN_CHECKPOINT_SCHEMA',
  'QUEEN_TEMPORAL_ADDRESS', 'QUEEN_TEMPORAL_NAMESPACE', 'QUEEN_TEMPORAL_TASK_QUEUE',
  'QUEEN_TEMPORAL_TLS_CA_FILE', 'QUEEN_TEMPORAL_TLS_CERT_FILE', 'QUEEN_TEMPORAL_TLS_KEY_FILE',
  'AGENT_RUNTIME_REVOCATION_URL', 'AGENT_RUNTIME_PROVIDER_SIGNING_KEY_ID'];
const assert = (value) => { if (!value) throw new Error('INVALID'); };
const digest = value => createHash('sha256').update(value).digest('hex');
async function pinned(descriptor) {
  assert(descriptor && isAbsolute(descriptor.path) && /^[a-f0-9]{64}$/.test(descriptor.sha256));
  const metadata = await stat(descriptor.path);
  assert(metadata.isFile() && (metadata.mode & 0o022) === 0);
  assert(digest(await readFile(descriptor.path)) === descriptor.sha256);
}
async function policy(path) {
  assert(isAbsolute(path));
  const metadata = await stat(path);
  assert(metadata.isFile() && (metadata.mode & 0o022) === 0);
  const value = JSON.parse(await readFile(path, 'utf8'));
  assert(value.version === 1 && value.service === 'agent-market-runtime');
  assert(value.environment === 'production');
  assert(isAbsolute(value.cwd) && Array.isArray(value.entry?.args));
  // Arguments must contain only explicitly reviewed nonsecret entrypoint options.
  assert(value.entry.args.every(item => typeof item === 'string' && item.length < 512));
  assert(Number.isInteger(value.healthIntervalSeconds) && value.healthIntervalSeconds >= 10 && value.healthIntervalSeconds <= 300);
  return value;
}

export async function audit(path, mode, env = process.env) {
  const checks = [];
  for (const name of requiredEnv) checks.push({ gate: `env:${name}`, passed: Boolean(env[name]?.trim()) });
  checks.push({ gate: 'explicit-production-opt-in', passed: env.AGENT_RUNTIME_PRODUCTION_ENABLED === 'true' });
  checks.push({ gate: 'no-forced-readiness', passed: env.QUEEN_ASYNC_WORKER_READY !== 'true' && env.QUEEN_ASYNC_PLANNING_ENABLED !== 'true' });
  for (const name of ['AGENT_RUNTIME_PUBLIC_ORIGIN', 'AGENT_RUNTIME_REVOCATION_URL']) {
    let passed = false;
    try { const url = new URL(env[name]); passed = url.protocol === 'https:' && !url.username && !url.password; } catch {}
    checks.push({ gate: `https:${name}`, passed });
  }
  let config;
  try { config = await policy(path); } catch {
    return { passed: false, checks: [...checks, { gate: 'production-policy', passed: false }], config: undefined };
  }
  try { await pinned(config.entry); checks.push({ gate: 'reviewed-entry', passed: true }); }
  catch { checks.push({ gate: 'reviewed-entry', passed: false }); }
  // All gates are independent and bounded. A boolean env value is never evidence.
  for (const [gate, requirements] of Object.entries(gates)) {
    let passed = false;
    try {
      const probe = config.probes?.[gate];
      await pinned(probe);
      const challenge = randomUUID();
      const { stdout } = await execute(process.execPath, [probe.path, '--mode', mode, '--challenge', challenge], {
        env, cwd: config.cwd, timeout: 10000, maxBuffer: 32768,
      });
      const result = JSON.parse(stdout);
      const age = Date.now() - Date.parse(result.observedAt);
      passed = result.service === config.service && result.gate === gate && result.mode === mode
        && result.challenge === challenge && result.entrySha256 === config.entry.sha256
        && result.verified === true && age >= 0 && age <= 30000
        && requirements.every(key => result.checks?.[key] === true)
        && (gate !== 'readiness' || mode !== 'health' || result.checks?.consumerReady === true);
    } catch { /* Never expose probe output, endpoint, credentials or stack traces. */ }
    checks.push({ gate, passed });
  }
  return { passed: checks.every(check => check.passed), checks, config };
}

async function main() {
  const [action, path] = process.argv.slice(2);
  if (process.argv.length !== 4 || !['preflight', 'health', 'run', 'stop'].includes(action)) throw new Error('USAGE');
  if (action === 'stop') {
    // Fixed project unit only. Do not require healthy configuration to stop it.
    assert(process.platform === 'linux');
    await execute('systemctl', ['stop', 'agent-market-runtime.service'], { timeout: 45000, maxBuffer: 32768 });
    process.stdout.write('{"service":"agent-market-runtime","action":"stop","accepted":true}\n');
    return;
  }
  const result = await audit(path, action === 'health' ? 'health' : 'preflight');
  process.stdout.write(JSON.stringify({ service: 'agent-market-runtime', action, passed: result.passed, checks: result.checks }) + '\n');
  if (!result.passed) { process.exitCode = 2; return; }
  if (action !== 'run') return;
  // Foreground process supervised by the systemd template. No shell evaluation,
  // readiness env injection, detached child, log forwarding or implicit install.
  const child = spawn(process.execPath, [result.config.entry.path, ...result.config.entry.args], {
    cwd: result.config.cwd, env: process.env, stdio: 'ignore',
  });
  let stopping = false;
  const stop = () => { if (!stopping) { stopping = true; child.kill('SIGTERM'); } };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  let timer;
  const monitor = async () => {
    const health = await audit(path, 'health');
    process.stdout.write(JSON.stringify({ service: 'agent-market-runtime', action: 'health', passed: health.passed, checks: health.checks }) + '\n');
    if (!health.passed) stop();
    else if (!stopping) timer = setTimeout(monitor, result.config.healthIntervalSeconds * 1000);
  };
  timer = setTimeout(monitor, result.config.healthIntervalSeconds * 1000);
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  stopping = true; clearTimeout(timer);
  // Even a clean unexpected child exit requires explicit supervisor attention.
  process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stderr.write('{"service":"agent-market-runtime","passed":false,"code":"SUPERVISOR_ACTION_FAILED"}\n'); process.exitCode = 2; });
}
