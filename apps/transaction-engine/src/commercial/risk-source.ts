import { authoritativeRiskTaskFromDatabase } from '../application/postgres-risk-task-source';
import { CommercialError, type Query } from './service';
import { verifyProgress } from './authority';

/** Reuse the L2 parser and fingerprint semantics, allowing only event-proven
 * lifecycle version drift from the last authoritative risk context. */
export async function loadCommercialRiskTask(q: Query, id: string) {
  const row = (await q(`SELECT t.id,t.title,t.description,t.requirements,t.publisher_wallet,
    t.budget_atomic::text AS budget_atomic,t.version AS task_version,t.status AS task_status,
    c.task_version AS context_task_version,c.policy_version AS context_policy_version,
    c.declared_permissions,c.duration_hours::text AS duration_hours,c.dependency_classes,c.status AS context_status,
    'active' AS quote_status,
    w.record_version AS workflow_record_version,w.graph_revision AS workflow_graph_revision,w.snapshot AS workflow_snapshot,
    p.graph_revision AS pricing_graph_revision,p.workflow_record_version AS pricing_workflow_record_version,p.policy_version AS pricing_policy_version,
    COALESCE((SELECT jsonb_agg(to_jsonb(f) || jsonb_build_object(
      'fact_binding_id',f.binding_id,'binding_id',b.id,'binding_runtime_agent_id',b.runtime_agent_id,
      'binding_market_agent_id',b.market_agent_id,'binding_status',b.status,
      'agent_wallet',a.owner_wallet,'agent_status',a.status) ORDER BY f.node_id)
      FROM agent_market.task_graph_node_pricing_facts f
      LEFT JOIN agent_market.runtime_agent_bindings b ON b.id=f.binding_id
      LEFT JOIN agent_market.agents a ON a.id=f.market_agent_id
      WHERE f.task_id=t.id AND f.graph_revision=w.graph_revision),'[]'::jsonb) AS pricing_facts
    FROM agent_market.tasks t
    LEFT JOIN agent_market.task_risk_contexts c ON c.task_id=t.id AND c.status='active'
    LEFT JOIN agent_market.queen_workflows w ON w.task_id=t.id
    LEFT JOIN agent_market.task_graph_pricing_versions p ON p.task_id=t.id AND p.graph_revision=w.graph_revision
    WHERE t.id=$1`, [id]))[0];
  if (!row || !row.context_task_version) throw new CommercialError('COMMERCIAL_RISK_CONTEXT_REQUIRED');
  await verifyProgress(q,id,Number(row.context_task_version),Number(row.task_version),String(row.task_status));
  // All content and graph validations remain in the existing authoritative parser.
  // Confirmations are independently checked by acceptedQuote, not quote_status.
  return authoritativeRiskTaskFromDatabase({ ...row, task_version: row.context_task_version });
}

export async function commercialRiskMaterial(q: Query, id: string) {
  const contexts = await q("SELECT to_jsonb(c)-'task_version' AS value FROM agent_market.task_risk_contexts c WHERE task_id=$1 AND status='active' FOR SHARE", [id]);
  const workflows = await q("SELECT snapshot->'graph' AS graph,snapshot->'assignments' AS assignments,snapshot->'graphConfirmedRevision' AS confirmed FROM agent_market.queen_workflows WHERE task_id=$1 FOR SHARE", [id]);
  const facts = await q('SELECT to_jsonb(f) AS value FROM agent_market.task_graph_node_pricing_facts f WHERE task_id=$1 ORDER BY graph_revision,node_id FOR SHARE', [id]);
  return { contexts,workflows,facts };
}
