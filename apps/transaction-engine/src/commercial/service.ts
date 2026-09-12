import { createHash, randomUUID } from 'node:crypto';
import { OrderArtifactSchema, WalletAddressSchema, type OrderArtifact } from '@agent-market/shared-contracts';
import { validate as isUuid } from 'uuid';
import { acceptedQuote, verifyProgress, type AcceptedQuote, type RiskLoader } from './authority';

export type Row = Record<string, unknown>;
export type Query = ((sql: string, values?: unknown[]) => Promise<Row[]>) & { riskTask?: RiskLoader; riskMaterial?: (id: string) => Promise<unknown> };
export interface Database { query: Query; transaction<T>(fn: (query: Query) => Promise<T>): Promise<T> }
export interface Policy { assetId: string; platformWallet: string; feeBps: number }
export interface PayoutObservation { receiptId: string; claimId: string; assetId: string; beneficiary: string; amountAtomic: string; status: 'confirmed' }
export interface IncomeObservation { receiptId: string; orderId: string; assetId: string; amountAtomic: string; providerId: string; kind: 'yield' | 'penalty'; status: 'confirmed'; beneficiary: string; authorizationId: string; quoteId: string; taskFingerprint: string; principalSource?: 'symmetric_deposits'; consentWallets?: string[]; depositId?: string }
/** Implementations must independently verify finality, asset, transfer identity and canonicality.
 * These ports are server-only. HTTP never accepts receipt contents or provider URLs. */
export interface ObservationReader {
  payout(claim: Claim, order: CommercialOrder): Promise<PayoutObservation | null>;
  income(order: CommercialOrder): Promise<IncomeObservation[]>;
  /** Independent final adjudication, never an LLM quality verdict or client assertion. */
  settlement?(order: CommercialOrder): Promise<{ orderId: string; quoteId: string; taskFingerprint: string; decisionId: string; status: 'final'; outcome: 'force_majeure' | 'responsibility'; cancelledChildIds: string[] } | null>;
}
export interface Child { id: string; agentId: string; agentWallet: string; budgetAtomic: string; status: 'assigned' | 'submitted' | 'accepted' | 'cancelled'; artifact?: OrderArtifact }
export interface Entry { id: string; kind: 'node' | 'platform' | 'refund' | 'yield' | 'penalty' | 'deposit_return'; beneficiary: string; amountAtomic: string; childId?: string }
export interface Claim { id: string; entryId: string; beneficiary: string; amountAtomic: string; status: 'pending_external' | 'confirmed'; receiptId?: string }
export interface CommercialOrder {
  id: string; publisherWallet: string; sourceVersion: number; budgetAtomic: string; assetId: string;
  platformWallet: string; feeBps: number; children: Child[]; observedYieldAtomic: string;
  platformFeeAtomic: string; feePolicy: 'budget-plus-service-fee.v1';
  observedPenaltyAtomic: string; manifest: { id: string; hash: string; assetId: string; entries: Entry[] } | null;
  claims: Claim[];
  acceptedQuote: AcceptedQuote; sourceStatus: string; sourceMaterialHash: string; sourceRiskHash: string;
  deposits: { id: string; owner: string; amountAtomic: string; forfeitedAtomic: string }[];
  income: IncomeObservation[]; resolution?: { decisionId: string; outcome: string; cancelledChildIds: string[] };
}
export class CommercialError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
const fail = (code: string, status = 409): never => { throw new CommercialError(`COMMERCIAL_${code}`, status); };
const amount = (value: unknown, positive = false): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/u.test(value)) return fail('AMOUNT_INVALID', 400);
  const result = BigInt(value);
  if (positive && result === 0n) return fail('AMOUNT_INVALID', 400);
  return result;
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const text = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160) return fail('INPUT_INVALID', 400);
  return value;
};
const uuid = (value: unknown): string => { const id = text(value); if (!isUuid(id)) return fail('ID_INVALID', 400); return id; };
const object = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INPUT_INVALID', 400);
  return value as Row;
};
function command(value: unknown): Row {
  const body = object(value);
  const keys: Record<string, string[]> = { create: ['children'], submit: ['childId', 'artifact'], accept: ['childId'], cancel: ['childId'], manifest: [], claim: ['entryId'], reconcile: ['entryId'], observe_income: [] };
  const type = text(body.type);
  if (!Object.hasOwn(keys, type) || Object.keys(body).some(k => k !== 'type' && !keys[type]!.includes(k)) || keys[type]!.some(k => !(k in body))) fail('COMMAND_INVALID', 400);
  return body;
}
function authorized(order: CommercialOrder, actor: string): void {
  if (order.publisherWallet !== actor && !order.children.some(c => c.agentWallet === actor) && !order.manifest?.entries.some(e => e.beneficiary === actor)) fail('FORBIDDEN', 403);
}

const row = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
function matchesFinalizedGraph(rawMaterial: unknown, dagRevision: number, children: readonly Child[]): boolean {
  const material = row(rawMaterial);
  if (!material || !Array.isArray(material.workflows) || !Array.isArray(material.facts)) return false;
  const workflows = material.workflows.map(row).filter((value): value is Row => value !== null).filter(value => {
    const graph = row(value.graph);
    return Number(value.confirmed) === dagRevision && Number(graph?.graphRevision) === dagRevision;
  });
  if (workflows.length !== 1) return false;
  const graph = row(workflows[0]!.graph);
  if (!graph || !Array.isArray(graph.nodes)) return false;
  const facts = material.facts.map(row).filter((value): value is Row => value !== null)
    .map(value => row(value.value)).filter((value): value is Row => value !== null)
    .filter(value => Number(value.graph_revision) === dagRevision);
  if (facts.length !== graph.nodes.length || children.length !== graph.nodes.length) return false;
  const factsByNode = new Map<string, Row>();
  for (const fact of facts) {
    if (typeof fact.node_id !== 'string' || factsByNode.has(fact.node_id)) return false;
    factsByNode.set(fact.node_id, fact);
  }
  const expected: { id: string; agentId: string; budgetAtomic: string }[] = [];
  for (const rawNode of graph.nodes) {
    const node = row(rawNode), contract = row(node?.contract);
    const id = node?.nodeId, budgetAtomic = contract?.budgetAtomic;
    if (typeof id !== 'string' || typeof budgetAtomic !== 'string' || !/^[1-9][0-9]{0,77}$/u.test(budgetAtomic)) return false;
    const fact = factsByNode.get(id);
    if (!fact || typeof fact.market_agent_id !== 'string' || expected.some(value => value.id === id)) return false;
    expected.push({ id, agentId: fact.market_agent_id, budgetAtomic });
  }
  const sort = (left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id);
  const actual = children.map(({ id, agentId, budgetAtomic }) => ({ id, agentId, budgetAtomic }));
  return canonical(expected.sort(sort)) === canonical(actual.sort(sort));
}

export class CommercialService {
  constructor(private readonly db: Database, private readonly policy: Policy, private readonly observations?: ObservationReader) {
    if (!policy.assetId || policy.assetId.length > 160 || !WalletAddressSchema.safeParse(policy.platformWallet).success || !Number.isInteger(policy.feeBps) || policy.feeBps < 0 || policy.feeBps > 10000) fail('POLICY_UNAVAILABLE', 503);
  }
  async execute(orderId: string, actor: string, key: string, input: unknown): Promise<CommercialOrder> {
    uuid(orderId);
    if (!WalletAddressSchema.safeParse(actor).success) fail('FORBIDDEN', 403);
    if (typeof key !== 'string' || key.length < 8 || key.length > 160) fail('IDEMPOTENCY_INVALID', 400);
    const body = command(input), fingerprint = hash(body);
    return this.db.transaction(async q => {
      // Shared task lock serializes against existing order commands and commercial creation.
      const source = (await q('SELECT publisher_wallet,budget_atomic::text,version,status,to_jsonb(tasks) AS material FROM agent_market.tasks WHERE id=$1 FOR UPDATE', [orderId]))[0];
      if (!source) return fail('NOT_FOUND', 404);
      const row = (await q('SELECT state FROM agent_market.commercial_orders WHERE task_id=$1 FOR UPDATE', [orderId]))[0];
      let order = row?.state as CommercialOrder | undefined;
      if (order) authorized(order, actor);
      else if (source.publisher_wallet !== actor) fail('FORBIDDEN', 403);
      if (order) await this.checkSource(q, order, source, body);
      const prior = (await q('SELECT fingerprint,response FROM agent_market.commercial_commands WHERE task_id=$1 AND actor_wallet=$2 AND idempotency_key=$3', [orderId, actor, key]))[0];
      if (prior) {
        if (prior.fingerprint !== fingerprint) return fail('IDEMPOTENCY_CONFLICT');
        return prior.response as CommercialOrder;
      }
      if (body.type === 'create') {
        if (order) return fail('EXISTS_CONFLICT');
        if (!['open','funded','matching','assigned','in_progress'].includes(String(source.status))) fail('SOURCE_CONFLICT');
        if (!Array.isArray(body.children) || body.children.length < 1 || body.children.length > 100) fail('CHILDREN_INVALID', 400);
        const children: Child[] = [];
        let total = 0n;
        for (const value of body.children as unknown[]) {
          const child = object(value);
          if (Object.keys(child).some(k => !['id','agentId','budgetAtomic'].includes(k))) fail('CHILDREN_INVALID', 400);
          const id = text(child.id), agentId = uuid(child.agentId), allocation = amount(child.budgetAtomic, true);
          if (!/^[A-Za-z0-9_-]{1,80}$/u.test(id) || children.some(c => c.id === id)) fail('CHILDREN_INVALID', 400);
          const agent = (await q('SELECT owner_wallet,status FROM agent_market.agents WHERE id=$1 FOR SHARE', [agentId]))[0];
          if (!agent || agent.status !== 'published' || !WalletAddressSchema.safeParse(agent.owner_wallet).success) return fail('AGENT_INVALID', 400);
          children.push({ id, agentId, agentWallet: String(agent.owner_wallet), budgetAtomic: allocation.toString(), status: 'assigned' });
          total += allocation;
        }
        if (total > amount(source.budget_atomic)) fail('BUDGET_CONFLICT');
        // P is Agent principal; B is additional publisher consideration, not a haircut.
        // Ceil rounding matches risk quotes. This obligation is not funding proof.
        if (!q.riskMaterial) return fail('RISK_CONTEXT_UNAVAILABLE', 503);
        const riskMaterial = await q.riskMaterial(orderId);
        const riskHash = hash(riskMaterial);
        const binding = await acceptedQuote(q, orderId, children, actor, Number(source.version), this.policy.assetId);
        if (!matchesFinalizedGraph(riskMaterial, binding.dagRevision, children)) fail('SOURCE_CONFLICT');
        if (hash(await q.riskMaterial(orderId)) !== riskHash) fail('SOURCE_CONFLICT');
        const platformFeeAtomic = binding.quote.B;
        const deposits = [{ id: 'publisher', owner: actor, amountAtomic: binding.quote.A, forfeitedAtomic: '0' },
          ...binding.agents.map(a => ({ id: `agent:${a.agentId}`, owner: a.agentWallet, amountAtomic: a.amountAtomic, forfeitedAtomic: '0' }))];
        if (!q.riskMaterial) return fail('RISK_CONTEXT_UNAVAILABLE', 503);
        order = { id: orderId, publisherWallet: actor, sourceVersion: Number(source.version), budgetAtomic: String(source.budget_atomic), ...this.policy, feeBps: binding.quote.serviceFeeBps, acceptedQuote: binding, deposits, income: [], sourceStatus: String(source.status), sourceMaterialHash: this.materialHash(source), sourceRiskHash: riskHash, platformFeeAtomic, feePolicy: 'budget-plus-service-fee.v1', children, observedYieldAtomic: '0', observedPenaltyAtomic: '0', manifest: null, claims: [] };
        await q('INSERT INTO agent_market.commercial_orders(task_id,state) VALUES($1,$2::text::jsonb)', [orderId, JSON.stringify(order)]);
      } else {
        if (!order) return fail('NOT_FOUND', 404);
        await this.apply(q, order, actor, body);
      }
      await q('UPDATE agent_market.commercial_orders SET state=$2::text::jsonb,updated_at=now() WHERE task_id=$1', [orderId, JSON.stringify(order)]);
      await q('INSERT INTO agent_market.commercial_commands(task_id,actor_wallet,idempotency_key,fingerprint,response) VALUES($1,$2,$3,$4,$5::text::jsonb)', [orderId, actor, key, fingerprint, JSON.stringify(order)]);
      return order;
    });
  }
  private materialHash(source: Row) {
    const material = { ...object(source.material) };
    for (const key of ['status','version','updated_at','accepted_at','delivery_uri','manual_review_from_status','manual_review_reason_code']) delete material[key];
    return hash(material);
  }
  private async checkSource(q: Query, order: CommercialOrder, source: Row, body: Row) {
    if (!order.acceptedQuote || order.acceptedQuote.quote.schemaVersion !== 2 || !order.acceptedQuote.quote.assetId || !order.sourceMaterialHash) fail('REBIND_REQUIRED');
    if (order.assetId !== order.acceptedQuote.quote.assetId || order.assetId !== this.policy.assetId) fail('ASSET_MISMATCH');
    if (!q.riskMaterial || hash(await q.riskMaterial(order.id)) !== order.sourceRiskHash) fail('SOURCE_CONFLICT');
    if (this.materialHash(source) !== order.sourceMaterialHash || !['open','funding_pending','funded','matching','assigned','in_progress','submitted','accepted','settled'].includes(String(source.status))) fail('SOURCE_CONFLICT');
    const quote = (await q('SELECT status FROM agent_market.risk_quotes WHERE id=$1 FOR SHARE', [order.acceptedQuote.id]))[0];
    if (quote?.status !== 'active') fail('SOURCE_CONFLICT');
    const current = Number(source.version);
    if (!Number.isSafeInteger(current) || current < order.sourceVersion) fail('SOURCE_CONFLICT');
    await verifyProgress(q, order.id, order.sourceVersion, current, String(source.status), order.sourceStatus);
    order.sourceVersion = current; order.sourceStatus = String(source.status);
    if (source.status === 'settled' && (!order.manifest || !['claim','reconcile'].includes(String(body.type)))) fail('SOURCE_CONFLICT');
  }
  private async journal(q: Query, order: CommercialOrder, event: string, kind: string, debit: string, credit: string, value: string) {
    if (amount(value) === 0n) return;
    await q('INSERT INTO agent_market.commercial_journal(id,task_id,event_key,asset_id,kind,debit_account,credit_account,amount_atomic) VALUES($1,$2,$3,$4,$5,$6,$7,$8::numeric)', [randomUUID(), order.id, event, order.assetId, kind, debit, credit, value]);
  }
  private async receipt(q: Query, order: CommercialOrder, receipt: IncomeObservation | PayoutObservation): Promise<boolean> {
    text(receipt.receiptId);
    const rows = await q('INSERT INTO agent_market.commercial_receipts(receipt_id,task_id,payload) VALUES($1,$2,$3::text::jsonb) ON CONFLICT DO NOTHING RETURNING receipt_id', [receipt.receiptId, order.id, JSON.stringify(receipt)]);
    if (rows.length) return true;
    const existing = (await q('SELECT task_id,payload FROM agent_market.commercial_receipts WHERE receipt_id=$1', [receipt.receiptId]))[0];
    if (!existing || existing.task_id !== order.id || canonical(existing.payload) !== canonical(receipt)) fail('RECEIPT_CONFLICT');
    return false;
  }
  private async apply(q: Query, order: CommercialOrder, actor: string, body: Row) {
    const ownerOnly = () => { if (actor !== order.publisherWallet) fail('FORBIDDEN', 403); };
    if (['submit','accept','cancel'].includes(String(body.type))) {
      if (order.manifest) fail('TRANSITION_CONFLICT');
      const child = order.children.find(c => c.id === text(body.childId));
      if (!child) return fail('CHILD_NOT_FOUND', 404);
      if (body.type === 'submit') {
        if (actor !== child.agentWallet) fail('FORBIDDEN', 403);
        const agent = (await q('SELECT owner_wallet,status FROM agent_market.agents WHERE id=$1 FOR SHARE', [child.agentId]))[0];
        if (!agent || agent.owner_wallet !== actor || agent.status !== 'published') fail('FORBIDDEN', 403);
        if (!['assigned','submitted'].includes(child.status)) fail('TRANSITION_CONFLICT');
        const parsed = OrderArtifactSchema.safeParse(body.artifact);
        if (!parsed.success) return fail('ARTIFACT_INVALID', 400);
        child.artifact = parsed.data;
        child.status = 'submitted';
      } else {
        ownerOnly();
        if (body.type === 'accept') {
          if (child.status !== 'submitted') fail('TRANSITION_CONFLICT');
          child.status = 'accepted';
        } else {
          // Submitted work cannot be unilaterally cancelled; disputes stay in the existing adjudication flow.
          if (child.status !== 'assigned') fail('TRANSITION_CONFLICT');
          child.status = 'cancelled';
        }
      }
    } else if (body.type === 'observe_income') {
      ownerOnly();
      if (order.manifest) fail('TRANSITION_CONFLICT');
      if (!this.observations) return fail('EXTERNAL_UNAVAILABLE', 503);
      const receipts = await this.observations.income(structuredClone(order));
      if (receipts.length > 1000) fail('RECEIPT_INVALID', 400);
      for (const receipt of receipts) {
        if (receipt.status !== 'confirmed' || receipt.orderId !== order.id || receipt.assetId !== order.assetId || receipt.quoteId !== order.acceptedQuote.id || receipt.taskFingerprint !== order.acceptedQuote.fingerprint || !['yield','penalty'].includes(receipt.kind)) fail('RECEIPT_CONFLICT');
        text(receipt.providerId); text(receipt.authorizationId);
        if (!WalletAddressSchema.safeParse(receipt.beneficiary).success) fail('INCOME_AUTHORITY_REQUIRED');
        if (receipt.kind === 'yield') {
          // PRD section 7: only consented, observed deposit yield belongs to platform.
          const participants = [order.publisherWallet, ...order.acceptedQuote.agents.map(a => a.agentWallet)];
          if (receipt.principalSource !== 'symmetric_deposits' || receipt.beneficiary !== order.platformWallet || participants.some(w => !receipt.consentWallets?.includes(w))) fail('INCOME_AUTHORITY_REQUIRED');
        } else {
          const deposit = order.deposits.find(d => d.id === receipt.depositId);
          if (!deposit || receipt.beneficiary === order.platformWallet || receipt.beneficiary === deposit.owner
            || !order.deposits.some(d => d.owner === receipt.beneficiary)) fail('INCOME_AUTHORITY_REQUIRED');
        }
        const value = amount(receipt.amountAtomic, true);
        if (!await this.receipt(q, order, receipt)) continue;
        if (receipt.kind === 'penalty') {
          const deposit = order.deposits.find(d => d.id === receipt.depositId)!;
          deposit.forfeitedAtomic = (amount(deposit.forfeitedAtomic) + value).toString();
          if (amount(deposit.forfeitedAtomic) > amount(deposit.amountAtomic)) fail('DEPOSIT_CONFLICT');
        }
        order.income.push(receipt);
        const field = receipt.kind === 'yield' ? 'observedYieldAtomic' : 'observedPenaltyAtomic';
        order[field] = (amount(order[field]) + value).toString();
        amount(order[field]);
        await this.journal(q, order, `income:${receipt.receiptId}`, `observed_${receipt.kind}`, receipt.kind === 'penalty' ? `deposit_obligation:${receipt.depositId}` : `observed_assets:${receipt.providerId}`, `income_pool:${receipt.kind}`, receipt.amountAtomic);
      }
    } else if (body.type === 'manifest') {
      ownerOnly();
      if (order.manifest) return;
      if (order.children.some(c => !['accepted','cancelled'].includes(c.status))) fail('TRANSITION_CONFLICT');
      const entries: Entry[] = [];
      const append = (kind: Entry['kind'], beneficiary: string, value: bigint, childId?: string) => {
        if (value > 0n) entries.push({ id: randomUUID(), kind, beneficiary, amountAtomic: value.toString(), ...(childId ? { childId } : {}) });
      };
      let used = 0n;
      for (const child of order.children) if (child.status === 'accepted') {
        const budget = amount(child.budgetAtomic);
        append('node', child.agentWallet, budget, child.id);
        used += budget;
      }
      const fees = amount(order.platformFeeAtomic);
      append('platform', order.platformWallet, fees);
      append('refund', order.publisherWallet, amount(order.budgetAtomic) - used);
      for (const receipt of order.income) append(receipt.kind, receipt.beneficiary, amount(receipt.amountAtomic));
      // Cancellation or responsibility disputes need independent resolution; no automatic release.
      if (order.children.some(c => c.status !== 'accepted') || amount(order.observedPenaltyAtomic) > 0n) {
        const resolution = await this.observations?.settlement?.(structuredClone(order));
        const cancelled = order.children.filter(c => c.status === 'cancelled').map(c => c.id).sort();
        if (!resolution || resolution.status !== 'final' || resolution.orderId !== order.id
          || resolution.quoteId !== order.acceptedQuote.id || resolution.taskFingerprint !== order.acceptedQuote.fingerprint
          || !resolution.decisionId || canonical([...resolution.cancelledChildIds].sort()) !== canonical(cancelled)
          || !['force_majeure','responsibility'].includes(resolution.outcome)
          || (resolution.outcome === 'force_majeure' && amount(order.observedPenaltyAtomic) > 0n)
          || order.income.some(r => r.kind === 'penalty' && r.authorizationId !== resolution.decisionId)) return fail('DEPOSIT_RESOLUTION_REQUIRED');
        order.resolution = { decisionId: resolution.decisionId, outcome: resolution.outcome, cancelledChildIds: resolution.cancelledChildIds };
      }
      for (const deposit of order.deposits) append('deposit_return', deposit.owner, amount(deposit.amountAtomic) - amount(deposit.forfeitedAtomic), deposit.id);
      const total = entries.reduce((sum,e) => sum + amount(e.amountAtomic), 0n);
      if (total !== amount(order.budgetAtomic) + fees + 2n * amount(order.acceptedQuote.quote.A) + amount(order.observedYieldAtomic)) fail('BUDGET_CONFLICT');
      order.manifest = { id: randomUUID(), hash: hash({ orderId: order.id, assetId: order.assetId, feePolicy: order.feePolicy, budgetAtomic: order.budgetAtomic, platformFeeAtomic: order.platformFeeAtomic, acceptedQuote: order.acceptedQuote, deposits: order.deposits, resolution: order.resolution ?? null, income: order.income, entries }), assetId: order.assetId, entries };
      for (const entry of entries) await this.journal(q, order, `manifest:${entry.id}`, entry.kind, ['yield','penalty'].includes(entry.kind) ? `income_pool:${entry.kind}` : entry.kind === 'platform' ? 'service_fee_obligation' : entry.kind === 'deposit_return' ? `deposit_obligation:${entry.childId}` : 'budget_obligation', `payable:${entry.id}:${entry.beneficiary}`, entry.amountAtomic);
    } else if (body.type === 'claim' || body.type === 'reconcile') {
      const entry = order.manifest?.entries.find(e => e.id === text(body.entryId));
      if (!entry) return fail('ENTRY_NOT_FOUND', 404);
      if (actor !== entry.beneficiary) fail('FORBIDDEN', 403);
      let claim = order.claims.find(c => c.entryId === entry.id);
      if (body.type === 'claim') {
        if (!claim) { claim = { id: randomUUID(), entryId: entry.id, beneficiary: actor, amountAtomic: entry.amountAtomic, status: 'pending_external' }; order.claims.push(claim); }
        return;
      }
      if (!claim) return fail('TRANSITION_CONFLICT');
      if (claim.status === 'confirmed') return;
      if (!this.observations) return fail('EXTERNAL_UNAVAILABLE', 503);
      const receipt = await this.observations.payout(structuredClone(claim), structuredClone(order));
      if (!receipt) return fail('EXTERNAL_PENDING', 409);
      if (receipt.status !== 'confirmed' || receipt.claimId !== claim.id || receipt.assetId !== order.assetId || receipt.beneficiary !== claim.beneficiary || receipt.amountAtomic !== claim.amountAtomic) fail('RECEIPT_CONFLICT');
      if (!await this.receipt(q, order, receipt)) fail('RECEIPT_CONFLICT');
      await this.journal(q, order, `payment:${claim.id}`, 'payment', `payable:${entry.id}:${entry.beneficiary}`, 'observed_external_payments', claim.amountAtomic);
      claim.status = 'confirmed'; claim.receiptId = receipt.receiptId;
    }
  }
  async read(orderId: string, actor: string) {
    uuid(orderId);
    return this.db.transaction(async q => {
      const row = (await q('SELECT state FROM agent_market.commercial_orders WHERE task_id=$1 FOR SHARE', [orderId]))[0];
      if (!row) return fail('NOT_FOUND', 404);
      const order = row.state as CommercialOrder;
      authorized(order, actor);
      const balances = await q('SELECT * FROM agent_market.commercial_balances WHERE task_id=$1 ORDER BY account', [orderId]);
      const journal = await q('SELECT kind,amount_atomic::text FROM agent_market.commercial_journal WHERE task_id=$1', [orderId]);
      let obligations = 0n, paid = 0n;
      for (const row of journal) {
        if (row.kind === 'payment') paid += amount(row.amount_atomic);
        else if (!String(row.kind).startsWith('observed_')) obligations += amount(row.amount_atomic);
      }
      const debits = balances.reduce((s,r) => s + amount(r.debit_atomic), 0n);
      const credits = balances.reduce((s,r) => s + amount(r.credit_atomic), 0n);
      const manifestTotal = order.manifest?.entries.reduce((s,e) => s + amount(e.amountAtomic), 0n) ?? 0n;
      return { order, reconciliation: { balanced: debits === credits && obligations === manifestTotal, journalAtomic: obligations.toString(), paidAtomic: paid.toString(), outstandingAtomic: (obligations-paid).toString(), balances, evidence: 'accounting_projection_not_funding_proof' } };
    });
  }
}
