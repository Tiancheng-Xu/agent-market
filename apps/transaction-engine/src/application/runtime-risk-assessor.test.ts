import { randomUUID } from 'node:crypto';
import type { AgentManifest } from '@agent-market/shared-contracts';
import { describe, expect, it } from 'vitest';
import { createLocalStreamRuntime } from '../../../local-agent-runner/src/stream-runtime';
import { verifySignedRequest } from '../../../local-agent-runner/src/signing';
import { RuntimeRiskAssessor } from './runtime-risk-assessor';

const input = { taskId: randomUUID(), title: 'Task', description: 'Assess only', requirements: ['Evidence'], declaredPermissions: [], durationHours: 1, dependencyClasses: [] };
const env = { AGENT_RUNTIME_ORIGIN: 'http://127.0.0.1:8789', AGENT_RUNTIME_OWNER_KEY_ID: 'runtime-owner-test', AGENT_RUNTIME_OWNER_SECRET: 'test-owner-secret-not-production', RISK_ASSESSOR_AGENT_ID: 'configured-test-agent' };
// Protocol fixture only: no live Runtime, model, provider or assessment evidence is claimed.
const result = { factors: { complexity: 30, acceptanceAmbiguity: 30, externalDependency: 30, dataSensitivity: 30, financialRisk: 30, irreversibility: 30, deadlineRisk: 30, agentUncertainty: 30 }, reasonCodes: ['transport_fixture_only'] };
function transport(mode = 'valid'): typeof fetch {
  return async (url, init) => {
    const body = String(init?.body);
    expect(String(url)).toBe('http://127.0.0.1:8789/agent/chat');
    expect(verifySignedRequest('POST', '/agent/chat', body, new Headers(init?.headers), { keys: {
      [env.AGENT_RUNTIME_OWNER_KEY_ID]: { keyId: env.AGENT_RUNTIME_OWNER_KEY_ID, secret: env.AGENT_RUNTIME_OWNER_SECRET, allowedCallerScopes: ['owner'] },
    } }).ok).toBe(true);
    const parsed = JSON.parse(body);
    expect(parsed.messages[0].content).toContain('Assess task risk only');
    expect(new Headers(init?.headers).get('x-agent-caller-scope')).toBe('owner');
    if (mode === 'missing-provider') return Response.json({ code: 'MODEL_UNAVAILABLE' }, { status: 503 });
    const output = mode === 'invalid-json' ? 'not-json' : JSON.stringify(result);
    const events = [
      { event: 'meta', requestId: parsed.requestId, runId: randomUUID(), agentId: mode === 'wrong-agent' ? 'other' : parsed.agentId, provider: 'ollama', modelTag: 'fixture' },
      { event: 'delta', requestId: parsed.requestId, delta: output },
      ...(mode === 'truncated' ? [] : [{ event: 'done', requestId: parsed.requestId, outputBytes: Buffer.byteLength(output) }]),
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
}
describe('strict signed risk assessor transport (fixture, not provider evidence)', () => {
  it('is accepted end to end by a runtime configured with separate scoped keys', async () => {
    const runtime = createLocalStreamRuntime({
      manifests: [ownerManifest()],
      signingKeys: [
        { keyId: 'runtime-public-test', secret: 'test-public-secret-not-production', allowedCallerScopes: ['public'] },
        { keyId: env.AGENT_RUNTIME_OWNER_KEY_ID, secret: env.AGENT_RUNTIME_OWNER_SECRET, allowedCallerScopes: ['owner'] },
      ],
      ollamaClient: {
        chatStream: async (_request, onDelta) => {
          onDelta({ content: JSON.stringify(result), raw: {} });
        },
      },
    });
    const runtimeFetch: typeof fetch = async (url, init) => runtime.fetch(new Request(url, init));

    await expect(new RuntimeRiskAssessor(env, runtimeFetch).assess(input)).resolves.toEqual(result);
  });
  it('reuses the signed protocol and strict risk role', async () => {
    await expect(new RuntimeRiskAssessor(env, transport()).assess(input)).resolves.toEqual(result);
  });
  it.each(['missing-provider', 'invalid-json', 'wrong-agent', 'truncated'])('fails closed on %s without fallback scores', async mode => {
    await expect(new RuntimeRiskAssessor(env, transport(mode)).assess(input)).rejects.toThrow('RISK_ASSESSOR_RUNTIME_UNAVAILABLE');
  });
  it.each(['AGENT_RUNTIME_ORIGIN', 'AGENT_RUNTIME_OWNER_KEY_ID', 'AGENT_RUNTIME_OWNER_SECRET', 'RISK_ASSESSOR_AGENT_ID'])('names missing %s before transport', async key => {
    await expect(new RuntimeRiskAssessor({ ...env, [key]: '' }, async () => { throw new Error('must not call transport'); }).assess(input)).rejects.toThrow(`RISK_ASSESSOR_CONFIG_MISSING_${key}`);
  });
  it('does not fall back to the public shared key configuration', async () => {
    await expect(new RuntimeRiskAssessor({
      AGENT_RUNTIME_ORIGIN: env.AGENT_RUNTIME_ORIGIN,
      AGENT_RUNTIME_KEY_ID: 'edge-runtime-v1',
      AGENT_RUNTIME_SHARED_SECRET: 'legacy-public-secret',
      RISK_ASSESSOR_AGENT_ID: env.RISK_ASSESSOR_AGENT_ID,
    }, async () => { throw new Error('must not call transport'); }).assess(input))
      .rejects.toThrow('RISK_ASSESSOR_CONFIG_MISSING_AGENT_RUNTIME_OWNER_KEY_ID');
  });
  it('rejects nonlocal configured origins without network access', async () => {
    await expect(new RuntimeRiskAssessor({ ...env, AGENT_RUNTIME_ORIGIN: 'https://example.test' }, transport()).assess(input)).rejects.toThrow('RISK_ASSESSOR_CONFIG_INVALID_AGENT_RUNTIME_ORIGIN');
  });
});

function ownerManifest(): AgentManifest {
  return {
    id: env.RISK_ASSESSOR_AGENT_ID,
    displayName: 'Configured test owner agent',
    ownership: 'owner-trained',
    provider: 'ollama',
    capabilities: ['completion'],
    toolSchemas: [],
    model: {
      tag: 'configured-test-model',
      digest: 'test-model-digest',
      family: 'test',
      parameterSize: 'test',
      quantization: 'test',
      contextLength: 4096,
      source: 'test',
      license: 'test',
    },
    health: { status: 'online', lastVerifiedAt: '2026-09-09T00:00:00.000Z' },
    limits: { maxConcurrency: 1, timeoutMs: 120_000, maxPayloadBytes: 1_048_576 },
    access: { visibility: 'private', selectableBy: 'owner-only', ownerScope: 'local-runtime-owner' },
  };
}
