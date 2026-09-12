import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommercialService, type Database, type Query, type ObservationReader } from './service';
import { createCommercialHandler } from './http';
import { MemoryRiskQuoteStore, PostgresRiskQuoteStore } from '../application/risk-quote-store';
import { assessRisk, createRiskQuote } from '../application/risk-engine';
import { fingerprintRiskTask, type AuthoritativeRiskTask } from '../application/risk-pricing-service';

const owner = `0x${'1'.repeat(40)}`, worker = `0x${'2'.repeat(40)}`, other = `0x${'3'.repeat(40)}`;
const platform = `0x${'4'.repeat(40)}`;
const agent = randomUUID(), task = randomUUID();
let quoteId: string;
let quoteHash: string;
let riskMaterial: unknown;
let team: NonNullable<AuthoritativeRiskTask['dag']>['assignments'];
let pg: Pick<PGlite, 'exec' | 'query' | 'close'>;
const realUrl = process.env.COMMERCIAL_TEST_DATABASE_URL;
let sql: ReturnType<typeof postgres> | undefined;
let service: CommercialService;
const policy = { assetId: 'eip155:11155111/erc20:0x5555555555555555555555555555555555555555', platformWallet: platform, feeBps: 1000 };
const create = { type: 'create', children: [{ id: 'a', agentId: agent, budgetAtomic: '600' }, { id: 'b', agentId: agent, budgetAtomic: '400' }] };
const artifact = { id: randomUUID(), uri: 'https://example.test/work', contentHash: `sha256:${'a'.repeat(64)}`, mediaType: 'text/plain', sizeBytes: 10, submittedAt: '2026-09-09T00:00:00Z' };
let db: Database;
const exec = (actor: string, body: unknown, key: string = randomUUID()) => service.execute(task, actor, key, body);

function riskMaterialFixture(children: readonly { id: string; agentId: string; budgetAtomic: string }[] = create.children, revision = 1) {
  const nodes = children.map((child, index) => ({
    nodeId: child.id,
    type: index === 0 ? 'plan' : 'deliver',
    title: child.id,
    dependencies: index === 0 ? [] : [children[index - 1]!.id],
    required: true,
    contract: { schemaVersion: '1', contextInputs: [], outputKeys: ['result'], artifactMediaTypes: ['text/plain'], milestone: 'Delivered', acceptanceCriteria: ['Complete'], budgetAtomic: child.budgetAtomic, permissions: [], timeoutSeconds: 300, failureRoute: 'stop' },
  }));
  const agentFor = (index: number) => team[Math.min(index, team.length - 1)]!;
  return {
    contexts: [{ value: { policy_version: 'risk-context-v1', declared_permissions: [] } }],
    workflows: [{
      graph: { taskId: task, graphRevision: revision, requiredStages: ['requirement','graph','ranking','acceptance','execution','judge','final_arbitration','delivery'], riskLevel: 'medium', startPolicy: 'manualRequired', nodes, edges: [{ from: 'a', to: 'b', condition: 'approved' }], rescuePolicy: { mode: 'auto', visibleToUser: false, evidenceVisible: true } },
      assignments: nodes.map((node, index) => [node.nodeId, { nodeId: node.nodeId, selectedAgentId: `runtime-${index}`, status: 'accepted', selectedBy: 'queen', acceptedAt: '2026-09-09T00:00:00Z', override: false, riskCodes: [] }]),
      confirmed: revision,
    }],
    facts: nodes.map((node, index) => ({ value: { task_id: task, graph_revision: revision, node_id: node.nodeId, runtime_agent_id: `runtime-${index}`, binding_id: agentFor(index).agentId, market_agent_id: agentFor(index).agentId, share_bps: agentFor(index).shareBps, node_risk_multiplier_bps: agentFor(index).nodeRiskMultiplierBps, reputation_risk_multiplier_bps: agentFor(index).reputationRiskMultiplierBps } })),
  };
}

beforeEach(async () => {
  team = [{ agentId: agent, agentWallet: worker, shareBps: 10000, nodeRiskMultiplierBps: 10000, reputationRiskMultiplierBps: 10000 }];
  riskMaterial = riskMaterialFixture();
  if (realUrl) {
    const url = new URL(realUrl);
    if (url.hostname !== '127.0.0.1' || url.port !== '55439' || url.pathname !== '/am_commercial_test') throw new Error('UNSAFE_TEST_DATABASE');
    sql = postgres(realUrl, { max: 6, prepare: false, onnotice: () => {} });
    await sql.unsafe('DROP SCHEMA IF EXISTS agent_market CASCADE');
    pg = {
      exec: async (text: string) => { await sql!.begin(async tx => { await tx.unsafe(text.replace(/^BEGIN;\s*$/gmu, '').replace(/^COMMIT;\s*$/gmu, '')); }); return []; },
      query: async <T>(text: string, values?: unknown[]) => ({ rows: [...await sql!.unsafe(text, (values ?? []) as never[])] as T[], fields: [] }),
      close: async () => { await sql!.end(); },
    };
  } else pg = new PGlite();
  await pg.exec(`CREATE SCHEMA agent_market;
    CREATE TABLE agent_market.tasks(id uuid PRIMARY KEY, publisher_wallet text, budget_atomic numeric(78,0), version integer, status text);
    CREATE TABLE agent_market.task_events(task_id uuid, event_type text, payload jsonb);
    CREATE TABLE agent_market.agents(id uuid PRIMARY KEY, owner_wallet text, status text);
    INSERT INTO agent_market.tasks VALUES ('${task}','${owner}',1000,1,'funded');
    INSERT INTO agent_market.agents VALUES ('${agent}','${worker}','published');`);
  await pg.exec(readFileSync(new URL('../../../../database/migrations/0020_commercial.sql', import.meta.url), 'utf8'));
  await pg.exec(readFileSync(new URL('../../../../database/migrations/0015_l2_risk_pricing.sql', import.meta.url), 'utf8'));
  await pg.exec(readFileSync(new URL('../../../../database/migrations/0022_commercial_deposits.sql', import.meta.url), 'utf8'));
  await pg.exec(readFileSync(new URL('../../../../database/migrations/0023_risk_quote_asset.sql', import.meta.url), 'utf8'));
  const query: Query = async (sql, values = []) => (await pg.query(sql, values)).rows as Record<string, unknown>[];
  db = { query, transaction: (fn) => sql ? sql.begin(async tx => fn(async (text, values = []) => [...await tx.unsafe(text, values as never[])])) as Promise<Awaited<ReturnType<typeof fn>>> : (pg as PGlite).transaction(async (tx) => fn(async (text, values = []) => (await tx.query(text, values)).rows as Record<string, unknown>[])) };
  const transact = db.transaction.bind(db);
  db.transaction = fn => transact(q => fn(Object.assign(q, { riskTask: () => authoritative(q), riskMaterial: async () => riskMaterial })));
  await issueQuote();
  service = new CommercialService(db, policy);
});
afterEach(async () => { vi.useRealTimers(); await pg.close(); });

async function authoritative(q: Query): Promise<AuthoritativeRiskTask> {
  const row = (await q('SELECT budget_atomic::text FROM agent_market.tasks WHERE id=$1', [task]))[0]!;
  return { id: task, publisherWallet: owner, title: 'Task', description: 'Task description', requirements: ['Deliver'], declaredPermissions: [], durationHours: 1, dependencyClasses: [], budgetAtomic: String(row.budget_atomic), authorizedQuoteWallets: [owner,worker], quoteStatus: 'confirmed', dag: { revision: 1, finalized: true, assignments: team } };
}
async function issueQuote(feeBps = 1000, riskScore = 30, assetId = policy.assetId) {
  riskMaterial = riskMaterialFixture();
  await pg.query('DELETE FROM agent_market.risk_quotes');
  const taskData = await authoritative(db.query); quoteId = randomUUID();
  const quote = createRiskQuote({ assetId, phase: 'final', policyVersion: 'risk-pricing-v2', taskFingerprint: fingerprintRiskTask(taskData,assetId), budgetAtomic: taskData.budgetAtomic, serviceFeeBps: feeBps, assessment: assessRisk({ factors: { complexity: riskScore, acceptanceAmbiguity: riskScore, externalDependency: riskScore, dataSensitivity: riskScore, financialRisk: riskScore, irreversibility: riskScore, deadlineRisk: riskScore, agentUncertainty: riskScore }, reasonCodes: ['test_case'] }), expiresAt: new Date(Date.now()+3600000).toISOString(), agentNodes: taskData.dag!.assignments.map(({ agentWallet: _wallet, ...node }) => node) });
  const record=await new MemoryRiskQuoteStore().issue({taskId:task,publisherWallet:owner,dagRevision:1,assignments:[...new Map(team.map(a=>[a.agentId,{agentId:a.agentId,agentWallet:a.agentWallet}])).values()],quote,createdAt:new Date().toISOString()});
  quoteHash=record.basisFingerprint;
  await pg.query("INSERT INTO agent_market.risk_quotes(id,task_id,quote_version,phase,task_fingerprint,dag_revision,policy_version,basis_fingerprint,quote_payload,manual_review_required,expires_at,status,created_at) VALUES($1,$2,1,'final',$3,1,'risk-pricing-v2',$7,$4::text::jsonb,$6,$5,'active',now())", [quoteId,task,quote.taskFingerprint,JSON.stringify(quote),quote.expiresAt,quote.manualReviewRequired,quoteHash]);
  await pg.query("INSERT INTO agent_market.risk_quote_confirmations(quote_id,actor_type,actor_key,actor_wallet,agent_id,task_fingerprint,confirmed_at,quote_hash) VALUES($1,'publisher',$2,$2,NULL,$3,now(),$4)", [quoteId,owner,quote.taskFingerprint,quoteHash]);
  for (const allocation of quote.agentAllocations) {
    const wallet = team.find(a => a.agentId === allocation.agentId)!.agentWallet;
    await pg.query('INSERT INTO agent_market.risk_quote_agent_allocations VALUES($1,$2,$3,$4)', [quoteId,allocation.agentId,wallet,allocation.amountAtomic]);
    await pg.query("INSERT INTO agent_market.risk_quote_confirmations(quote_id,actor_type,actor_key,actor_wallet,agent_id,task_fingerprint,confirmed_at,quote_hash) VALUES($1,'agent',$2,$3,$2,$4,now(),$5)", [quoteId,allocation.agentId,wallet,quote.taskFingerprint,quoteHash]);
  }
}
const noFault: ObservationReader = { income: async () => [], payout: async () => null, settlement: async order => ({ orderId: order.id, quoteId: order.acceptedQuote.id, taskFingerprint: order.acceptedQuote.fingerprint, decisionId: 'independent-force-majeure', status: 'final', outcome: 'force_majeure', cancelledChildIds: order.children.filter(c => c.status === 'cancelled').map(c => c.id) }) };
async function finalize() {
  await exec(owner, create);
  await exec(worker, { type: 'submit', childId: 'a', artifact });
  await exec(owner, { type: 'accept', childId: 'a' });
  await exec(worker, { type: 'submit', childId: 'b', artifact });
  await exec(owner, { type: 'accept', childId: 'b' });
  return exec(owner, { type: 'manifest' });
}

describe('commercial durable commands', () => {
  it('rounds the additional fee up and freezes it without reducing principal', async () => {
    await pg.query('UPDATE agent_market.tasks SET budget_atomic=101');
    await issueQuote(600);
    service = new CommercialService(db, { ...policy, feeBps: 600 });
    const allocation = { type: 'create', children: [{ id: 'a', agentId: agent, budgetAtomic: '101' }] };
    riskMaterial = riskMaterialFixture(allocation.children);
    const created = await exec(owner, allocation);
    expect(created.platformFeeAtomic).toBe('7');
    expect(created.feePolicy).toBe('budget-plus-service-fee.v1');
    service = new CommercialService(db, { ...policy, feeBps: 9000 });
    await exec(worker, { type: 'submit', childId: 'a', artifact });
    await exec(owner, { type: 'accept', childId: 'a' });
    const result = await exec(owner, { type: 'manifest' });
    expect(result.manifest?.entries.map(e => [e.kind, e.amountAtomic])).toEqual([['node', '101'], ['platform', '7'], ['deposit_return','11'], ['deposit_return','11']]);
    const view = await service.read(task, owner);
    expect(view.reconciliation).toMatchObject({ balanced: true, journalAtomic: '130', paidAtomic: '0', evidence: 'accounting_projection_not_funding_proof' });
  });
  it('rejects foreign create/read and over-allocation; rolls back', async () => {
    await expect(exec(other, create)).rejects.toThrow('FORBIDDEN');
    await expect(exec(owner, { ...create, children: [{ ...create.children[0], budgetAtomic: '1001' }] })).rejects.toThrow('BUDGET');
    expect((await pg.query('SELECT * FROM agent_market.commercial_orders')).rows).toHaveLength(0);
  });
  it('allows a publisher to use their own published Agent under the same quote and collateral rules', async () => {
    await pg.query('UPDATE agent_market.agents SET owner_wallet=$1', [owner]);
    team = [{ agentId: agent, agentWallet: owner, shareBps: 10000, nodeRiskMultiplierBps: 10000, reputationRiskMultiplierBps: 10000 }];
    await issueQuote();

    const created = await exec(owner, create);

    expect(created.children.map(child => child.agentWallet)).toEqual([owner, owner]);
    expect(created.deposits).toEqual([
      { id: 'publisher', owner, amountAtomic: '100', forfeitedAtomic: '0' },
      { id: `agent:${agent}`, owner, amountAtomic: '100', forfeitedAtomic: '0' },
    ]);
  });
  it('binds multi-node create children to the finalized graph', async () => {
    const created = await exec(owner, create);

    expect(created.children.map(({ id, agentId, budgetAtomic }) => ({ id, agentId, budgetAtomic }))).toEqual(create.children);
    expect(created.acceptedQuote.dagRevision).toBe(1);
  });
  it.each([
    ['missing node', [create.children[0]]],
    ['extra node', [create.children[0], { ...create.children[1], budgetAtomic: '399' }, { id: 'c', agentId: agent, budgetAtomic: '1' }]],
    ['wrong budget', [{ ...create.children[0], budgetAtomic: '599' }, { ...create.children[1], budgetAtomic: '401' }]],
  ] as const)('rejects %s against the finalized graph', async (_case, children) => {
    await expect(exec(owner, { type: 'create', children })).rejects.toThrow('SOURCE_CONFLICT');
  });
  it('rejects valid quoted Agents assigned to the wrong graph nodes', async () => {
    const second = randomUUID();
    await pg.query('INSERT INTO agent_market.agents VALUES($1,$2,\'published\')', [second, other]);
    team = [
      { agentId: agent, agentWallet: worker, shareBps: 5000, nodeRiskMultiplierBps: 10000, reputationRiskMultiplierBps: 10000 },
      { agentId: second, agentWallet: other, shareBps: 5000, nodeRiskMultiplierBps: 10000, reputationRiskMultiplierBps: 10000 },
    ];
    await issueQuote();

    await expect(exec(owner, { type: 'create', children: [
      { ...create.children[0], agentId: second },
      { ...create.children[1], agentId: agent },
    ] })).rejects.toThrow('SOURCE_CONFLICT');
  });
  it('rejects finalized graph material whose revision differs from the accepted quote', async () => {
    riskMaterial = riskMaterialFixture(create.children, 2);

    await expect(exec(owner, create)).rejects.toThrow('SOURCE_CONFLICT');
  });
  it('accepts independently, freezes accepted artifacts and preserves budget in manifest', async () => {
    await exec(owner, create);
    await expect(exec(owner, { type: 'accept', childId: 'a' })).rejects.toThrow('TRANSITION');
    await expect(exec(other, { type: 'submit', childId: 'a', artifact })).rejects.toThrow('FORBIDDEN');
    await exec(worker, { type: 'submit', childId: 'a', artifact });
    await expect(exec(worker, { type: 'accept', childId: 'a' })).rejects.toThrow('FORBIDDEN');
    const accepted = await exec(owner, { type: 'accept', childId: 'a' });
    expect(accepted.children.map(c => c.status)).toEqual(['accepted', 'assigned']);
    await expect(exec(worker, { type: 'submit', childId: 'a', artifact })).rejects.toThrow('TRANSITION');
    await expect(exec(owner, { type: 'manifest' })).rejects.toThrow('TRANSITION');
    await exec(owner, { type: 'cancel', childId: 'b' });
    await expect(exec(owner, { type: 'manifest' })).rejects.toThrow('DEPOSIT_RESOLUTION_REQUIRED');
    service = new CommercialService(db, policy, noFault);
    const result = await exec(owner, { type: 'manifest' });
    expect(result.manifest?.entries.map(e => [e.kind, e.amountAtomic])).toEqual([['node', '600'], ['platform', '100'], ['refund', '400'], ['deposit_return','100'], ['deposit_return','100']]);
    const reconciliation = await service.read(task, owner);
    expect(reconciliation.reconciliation).toMatchObject({ balanced: true, journalAtomic: '1300', paidAtomic: '0' });
    await expect(service.read(task, other)).rejects.toThrow('FORBIDDEN');
  });
  it('deduplicates concurrent create and manifest, rejects key payload drift', async () => {
    const key = randomUUID();
    const results = await Promise.all([exec(owner, create, key), exec(owner, create, key)]);
    expect(results[0]).toEqual(results[1]);
    await expect(exec(owner, { type: 'cancel', childId: 'a' }, key)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    await exec(owner, { type: 'cancel', childId: 'a' });
    await exec(owner, { type: 'cancel', childId: 'b' });
    service = new CommercialService(db, policy, noFault);
    const manifests = await Promise.all([exec(owner, { type: 'manifest' }), exec(owner, { type: 'manifest' })]);
    expect(manifests[0].manifest).toEqual(manifests[1].manifest);
    expect((await pg.query('SELECT * FROM agent_market.commercial_journal')).rows).toHaveLength(4);
  });
  it('binds claims to beneficiary, never reports external payment without observation', async () => {
    const state = await finalize();
    const entryId = state.manifest!.entries[0]!.id;
    await expect(exec(owner, { type: 'claim', entryId })).rejects.toThrow('FORBIDDEN');
    const claimed = await Promise.all([exec(worker, { type: 'claim', entryId }), exec(worker, { type: 'claim', entryId })]);
    expect(claimed[0].claims).toEqual(claimed[1].claims);
    expect(claimed[0].claims[0]?.status).toBe('pending_external');
    await expect(exec(worker, { type: 'reconcile', entryId })).rejects.toThrow('EXTERNAL_UNAVAILABLE');
    expect((await service.read(task, owner)).reconciliation.paidAtomic).toBe('0');
  });
  it('only consumes trusted observed receipts and prevents duplicate payment posting', async () => {
    const state = await finalize();
    const entry = state.manifest!.entries[0]!;
    const claimed = await exec(worker, { type: 'claim', entryId: entry.id });
    const claim = claimed.claims[0]!;
    const reader: ObservationReader = { payout: async () => ({ receiptId: 'provider:payment:1', claimId: claim.id, assetId: policy.assetId, beneficiary: worker, amountAtomic: '600', status: 'confirmed' }), income: async () => [] };
    service = new CommercialService(db, policy, reader);
    await Promise.all([exec(worker, { type: 'reconcile', entryId: entry.id }), exec(worker, { type: 'reconcile', entryId: entry.id })]);
    expect((await service.read(task, owner)).reconciliation.paidAtomic).toBe('600');
    expect((await pg.query("SELECT * FROM agent_market.commercial_journal WHERE kind='payment'")).rows).toHaveLength(1);
    await expect(exec(worker, { type: 'reconcile', entryId: entry.id, amountAtomic: '999' })).rejects.toThrow('INVALID');
  });
  it('rejects drift in source task and unobserved income', async () => {
    await exec(owner, create);
    await expect(exec(owner, { type: 'observe_income' })).rejects.toThrow('EXTERNAL_UNAVAILABLE');
    await pg.query('UPDATE agent_market.tasks SET version=2');
    await expect(exec(owner, { type: 'cancel', childId: 'a' })).rejects.toThrow('SOURCE_CONFLICT');
  });
  it('posts observed provider income once, allocates only observed net yield', async () => {
    await exec(owner, create);
    const taskFingerprint = fingerprintRiskTask(await authoritative(db.query),policy.assetId);
    service = new CommercialService(db, policy, { ...noFault, income: async () => [{ beneficiary: platform, authorizationId: 'consent:1', consentWallets: [owner,worker], receiptId: 'provider:yield:1', orderId: task, quoteId, taskFingerprint, principalSource: 'symmetric_deposits', assetId: policy.assetId, amountAtomic: '25', providerId: 'one', kind: 'yield', status: 'confirmed' }] });
    await exec(owner, { type: 'observe_income' });
    await exec(owner, { type: 'observe_income' });
    await exec(owner, { type: 'cancel', childId: 'a' });
    await exec(owner, { type: 'cancel', childId: 'b' });
    const result = await exec(owner, { type: 'manifest' });
    expect(result.manifest?.entries.map(e => [e.kind, e.amountAtomic])).toEqual([['platform', '100'], ['refund', '1000'], ['yield', '25'], ['deposit_return','100'], ['deposit_return','100']]);
    expect((await service.read(task, owner)).reconciliation.balanced).toBe(true);
  });
  it('serves authenticated API, refuses CSRF, spoofed actors, and unknown errors', async () => {
    const handler = createCommercialHandler({ service, authOrigin: new URL('https://app.test'), auth: { authenticateSession: async () => ({ walletAddress: owner }) } });
    const request = (body: unknown, origin = 'https://app.test') => new Request('https://app.test/api/commercial/'+task, { method: 'POST', headers: { origin, cookie: '__Host-agent_market_session=token', 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await handler(request(create, 'https://evil.test'), task)).status).toBe(403);
    expect((await handler(request({ ...create, actorWallet: other }), task)).status).toBe(400);
    const response = await handler(request(create), task);
    expect(response.status).toBe(200);
    expect((await response.json()).order.children).toHaveLength(2);
  });
});

async function progress() {
  const transitions = [['start_matching','funded','matching'],['assign_agent','matching','assigned'],['accept_assignment','assigned','in_progress'],['submit_artifact','in_progress','submitted'],['accept_delivery','submitted','accepted'],['settle','accepted','settled']];
  for (const [type,from,to] of transitions) {
    await db.transaction(async q => {
      const row = (await q('UPDATE agent_market.tasks SET version=version+1,status=$1 RETURNING version', [to]))[0]!;
      await q('INSERT INTO agent_market.task_events VALUES($1,$2,$3::text::jsonb)', [task,type,JSON.stringify({ from,to,version:row.version })]);
    });
  }
}

describe('accepted quote, symmetric collateral and source authority', () => {
  it('requires every exact wallet confirmation and refuses caller financial terms', async () => {
    await pg.query("DELETE FROM agent_market.risk_quote_confirmations WHERE actor_type='agent'");
    await expect(exec(owner, create)).rejects.toThrow('ACCEPTED_QUOTE_REQUIRED');
    await issueQuote();
    await pg.query("UPDATE agent_market.risk_quote_confirmations SET actor_wallet=$1 WHERE actor_type='agent'", [other]);
    await expect(exec(owner, create)).rejects.toThrow('ACCEPTED_QUOTE_REQUIRED');
    await expect(exec(owner, { ...create, A: '0', B: '0' })).rejects.toThrow('INVALID');
    expect((await pg.query('SELECT * FROM agent_market.commercial_orders')).rows).toHaveLength(0);
  });
  it('rejects expired initial quotes but does not expire a previously accepted obligation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now(); vi.setSystemTime(now+7200000);
    await expect(exec(owner, create)).rejects.toThrow('ACCEPTED_QUOTE_REQUIRED');
    vi.setSystemTime(now);
    const created = await exec(owner, create);
    expect(created.acceptedQuote.quote).toMatchObject({ P:'1000', A:'100', B:'100', publisherTotal:'1200', agentTeamDeposit:'100' });
    vi.setSystemTime(now+7200000);
    await expect(exec(worker, { type: 'submit', childId:'a', artifact })).resolves.toBeDefined();
  });
  it('uses the risk engine allocation across distinct agents, returns each frozen deposit', async () => {
    const second = randomUUID();
    await pg.query('INSERT INTO agent_market.agents VALUES($1,$2,\'published\')', [second,other]);
    team = [{ agentId:agent,agentWallet:worker,shareBps:2500,nodeRiskMultiplierBps:10000,reputationRiskMultiplierBps:10000 }, { agentId:second,agentWallet:other,shareBps:7500,nodeRiskMultiplierBps:10000,reputationRiskMultiplierBps:10000 }];
    await issueQuote();
    const result = await exec(owner, { type:'create', children:[{ id:'a',agentId:agent,budgetAtomic:'600' },{ id:'b',agentId:second,budgetAtomic:'400' }] });
    expect(result.deposits.map(d => [d.owner,d.amountAtomic])).toEqual([[owner,'100'], ...[...result.acceptedQuote.agents].map(a => [a.agentWallet,a.amountAtomic])]);
    expect(result.deposits.find(d => d.owner===worker)?.amountAtomic).toBe('25');
    expect(result.deposits.find(d => d.owner===other)?.amountAtomic).toBe('75');
    await exec(worker, { type:'submit',childId:'a',artifact }); await exec(owner,{ type:'accept',childId:'a' });
    await expect(exec(worker,{ type:'submit',childId:'b',artifact })).rejects.toThrow('FORBIDDEN');
    await exec(other, { type:'submit',childId:'b',artifact }); await exec(owner,{ type:'accept',childId:'b' });
    const manifest = await exec(owner,{ type:'manifest' });
    expect(manifest.manifest?.entries.filter(e => e.kind==='deposit_return').map(e => e.amountAtomic).sort()).toEqual(['100','25','75']);
    expect((await service.read(task,owner)).reconciliation).toMatchObject({ balanced:true, journalAtomic:'1300',paidAtomic:'0' });
  });
  it('allows settled claims after a complete legal event chain, rejects halt even on replay', async () => {
    const state = await finalize(); await progress();
    const entryId = state.manifest!.entries[0]!.id, key = randomUUID();
    const claimed = await exec(worker,{ type:'claim',entryId },key);
    expect(claimed.sourceVersion).toBe(7);
    expect(claimed.claims[0]?.status).toBe('pending_external');
    await pg.query("UPDATE agent_market.tasks SET status='manual_review'");
    await expect(exec(worker,{ type:'claim',entryId },key)).rejects.toThrow('SOURCE_CONFLICT');
  });
  it('rejects forged progress, material risk drift, missing quote and unexplained terminal status', async () => {
    const state = await finalize();
    riskMaterial = { ...riskMaterialFixture(), contexts: [{ value: { policy_version: 'risk-context-v1', declared_permissions: ['changed-permissions'] } }] };
    await expect(exec(worker,{ type:'claim',entryId:state.manifest!.entries[0]!.id })).rejects.toThrow('SOURCE_CONFLICT');
    riskMaterial = riskMaterialFixture();
    await pg.query("UPDATE agent_market.tasks SET status='settled'");
    await expect(exec(worker,{ type:'claim',entryId:state.manifest!.entries[0]!.id })).rejects.toThrow('SOURCE_CONFLICT');
    await pg.query("UPDATE agent_market.tasks SET status='funded'");
    await pg.query('DELETE FROM agent_market.risk_quotes');
    await expect(exec(worker,{ type:'claim',entryId:state.manifest!.entries[0]!.id })).rejects.toThrow('SOURCE_CONFLICT');
  });
  it('rejects unconsented yield and treasury-directed forfeiture without recording income', async () => {
    await exec(owner,create);
    const taskFingerprint = fingerprintRiskTask(await authoritative(db.query),policy.assetId);
    service = new CommercialService(db,policy,{ payout:async()=>null,income:async()=>[{ receiptId:'yield:bad',orderId:task,quoteId,taskFingerprint,principalSource:'symmetric_deposits' as const,assetId:policy.assetId,amountAtomic:'20',providerId:'one',kind:'yield',status:'confirmed',beneficiary:platform,authorizationId:'consent',consentWallets:[owner] }] });
    await expect(exec(owner,{type:'observe_income'})).rejects.toThrow('INCOME_AUTHORITY_REQUIRED');
    service = new CommercialService(db,policy,{ payout:async()=>null,income:async()=>[{ receiptId:'penalty:bad',orderId:task,quoteId,taskFingerprint,principalSource:'symmetric_deposits' as const,assetId:policy.assetId,amountAtomic:'20',providerId:'one',kind:'penalty',status:'confirmed',beneficiary:platform,authorizationId:'verdict',depositId:`agent:${agent}` }] });
    await expect(exec(owner,{type:'observe_income'})).rejects.toThrow('INCOME_AUTHORITY_REQUIRED');
    expect((await pg.query('SELECT * FROM agent_market.commercial_receipts')).rows).toHaveLength(0);
  });
  it('conserves forfeited collateral rather than counting it as additional capital, deduplicates observation', async () => {
    await exec(owner,create);
    const receipt = { receiptId:'penalty:one',orderId:task,quoteId,taskFingerprint:fingerprintRiskTask(await authoritative(db.query),policy.assetId),principalSource:'symmetric_deposits' as const,assetId:policy.assetId,amountAtomic:'30',providerId:'one',kind:'penalty' as const,status:'confirmed' as const,beneficiary:owner,authorizationId:'verdict:1',depositId:`agent:${agent}` };
    service = new CommercialService(db,policy,{ payout:async()=>null,income:async()=>[receipt],settlement:async order=>({orderId:order.id,quoteId:order.acceptedQuote.id,taskFingerprint:order.acceptedQuote.fingerprint,status:'final',decisionId:'verdict:1',outcome:'responsibility',cancelledChildIds:['b']}) });
    await Promise.all([exec(owner,{type:'observe_income'}),exec(owner,{type:'observe_income'})]);
    await exec(worker,{type:'submit',childId:'a',artifact}); await exec(owner,{type:'accept',childId:'a'}); await exec(owner,{type:'cancel',childId:'b'});
    const state = await exec(owner,{type:'manifest'});
    expect(state.manifest?.entries.filter(e=>e.kind==='deposit_return').map(e=>[e.beneficiary,e.amountAtomic])).toEqual([[owner,'100'],[worker,'70']]);
    expect(state.manifest?.entries.find(e=>e.kind==='penalty')).toMatchObject({beneficiary:owner,amountAtomic:'30'});
    expect((await service.read(task,owner)).reconciliation).toMatchObject({balanced:true,journalAtomic:'1300',paidAtomic:'0'});
  });
  it('rolls back over-forfeiture and refuses a mismatched independent resolution', async () => {
    await exec(owner,create);
    const taskFingerprint = fingerprintRiskTask(await authoritative(db.query),policy.assetId);
    service = new CommercialService(db,policy,{ payout:async()=>null,income:async()=>[{receiptId:'over',orderId:task,quoteId,taskFingerprint,principalSource:'symmetric_deposits' as const,assetId:policy.assetId,amountAtomic:'101',providerId:'one',kind:'penalty',status:'confirmed',beneficiary:worker,authorizationId:'verdict',depositId:'publisher'}] });
    await expect(exec(owner,{type:'observe_income'})).rejects.toThrow('DEPOSIT_CONFLICT');
    expect((await pg.query('SELECT * FROM agent_market.commercial_receipts')).rows).toHaveLength(0);
    await exec(owner,{type:'cancel',childId:'a'}); await exec(owner,{type:'cancel',childId:'b'});
    service = new CommercialService(db,policy,{...noFault,settlement:async order=>({...await noFault.settlement!(order)!,quoteId:randomUUID()})} as ObservationReader);
    await expect(exec(owner,{type:'manifest'})).rejects.toThrow('DEPOSIT_RESOLUTION_REQUIRED');
  });
});

describe('production PostgreSQL risk binding', () => {
  it.skipIf(!realUrl)('uses the actual runtime SQL and authoritative graph parser, tolerates only proven context version drift', async () => {
    const { commercialDatabase } = await import('./runtime');
    await runtimeFixture();
    await pg.query("UPDATE agent_market.tasks SET version=2,status='matching'");
    await pg.query("INSERT INTO agent_market.task_events VALUES($1,'start_matching','{\"from\":\"funded\",\"to\":\"matching\",\"version\":2}')",[task]);
    service = new CommercialService(commercialDatabase(sql!),policy);
    const created=await exec(owner,create);
    expect(created.sourceVersion).toBe(2);
    expect(created.acceptedQuote.quote).toMatchObject({P:'1000',A:'100',B:'100'});
    await exec(worker,{type:'submit',childId:'a',artifact});
    await pg.query("UPDATE agent_market.task_risk_contexts SET declared_permissions='{write_secrets}'");
    await expect(exec(owner,{type:'accept',childId:'a'})).rejects.toThrow('SOURCE_CONFLICT');
  });
});

async function runtimeFixture(riskScore = 30) {
    await pg.exec(`ALTER TABLE agent_market.tasks ADD COLUMN title text DEFAULT 'Task', ADD COLUMN description text DEFAULT 'Task description', ADD COLUMN requirements text[] DEFAULT '{Deliver}';
      CREATE TABLE agent_market.task_risk_contexts(task_id uuid,context_version int,task_version int,policy_version text,declared_permissions text[],duration_hours numeric,dependency_classes text[],status text);
      CREATE TABLE agent_market.queen_workflows(task_id uuid,record_version int,graph_revision int,snapshot jsonb);
      CREATE TABLE agent_market.task_graph_pricing_versions(task_id uuid,graph_revision int,workflow_record_version int,policy_version text);
      CREATE TABLE agent_market.runtime_agent_bindings(id uuid,runtime_agent_id text,market_agent_id uuid,status text);
      CREATE TABLE agent_market.task_graph_node_pricing_facts(task_id uuid,graph_revision int,node_id text,runtime_agent_id text,binding_id uuid,market_agent_id uuid,share_bps int,node_risk_multiplier_bps int,reputation_risk_multiplier_bps int);`);
    const binding = randomUUID();
    const graph = { taskId:task,graphRevision:1,requiredStages:['requirement','graph','ranking','acceptance','execution','judge','final_arbitration','delivery'],riskLevel:'medium',startPolicy:'manualRequired',nodes:['a','b'].map((nodeId,i)=>({nodeId,type:i===0?'plan':'deliver',title:nodeId,dependencies:i===0?[]:['a'],required:true,contract:{schemaVersion:'1',contextInputs:[],outputKeys:['result'],artifactMediaTypes:['text/plain'],milestone:'Delivered',acceptanceCriteria:['Complete'],budgetAtomic:i===0?'600':'400',permissions:[],timeoutSeconds:300,failureRoute:'stop'}})),edges:[{from:'a',to:'b',condition:'approved'}],rescuePolicy:{mode:'auto',visibleToUser:false,evidenceVisible:true}};
    const snapshot = {taskId:task,recordVersion:1,graph,graphConfirmedRevision:1,assignments:['a','b'].map(nodeId=>[nodeId,{nodeId,selectedAgentId:'runtime-test',status:'accepted',selectedBy:'queen',acceptedAt:'2026-09-09T00:00:00Z',override:false,riskCodes:[]}])};
    await pg.query("INSERT INTO agent_market.task_risk_contexts VALUES($1,1,1,'risk-context-v1','{}',1,'{}','active')",[task]);
    await pg.query('INSERT INTO agent_market.queen_workflows VALUES($1,1,1,$2::text::jsonb)',[task,JSON.stringify(snapshot)]);
    await pg.query("INSERT INTO agent_market.task_graph_pricing_versions VALUES($1,1,1,'pricing-v1')",[task]);
    await pg.query("INSERT INTO agent_market.runtime_agent_bindings VALUES($1,'runtime-test',$2,'active')",[binding,agent]);
    await pg.query("INSERT INTO agent_market.task_graph_node_pricing_facts VALUES($1,1,'a','runtime-test',$2,$3,6000,10000,10000),($1,1,'b','runtime-test',$2,$3,4000,10000,10000)",[task,binding,agent]);
    team=[{agentId:agent,agentWallet:worker,shareBps:6000,nodeRiskMultiplierBps:10000,reputationRiskMultiplierBps:10000},{agentId:agent,agentWallet:worker,shareBps:4000,nodeRiskMultiplierBps:10000,reputationRiskMultiplierBps:10000}];
    await issueQuote(1000,riskScore);
}

describe('W3 closure targeted local PostgreSQL', () => {
  it.skipIf(!realUrl)('R5 actual runtime refuses missing/unauthorized approval then binds approved quote', async () => {
    await runtimeFixture(90);
    const { commercialDatabase } = await import('./runtime');
    service = new CommercialService(commercialDatabase(sql!),policy);
    await expect(exec(owner,create)).rejects.toThrow('COMMERCIAL_ACCEPTED_QUOTE_REQUIRED');
    expect((await pg.query('SELECT * FROM agent_market.commercial_orders')).rows).toHaveLength(0);
    const quotes = new PostgresRiskQuoteStore(sql!);
    for (const approverRole of ['risk_assessor','agent'] as const) {
      await expect(quotes.approveManual({quoteId,approvedAt:new Date().toISOString(),approvedBy:'test-operator',approverRole})).rejects.toThrow('RISK_QUOTE_MANUAL_APPROVER_FORBIDDEN');
      await expect(exec(owner,create)).rejects.toThrow('COMMERCIAL_ACCEPTED_QUOTE_REQUIRED');
    }
    await quotes.approveManual({quoteId,approvedAt:new Date().toISOString(),approvedBy:'test-operator',approverRole:'platform_operator'});
    const bound=await exec(owner,create);
    expect(bound.acceptedQuote.id).toBe(quoteId);
    expect(bound.acceptedQuote.quote).toMatchObject({riskTier:'R5',manualReviewRequired:true,P:'1000',A:'400',B:'100',publisherTotal:'1500',agentTeamDeposit:'400'});
    expect(bound.deposits.map(d=>d.amountAtomic)).toEqual(['400','400']);
    expect(bound.claims).toEqual([]);
    expect((await service.read(task,owner)).reconciliation.paidAtomic).toBe('0');
  });

  it.skipIf(!realUrl)('settled actual runtime reconciles an explicitly synthetic observation exactly once', async () => {
    await runtimeFixture();
    const { commercialDatabase } = await import('./runtime');
    const runtimeDb=commercialDatabase(sql!);
    service=new CommercialService(runtimeDb,policy);
    const finalized=await finalize();
    await progress();
    const entryId=finalized.manifest!.entries[0]!.id;
    const claimed=await exec(worker,{type:'claim',entryId});
    const claim=claimed.claims[0]!;
    expect(claimed.sourceStatus).toBe('settled');
    expect(claimed.sourceVersion).toBe(7);
    expect(claim.status).toBe('pending_external');
    // This reader is test-only evidence. It does not contact a provider or chain.
    let observations=0;
    const reader: ObservationReader={income:async()=>[],payout:async()=>{
      observations++;
      return {receiptId:'test-only:synthetic:settled-payment',claimId:claim.id,assetId:policy.assetId,beneficiary:worker,amountAtomic:'600',status:'confirmed'};
    }};
    service=new CommercialService(runtimeDb,policy,reader);
    await expect(exec(owner,{type:'reconcile',entryId})).rejects.toThrow('FORBIDDEN');
    const results=await Promise.all([exec(worker,{type:'reconcile',entryId}),exec(worker,{type:'reconcile',entryId})]);
    expect(results.map(r=>r.claims[0]?.status)).toEqual(['confirmed','confirmed']);
    expect(observations).toBe(1);
    // A new service instance reads the same committed projection without a reader.
    service=new CommercialService(runtimeDb,policy);
    await expect(exec(worker,{type:'reconcile',entryId})).resolves.toMatchObject({sourceStatus:'settled'});
    expect((await service.read(task,worker)).reconciliation).toMatchObject({balanced:true,journalAtomic:'1300',paidAtomic:'600',outstandingAtomic:'700'});
    expect((await pg.query("SELECT * FROM agent_market.commercial_journal WHERE kind='payment'")).rows).toHaveLength(1);
    expect((await pg.query('SELECT * FROM agent_market.commercial_receipts')).rows).toHaveLength(1);
  });

  it.skipIf(!realUrl)('legacy unquoted snapshot remains readable and rejects every write including historical replay', async () => {
    const { commercialDatabase } = await import('./runtime');
    const legacy={id:task,publisherWallet:owner,sourceVersion:1,budgetAtomic:'1000',...policy,platformFeeAtomic:'100',feePolicy:'budget-plus-service-fee.v1',children:[{id:'a',agentId:agent,agentWallet:worker,budgetAtomic:'1000',status:'assigned'}],observedYieldAtomic:'0',observedPenaltyAtomic:'0',manifest:null,claims:[]};
    await pg.query('DELETE FROM agent_market.risk_quotes');
    await pg.query('INSERT INTO agent_market.commercial_orders(task_id,state) VALUES($1,$2::text::jsonb)',[task,JSON.stringify(legacy)]);
    const replayKey='historical-create-key';
    await pg.query('INSERT INTO agent_market.commercial_commands(task_id,actor_wallet,idempotency_key,fingerprint,response) VALUES($1,$2,$3,$4,$5::text::jsonb)',[task,owner,replayKey,'0'.repeat(64),JSON.stringify(legacy)]);
    service=new CommercialService(commercialDatabase(sql!),policy);
    const handler=createCommercialHandler({service,authOrigin:new URL('https://app.test'),auth:{authenticateSession:async()=>({walletAddress:owner})}});
    const response=await handler(new Request(`https://app.test/api/commercial/orders/${task}`,{headers:{cookie:'__Host-agent_market_session=test-only'}}),task);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).order).toEqual(legacy);
    expect((await service.read(task,worker)).order).toEqual(legacy);
    await expect(service.read(task,other)).rejects.toThrow('FORBIDDEN');
    for(const body of [create,{type:'submit',childId:'a',artifact},{type:'accept',childId:'a'},{type:'cancel',childId:'a'},{type:'manifest'},{type:'claim',entryId:randomUUID()},{type:'reconcile',entryId:randomUUID()},{type:'observe_income'}]) {
      await expect(exec(owner,body)).rejects.toThrow('COMMERCIAL_REBIND_REQUIRED');
    }
    await expect(exec(owner,create,replayKey)).rejects.toThrow('COMMERCIAL_REBIND_REQUIRED');
    expect((await pg.query('SELECT state FROM agent_market.commercial_orders')).rows).toEqual([{state:legacy}]);
    expect((await pg.query('SELECT * FROM agent_market.commercial_commands')).rows).toHaveLength(1);
    expect((await pg.query('SELECT * FROM agent_market.commercial_journal')).rows).toHaveLength(0);
    expect((await pg.query('SELECT * FROM agent_market.commercial_receipts')).rows).toHaveLength(0);
    expect((await pg.query('SELECT * FROM agent_market.risk_quotes')).rows).toHaveLength(0);
  });
});

describe('W3 asset binding targeted local PostgreSQL',()=>{
  it.skipIf(!realUrl)('persists server-generated asset and requires exact bilateral quote hash before commercial create',async()=>{
    await runtimeFixture();
    await pg.query('UPDATE agent_market.agents SET owner_wallet=$1 WHERE id=$2',[owner,agent]);
    await pg.query('DELETE FROM agent_market.risk_quotes');
    const {commercialDatabase}=await import('./runtime');
    const {RiskPricingService}=await import('../application/risk-pricing-service');
    const {configuredRiskAsset}=await import('../application/risk-asset');
    const runtimeDb=commercialDatabase(sql!);
    const quotes=new PostgresRiskQuoteStore(sql!);
    const pricing=new RiskPricingService({quotes,tasks:{loadAuthoritativeTask:id=>runtimeDb.transaction(q=>q.riskTask!(id))},assetId:()=>configuredRiskAsset({AGENT_MARKET_YD_TOKEN_ADDRESS:'0x5555555555555555555555555555555555555555'}),assessor:{assess:async()=>({factors:{complexity:30,acceptanceAmbiguity:30,externalDependency:30,dataSensitivity:30,financialRisk:30,irreversibility:30,deadlineRisk:30,agentUncertainty:30},reasonCodes:['test_case']})}});
    const context=await pricing.readRiskContext({taskId:task,actorWallet:owner});
    expect(context).toMatchObject({assetId:policy.assetId,quoteSchemaVersion:2});
    const {createRiskQuoteHandler}=await import('../app/api/tasks/[taskId]/risk-quote/route');
    const {createRiskQuoteConfirmationHandler}=await import('../app/api/tasks/[taskId]/risk-quote/confirm/route');
    const authOrigin=new URL('https://app.test');
    const request=(body:unknown)=>new Request('https://app.test/api/test',{method:'POST',headers:{origin:authOrigin.origin,cookie:'__Host-agent_market_session=test-only','content-type':'application/json'},body:JSON.stringify(body)});
    const issueHandler=createRiskQuoteHandler({service:pricing,authOrigin,auth:{authenticateSession:async()=>({walletAddress:owner})}});
    const issuedResponse=await issueHandler(request({taskFingerprint:context.taskFingerprint}),task);
    expect(issuedResponse.status).toBe(201);
    const publicQuote=await issuedResponse.json();
    const issued=(await quotes.find(publicQuote.quoteId))!;
    expect(publicQuote.quoteHash).toBe(issued.basisFingerprint);
    const confirmHandler=createRiskQuoteConfirmationHandler({service:pricing,authOrigin,auth:{authenticateSession:async()=>({walletAddress:owner})}});
    expect((await confirmHandler(request({quoteId:issued.id,taskFingerprint:context.taskFingerprint}),task)).status).toBe(400);
    expect((await quotes.find(issued.id))?.quote).toMatchObject({schemaVersion:2,assetId:policy.assetId});
    const confirm={taskId:task,quoteId:issued.id,taskFingerprint:context.taskFingerprint,quoteHash:issued.basisFingerprint};
    await expect(pricing.confirmQuote({...confirm,actorWallet:owner,actorType:'publisher',quoteHash:'sha256:'+'0'.repeat(64)})).rejects.toThrow('HASH_MISMATCH');
    await expect(pricing.confirmQuote({...confirm,actorWallet:owner,actorType:'publisher',taskFingerprint:'sha256:'+'0'.repeat(64)})).rejects.toThrow('FINGERPRINT_MISMATCH');
    expect((await confirmHandler(request({quoteId:confirm.quoteId,taskFingerprint:confirm.taskFingerprint,quoteHash:confirm.quoteHash,actorType:'publisher'}),task)).status).toBe(200);
    service=new CommercialService(runtimeDb,policy);
    await expect(exec(owner,create)).rejects.toThrow('ACCEPTED_QUOTE_REQUIRED');
    await pricing.confirmQuote({...confirm,actorWallet:owner,actorType:'agent',agentId:agent});
    expect((await exec(owner,create)).acceptedQuote.quote.assetId).toBe(policy.assetId);
    const confirmations=(await pg.query('SELECT actor_type,actor_wallet,agent_id,quote_hash FROM agent_market.risk_quote_confirmations ORDER BY actor_type DESC')).rows;
    expect(confirmations).toEqual([
      {actor_type:'publisher',actor_wallet:owner,agent_id:null,quote_hash:issued.basisFingerprint},
      {actor_type:'agent',actor_wallet:owner,agent_id:agent,quote_hash:issued.basisFingerprint},
    ]);
    await expect(pg.query("UPDATE agent_market.risk_quote_confirmations SET quote_hash=$1",['sha256:'+'0'.repeat(64)])).rejects.toThrow('HASH_MISMATCH');
  });
  it.skipIf(!realUrl)('refuses wrong chain or token on commercial create and missing server configuration',async()=>{
    await runtimeFixture();
    const {commercialDatabase}=await import('./runtime');
    const {RiskPricingService}=await import('../application/risk-pricing-service');
    const {configuredRiskAsset}=await import('../application/risk-asset');
    const runtimeDb=commercialDatabase(sql!);
    for(const assetId of [policy.assetId.replace('11155111','1'),policy.assetId.replaceAll('5','6')]){
      service=new CommercialService(runtimeDb,{...policy,assetId});
      await expect(exec(owner,create)).rejects.toThrow('COMMERCIAL_ASSET_MISMATCH');
    }
    const pricing=new RiskPricingService({quotes:new PostgresRiskQuoteStore(sql!),tasks:{loadAuthoritativeTask:id=>runtimeDb.transaction(q=>q.riskTask!(id))},assetId:()=>configuredRiskAsset({})});
    await expect(pricing.readRiskContext({taskId:task,actorWallet:owner})).rejects.toThrow('MISSING_AGENT_MARKET_YD_TOKEN_ADDRESS');
    expect((await pg.query('SELECT * FROM agent_market.commercial_orders')).rows).toHaveLength(0);
  });
  it.skipIf(!realUrl)('keeps legacy quote unchanged and readable, but rejects confirmation funding and create',async()=>{
    await runtimeFixture();
    const {commercialDatabase}=await import('./runtime');
    const store=new PostgresRiskQuoteStore(sql!);
    const existing=(await store.find(quoteId))!;
    const {assetId:_asset,schemaVersion:_version,...legacy}=existing.quote;
    await pg.query('DELETE FROM agent_market.risk_quotes');
    await pg.query("INSERT INTO agent_market.risk_quotes(id,task_id,quote_version,phase,task_fingerprint,dag_revision,policy_version,basis_fingerprint,quote_payload,manual_review_required,expires_at,status,created_at) VALUES($1,$2,1,'final',$3,1,'risk-pricing-v2',$4,$5::text::jsonb,false,$6,'active',now())",[quoteId,task,legacy.taskFingerprint,existing.basisFingerprint,JSON.stringify(legacy),legacy.expiresAt]);
    expect((await store.find(quoteId))?.quote).toEqual(legacy);
    await expect(store.confirm({quoteId,actorType:'publisher',actorWallet:owner,taskFingerprint:legacy.taskFingerprint,quoteHash:existing.basisFingerprint,confirmedAt:new Date().toISOString()})).rejects.toThrow('REQUOTE_REQUIRED');
    expect(await store.evaluateFunding({taskId:task,quoteId,taskFingerprint:legacy.taskFingerprint,evaluatedAt:new Date().toISOString()})).toMatchObject({status:'blocked',code:'RISK_QUOTE_REQUOTE_REQUIRED'});
    service=new CommercialService(commercialDatabase(sql!),policy);
    await expect(exec(owner,create)).rejects.toThrow('COMMERCIAL_REBIND_REQUIRED');
    expect((await pg.query('SELECT * FROM agent_market.risk_quote_confirmations')).rows).toHaveLength(0);
  });
});
