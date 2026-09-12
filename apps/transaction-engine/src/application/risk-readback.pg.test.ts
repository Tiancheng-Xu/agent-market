import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { PostgresRiskTaskSource } from './postgres-risk-task-source';
import { PostgresRiskQuoteStore } from './risk-quote-store';
import { RiskPricingService, type RiskQuoteReadback } from './risk-pricing-service';
import { createRiskQuoteHandler, createRiskQuoteReadHandler } from '../app/api/tasks/[taskId]/risk-quote/route';
import { createRiskQuoteConfirmationHandler } from '../app/api/tasks/[taskId]/risk-quote/confirm/route';
import { getOrderRuntime, resetOrderRuntimeForTests } from './order-runtime';

// Real PostgreSQL authority/persistence gate. The assessor is a named fixture, not a provider receipt.
const url = process.env.COMMERCIAL_TEST_DATABASE_URL;
const owner = '0x1111111111111111111111111111111111111111';
const agentWallet = '0x2222222222222222222222222222222222222222';
const outsider = '0x3333333333333333333333333333333333333333';
const token = '0x5555555555555555555555555555555555555555';
const asset = `eip155:11155111/erc20:${token}`;
const taskId = randomUUID(), agentId = randomUUID(), bindingId = randomUUID();
let sql: ReturnType<typeof postgres>;
let service: RiskPricingService;
let clock = Date.now();
const origin = new URL('https://example.test');
const auth = (wallet: string) => ({ authenticateSession: async () => ({ walletAddress: wallet }) });
const request = (body?: unknown) => new Request(`${origin}/api/tasks/${taskId}/risk-quote`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { cookie: '__Host-agent_market_session=fixture', origin: origin.origin, 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const read = (wallet = owner) => createRiskQuoteReadHandler({ service, auth: auth(wallet) })(request(), taskId);
const readBody = async (wallet = owner) => {
  const response = await read(wallet); expect(response.status).toBe(200);
  return response.json();
};
async function issue(wallet = owner) {
  const { context } = await readBody(wallet);
  return createRiskQuoteHandler({ service, auth: auth(wallet), authOrigin: origin })(request({ taskFingerprint: context.taskFingerprint }), taskId);
}
const confirm = (quote: RiskQuoteReadback, wallet: string) => createRiskQuoteConfirmationHandler({ service, auth: auth(wallet), authOrigin: origin })(request({
  quoteId: quote.quoteId,
  quoteHash: quote.quoteHash,
  taskFingerprint: quote.quote.taskFingerprint,
  ...(wallet === owner
    ? { actorType: 'publisher' as const }
    : { actorType: 'agent' as const, agentId }),
}), taskId);

// An isolated schema reset only inside the explicitly dedicated disposable database.
describe.skipIf(!url)('risk readback real PG targeted gate', () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (parsed.hostname !== '127.0.0.1' || parsed.port !== '55439' || parsed.pathname !== '/am_commercial_test') throw new Error('UNSAFE_TEST_DATABASE');
    sql = postgres(url!, { max: 8, prepare: false, onnotice: () => {} });
    await sql.unsafe(`DROP SCHEMA IF EXISTS agent_market CASCADE; CREATE SCHEMA agent_market;
      CREATE TABLE agent_market.tasks(id uuid PRIMARY KEY,publisher_wallet text,budget_atomic numeric(78,0),version int,status text,title text,description text,requirements text[]);
      CREATE TABLE agent_market.agents(id uuid PRIMARY KEY,owner_wallet text,status text);
      CREATE TABLE agent_market.task_risk_contexts(task_id uuid,task_version int,policy_version text,declared_permissions text[],duration_hours numeric,dependency_classes text[],status text);
      CREATE TABLE agent_market.queen_workflows(task_id uuid,record_version int,graph_revision int,snapshot jsonb);
      CREATE TABLE agent_market.task_graph_pricing_versions(task_id uuid,graph_revision int,workflow_record_version int,policy_version text);
      CREATE TABLE agent_market.runtime_agent_bindings(id uuid,runtime_agent_id text,market_agent_id uuid,status text);
      CREATE TABLE agent_market.task_graph_node_pricing_facts(task_id uuid,graph_revision int,node_id text,runtime_agent_id text,binding_id uuid,market_agent_id uuid,share_bps int,node_risk_multiplier_bps int,reputation_risk_multiplier_bps int);`);
    for (const migration of ['0015_l2_risk_pricing.sql', '0023_risk_quote_asset.sql']) {
      const migrationSql = readFileSync(new URL(`../../../../database/migrations/${migration}`, import.meta.url), 'utf8')
        .replace(/^BEGIN;\s*$/gmu, '').replace(/^COMMIT;\s*$/gmu, '');
      await sql.begin(async tx => { await tx.unsafe(migrationSql); });
    }
  });
  afterAll(async () => { vi.unstubAllEnvs(); if (sql) await sql.end(); });
  beforeEach(async () => {
    clock = Date.now();
    await sql.unsafe('TRUNCATE agent_market.tasks CASCADE; TRUNCATE agent_market.agents,agent_market.task_risk_contexts,agent_market.queen_workflows,agent_market.task_graph_pricing_versions,agent_market.runtime_agent_bindings,agent_market.task_graph_node_pricing_facts');
    await sql`INSERT INTO agent_market.tasks VALUES(${taskId},${owner},1000,1,'funded','Task','Deliver evidence',ARRAY['Evidence'])`;
    await sql`INSERT INTO agent_market.agents VALUES(${agentId},${agentWallet},'published')`;
    await sql`INSERT INTO agent_market.task_risk_contexts VALUES(${taskId},1,'risk-v1',ARRAY[]::text[],1,ARRAY[]::text[],'active')`;
    const graph = { taskId, graphRevision: 1, requiredStages: ['requirement','graph','ranking','acceptance','execution','judge','final_arbitration','delivery'], riskLevel: 'medium', startPolicy: 'manualRequired',
      nodes: [{ nodeId: 'deliver', type: 'deliver', title: 'Deliver', dependencies: [], required: true, contract: { schemaVersion: '1', contextInputs: [], outputKeys: ['result'], artifactMediaTypes: ['application/json'], milestone: 'Deliver', acceptanceCriteria: ['Evidence'], budgetAtomic: '1000', permissions: ['read_context'], timeoutSeconds: 300, failureRoute: 'stop' } }],
      edges: [], rescuePolicy: { mode: 'auto', visibleToUser: false, evidenceVisible: true } };
    graph.nodes.unshift({ ...graph.nodes[0]!, nodeId: 'plan', type: 'plan', title: 'Plan', required: false });
    const snapshot = { taskId, recordVersion: 1, graph, graphConfirmedRevision: 1, assignments: [['deliver', { nodeId: 'deliver', selectedAgentId: 'runtime-test', status: 'accepted', selectedBy: 'queen', acceptedAt: new Date(clock).toISOString(), override: false, riskCodes: [] }]] };
    await sql`INSERT INTO agent_market.queen_workflows VALUES(${taskId},1,1,${sql.json(snapshot)})`;
    await sql`INSERT INTO agent_market.task_graph_pricing_versions VALUES(${taskId},1,1,'pricing-v1')`;
    await sql`INSERT INTO agent_market.runtime_agent_bindings VALUES(${bindingId},'runtime-test',${agentId},'active')`;
    await sql`INSERT INTO agent_market.task_graph_node_pricing_facts VALUES(${taskId},1,'deliver','runtime-test',${bindingId},${agentId},10000,10000,10000)`;
    service = new RiskPricingService({ tasks: new PostgresRiskTaskSource(sql), quotes: new PostgresRiskQuoteStore(sql), assetId: () => asset, now: () => new Date(clock),
      assessor: { assess: async () => ({ factors: { complexity: 30, acceptanceAmbiguity: 30, externalDependency: 30, dataSensitivity: 30, financialRisk: 30, irreversibility: 30, deadlineRisk: 30, agentUncertainty: 30 }, reasonCodes: ['pg_fixture_only'] }) } });
  });

  it('two wallets load one quote and confirm its exact hash without issuing on GET', async () => {
    expect((await readBody()).quote).toBeNull();
    expect((await issue()).status).toBe(201);
    const publisher = await readBody(), agent = await readBody(agentWallet);
    expect(agent.quote).toEqual(publisher.quote);
    expect(publisher.context.activeQuote).toEqual({ quoteId: publisher.quote.quoteId, version: 1, quoteHash: publisher.quote.quoteHash });
    expect((await confirm(publisher.quote, owner)).status).toBe(200);
    expect((await readBody()).context.quoteStatus).toBe('active');
    expect((await confirm(agent.quote, agentWallet)).status).toBe(200);
    const final = await readBody();
    expect(final.context.quoteStatus).toBe('confirmed');
    expect(final.quote).toEqual(publisher.quote);
  });

  it('same-fingerprint explicit reprice revokes old hash and never inherits confirmed', async () => {
    await issue(); const previous = (await readBody()).quote;
    await confirm(previous, owner); await confirm(previous, agentWallet);
    clock += 1000;
    expect((await issue()).status).toBe(201);
    const next = await readBody();
    expect(next.quote.quote.taskFingerprint).toBe(previous.quote.taskFingerprint);
    expect(next.quote.version).toBe(2); expect(next.quote.quoteHash).not.toBe(previous.quoteHash);
    expect(next.context.quoteStatus).toBe('active');
    expect((await confirm(previous, owner)).status).toBe(409);
    expect((await confirm({ ...next.quote, quoteHash: previous.quoteHash }, owner)).status).toBe(409);
  });

  it('parallel GETs preserve identity, expiry and version count', async () => {
    await issue(); const initial = await readBody();
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => readBody(i % 2 ? owner : agentWallet)));
    expect(results.every(result => JSON.stringify(result.quote) === JSON.stringify(initial.quote))).toBe(true);
    expect(Number((await sql`SELECT count(*) AS count FROM agent_market.risk_quotes`)[0]!.count)).toBe(1);
  });

  it('Agent may read but cannot reprice; outsiders and unauthenticated reads are rejected', async () => {
    await issue(); expect((await issue(agentWallet)).status).toBe(403);
    expect((await read(outsider)).status).toBe(403);
    const noSession = await createRiskQuoteReadHandler({ service, auth: auth(owner) })(new Request(origin), taskId);
    expect(noSession.status).toBe(401);
    expect((await confirm((await readBody()).quote, outsider)).status).toBe(403);
  });

  it('expiry never returns confirmed and prevents another confirmation', async () => {
    await issue(); const quote = (await readBody()).quote;
    await confirm(quote, owner); await confirm(quote, agentWallet);
    clock = Date.parse(quote.quote.expiresAt);
    expect((await readBody()).context.quoteStatus).toBe('expired');
    expect((await confirm(quote, owner)).status).toBe(409);
  });

  it('wallet revocation invalidates authority, and stale fingerprint cannot remain confirmed', async () => {
    await issue(); const quote = (await readBody()).quote;
    await confirm(quote, owner); await confirm(quote, agentWallet);
    await sql`UPDATE agent_market.agents SET owner_wallet = ${outsider} WHERE id = ${agentId}`;
    expect((await read(agentWallet)).status).toBe(403);
    expect((await confirm(quote, agentWallet)).status).toBe(403);
    expect((await readBody()).context.quoteStatus).toBe('superseded');
    expect((await confirm(quote, owner)).status).toBe(409);
  });

  it('retired binding, external halt and task version drift fail closed', async () => {
    await issue(); const quote = (await readBody()).quote;
    await sql`UPDATE agent_market.runtime_agent_bindings SET status='retired'`;
    expect((await read()).status).toBe(503);
    expect((await confirm(quote, owner)).status).not.toBe(200);
    await sql`UPDATE agent_market.runtime_agent_bindings SET status='active'`;
    await sql`UPDATE agent_market.tasks SET status='manual_review'`;
    expect((await read()).status).toBe(503);
    await sql`UPDATE agent_market.tasks SET status='funded',version=2`;
    expect((await read()).status).toBe(503);
  });

  it('legacy quote remains readable, requires reprice and cannot confirm', async () => {
    await issue(); const q = (await readBody()).quote;
    await sql`DELETE FROM agent_market.risk_quotes`;
    const { schemaVersion: _version, assetId: _asset, ...legacy } = q.quote;
    await sql`INSERT INTO agent_market.risk_quotes(id,task_id,quote_version,phase,task_fingerprint,dag_revision,policy_version,basis_fingerprint,quote_payload,manual_review_required,expires_at,status,created_at)
      VALUES(${q.quoteId},${taskId},1,'final',${legacy.taskFingerprint},1,${legacy.policyVersion},${q.quoteHash},${sql.json(legacy)},false,${legacy.expiresAt},'active',${new Date(clock).toISOString()})`;
    const readback = await readBody(); expect(readback.context.quoteStatus).toBe('requote_required');
    expect(readback.quote.quote).not.toHaveProperty('assetId');
    expect((await confirm(readback.quote, owner)).status).toBe(409);
  });

  it('actual order Runtime has an assessor and names missing config without creating a quote', async () => {
    vi.stubEnv('DATABASE_URL', url!); vi.stubEnv('AGENT_MARKET_YD_TOKEN_ADDRESS', token);
    vi.stubEnv('COMMERCIAL_ASSET_ID', asset); vi.stubEnv('AGENT_RUNTIME_ORIGIN', '');
    resetOrderRuntimeForTests();
    const runtime = getOrderRuntime();
    try {
      const context = await runtime.riskPricing.readRiskContext({ taskId, actorWallet: owner });
      await expect(runtime.riskPricing.issueQuote({ taskId, actorWallet: owner, expectedTaskFingerprint: context.taskFingerprint }))
        .rejects.toThrow('RISK_ASSESSOR_CONFIG_MISSING_AGENT_RUNTIME_ORIGIN');
      expect(Number((await sql`SELECT count(*) AS count FROM agent_market.risk_quotes`)[0]!.count)).toBe(0);
    } finally { await runtime.sql.end(); resetOrderRuntimeForTests(); vi.unstubAllEnvs(); }
  });
});
