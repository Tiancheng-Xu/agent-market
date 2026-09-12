import { randomUUID } from 'node:crypto';
import { LiveChatRequestSchema, LiveChatSseEventSchema, type RiskAssessmentInput } from '@agent-market/shared-contracts';
import { assessTaskRisk } from '../../../local-agent-runner/src/risk-assessor';
import { signedHeaders, signRequest } from '../../../local-agent-runner/src/signing';
import { RiskPricingServiceError, type RiskAssessorClient } from './risk-pricing-service';

// Reuse the running signed local Runtime, never invoke a fallback or invent a model.
export class RuntimeRiskAssessor implements RiskAssessorClient {
  constructor(private readonly env: Readonly<Record<string, string | undefined>> = process.env, private readonly transport: typeof fetch = fetch) {}

  async assess(input: RiskAssessmentInput) {
    const required = (key: string) => {
      const value = this.env[key]?.trim();
      if (!value) throw new RiskPricingServiceError(`RISK_ASSESSOR_CONFIG_MISSING_${key}`, 503);
      return value;
    };
    const origin = required('AGENT_RUNTIME_ORIGIN');
    const ownerKeyId = required('AGENT_RUNTIME_OWNER_KEY_ID');
    const ownerSecret = required('AGENT_RUNTIME_OWNER_SECRET');
    const agentId = required('RISK_ASSESSOR_AGENT_ID');
    let url: URL;
    try {
      url = new URL(origin);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid');
    } catch { throw new RiskPricingServiceError('RISK_ASSESSOR_CONFIG_INVALID_AGENT_RUNTIME_ORIGIN', 503); }
    try {
      return await assessTaskRisk(input, async ({ messages }) => {
        const requestId = randomUUID();
        const body = JSON.stringify(LiveChatRequestSchema.parse({ agentId, messages, requestId }));
        const assertion = signRequest('POST', '/agent/chat', body, {
          key: { keyId: ownerKeyId, secret: ownerSecret, allowedCallerScopes: ['owner'] }, callerScope: 'owner',
        });
        const response = await this.transport(new URL('/agent/chat', url), {
          method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(120_000),
          headers: { ...signedHeaders(assertion), 'content-type': 'application/json' },
        });
        if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
          throw new Error('runtime unavailable');
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', output = '', bytes = 0, meta = false, done = false;
        const consume = (frame: string) => {
          const lines = frame.split('\n').filter(line => line.startsWith('data:'));
          if (!lines.length) return;
          if (done) throw new Error('event after completion');
          const event = LiveChatSseEventSchema.parse(JSON.parse(lines.map(line => line.slice(5).trimStart()).join('\n')));
          if (event.event === 'error') throw new Error('runtime assessment failed');
          if (event.requestId !== requestId) throw new Error('request mismatch');
          if (event.event === 'meta') {
            if (meta || event.agentId !== agentId) throw new Error('agent mismatch');
            meta = true;
          } else {
            if (!meta) throw new Error('missing identity');
            if (event.event === 'delta') output += event.delta;
            if (event.event === 'done') {
              if (event.outputBytes !== Buffer.byteLength(output)) throw new Error('output mismatch');
              done = true;
            }
          }
        };
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 131_072) throw new Error('assessment too large');
            buffer += decoder.decode(chunk.value, { stream: true });
            buffer = buffer.replace(/\r\n/g, '\n');
            let end: number;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              consume(buffer.slice(0, end)); buffer = buffer.slice(end + 2);
            }
          }
          if (!done || buffer.trim()) throw new Error('incomplete assessment');
          return output;
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      });
    } catch { throw new RiskPricingServiceError('RISK_ASSESSOR_RUNTIME_UNAVAILABLE', 503); }
  }
}
