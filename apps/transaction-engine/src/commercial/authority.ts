import { RiskQuoteSchema, type RiskQuote } from '@agent-market/shared-contracts';
import type { AuthoritativeRiskTask } from '../application/risk-pricing-service';
import { fingerprintRiskTask } from '../application/risk-pricing-service';
import { allocateAgentTeamDeposit } from '../application/risk-engine';
import { CommercialError, type Child, type Query } from './service';
export interface AcceptedQuote {
  id: string; version: number; boundTaskVersion: number; fingerprint: string; policyVersion: string; dagRevision: number;
  quote: RiskQuote; agents: { agentId: string; agentWallet: string; amountAtomic: string }[];
}
export type RiskLoader = (id: string) => Promise<AuthoritativeRiskTask | null>;
const reject = (): never => { throw new CommercialError('COMMERCIAL_ACCEPTED_QUOTE_REQUIRED'); };
export async function acceptedQuote(q: Query, taskId: string, children: Child[], publisher: string, taskVersion: number, assetId: string): Promise<AcceptedQuote> {
  if (!q.riskTask) return reject();
  const task = await q.riskTask(taskId);
  if (!task?.dag?.finalized || task.publisherWallet !== publisher) return reject();
  const row = (await q("SELECT * FROM agent_market.risk_quotes WHERE task_id=$1 AND status='active' FOR SHARE", [taskId]))[0];
  if (!row) return reject();
  const parsed = RiskQuoteSchema.safeParse(row.quote_payload);
  if (!parsed.success) return reject();
  const quote = parsed.data;
  if (quote.schemaVersion !== 2 || !quote.assetId) throw new CommercialError("COMMERCIAL_REBIND_REQUIRED");
  if (quote.assetId !== assetId) throw new CommercialError("COMMERCIAL_ASSET_MISMATCH");
  if (quote.phase !== 'final' || quote.taskFingerprint !== fingerprintRiskTask(task, assetId) || quote.P !== task.budgetAtomic
    || Number(row.dag_revision) !== task.dag.revision || row.task_fingerprint !== quote.taskFingerprint
    || row.policy_version !== quote.policyVersion || new Date(quote.expiresAt).getTime() <= Date.now()
    || (quote.manualReviewRequired && (!row.manual_approved_at || !row.manual_approved_by))) return reject();
  // Reuse the existing risk allocation algorithm; no new commercial deposit formula.
  const allocations = allocateAgentTeamDeposit(quote.A, task.dag.assignments.map(({ agentWallet: _wallet, ...node }) => node));
  if (allocations.some(a => quote.agentAllocations.find(b => b.agentId === a.agentId)?.amountAtomic !== a.amountAtomic)
    || allocations.length !== quote.agentAllocations.length) return reject();
  const agents = await q('SELECT agent_id,agent_wallet,amount_atomic::text FROM agent_market.risk_quote_agent_allocations WHERE quote_id=$1 FOR SHARE', [row.id]);
  const confirmations = await q('SELECT * FROM agent_market.risk_quote_confirmations WHERE quote_id=$1 FOR SHARE', [row.id]);
  const confirms = (wallet: string, agentId?: string) => confirmations.some(c => c.actor_wallet === wallet
    && c.actor_type === (agentId ? 'agent' : 'publisher') && c.agent_id === (agentId ?? null)
    && c.quote_hash === row.basis_fingerprint
    && c.actor_key === (agentId ?? wallet) && c.task_fingerprint === quote.taskFingerprint
    && new Date(String(c.confirmed_at)).getTime() < new Date(quote.expiresAt).getTime());
  if (!confirms(publisher) || agents.length !== allocations.length || new Set(children.map(c => c.agentId)).size !== agents.length) return reject();
  for (const agent of agents) {
    if (!confirms(String(agent.agent_wallet), String(agent.agent_id))
      || !children.some(c => c.agentId === agent.agent_id && c.agentWallet === agent.agent_wallet)
      || children.some(c => c.agentId === agent.agent_id && c.agentWallet !== agent.agent_wallet)
      || task.dag.assignments.find(a => a.agentId === agent.agent_id)?.agentWallet !== agent.agent_wallet
      || quote.agentAllocations.find(a => a.agentId === agent.agent_id)?.amountAtomic !== agent.amount_atomic) return reject();
  }
  return { id: String(row.id), version: Number(row.quote_version), boundTaskVersion: taskVersion, fingerprint: quote.taskFingerprint, policyVersion: quote.policyVersion, dagRevision: task.dag.revision,
    quote, agents: agents.map(a => ({ agentId: String(a.agent_id), agentWallet: String(a.agent_wallet), amountAtomic: String(a.amount_atomic) })) };
}

/** Verify every persisted lifecycle hop, not just a numerically newer version. */
export async function verifyProgress(q: Query, id: string, fromVersion: number, toVersion: number, toStatus: string, fromStatus?: string) {
  const conflict = (): never => { throw new CommercialError('COMMERCIAL_SOURCE_CONFLICT'); };
  if (!Number.isSafeInteger(fromVersion) || !Number.isSafeInteger(toVersion) || fromVersion < 1 || toVersion < fromVersion) return conflict();
  if (toVersion === fromVersion) { if (fromStatus && fromStatus !== toStatus) return conflict(); return; }
  const events = await q("SELECT event_type,payload FROM agent_market.task_events WHERE task_id=$1 AND (payload->>'version')::integer > $2 AND (payload->>'version')::integer <= $3 ORDER BY (payload->>'version')::integer", [id,fromVersion,toVersion]);
  const transitions: Record<string,[string,string]> = { mark_funding_pending:['open','funding_pending'],confirm_funding:['funding_pending','funded'],start_matching:['funded','matching'],assign_agent:['matching','assigned'],accept_assignment:['assigned','in_progress'],submit_artifact:['in_progress','submitted'],accept_delivery:['submitted','accepted'],settle:['accepted','settled'] };
  let version = fromVersion, status = fromStatus;
  for (const event of events) {
    const payload = event.payload as Record<string,unknown>, transition = transitions[String(event.event_type)];
    if (!payload || !transition || payload.version !== version+1 || (status && payload.from !== status) || payload.from !== transition[0] || payload.to !== transition[1]) return conflict();
    version++; status = String(payload.to);
  }
  if (version !== toVersion || status !== toStatus) return conflict();
}
