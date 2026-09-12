import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { audit, gates, requiredEnv } from './runtime-supervisor.mjs';

test('unconfigured production checks fail independently without starting or connecting', async () => {
  const result = await audit(fileURLToPath(new URL('./runtime-supervisor.policy.example.json', import.meta.url)), 'preflight', {});
  assert.equal(result.passed, false);
  for (const gate of Object.keys(gates)) assert.equal(result.checks.find(item => item.gate === gate)?.passed, false);
  for (const key of requiredEnv) assert.equal(result.checks.find(item => item.gate === `env:${key}`)?.passed, false);
  assert.equal(result.checks.find(item => item.gate === 'reviewed-entry')?.passed, false);
});
test('requires separate public and owner runtime signing configuration', () => {
  for (const key of ['AGENT_RUNTIME_PUBLIC_KEY_ID', 'AGENT_RUNTIME_PUBLIC_SECRET',
    'AGENT_RUNTIME_OWNER_KEY_ID', 'AGENT_RUNTIME_OWNER_SECRET']) {
    assert.equal(requiredEnv.includes(key), true);
  }
  assert.equal(requiredEnv.includes('AGENT_RUNTIME_KEY_ID'), false);
  assert.equal(requiredEnv.includes('AGENT_RUNTIME_SHARED_SECRET'), false);
});
test('invalid policy and forced readiness never pass; diagnostics exclude values', async () => {
  const result = await audit('/nonexistent-agent-market-supervisor-policy', 'health', {
    QUEEN_ASYNC_WORKER_READY: 'true', AGENT_RUNTIME_SHARED_SECRET: 'private-sentinel',
    AGENT_RUNTIME_PUBLIC_ORIGIN: 'http://private-host.invalid',
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.find(item => item.gate === 'no-forced-readiness')?.passed, false);
  const diagnostic = JSON.stringify(result.checks);
  assert.equal(diagnostic.includes('private-sentinel'), false);
  assert.equal(diagnostic.includes('private-host'), false);
});
