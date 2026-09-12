import {
  AgentDepositNodeSchema,
  NodeAssignmentSchema,
  RiskAssessmentInputSchema,
  TaskGraphSchema,
  type NodeAssignment,
} from "@agent-market/shared-contracts";
import type { Sql } from "postgres";

import type {
  AuthoritativeRiskTask,
  RiskTaskAssignment,
  RiskContextQuoteStatus,
  RiskTaskSource,
} from "./risk-pricing-service.js";

import { RiskQuoteSchema } from '@agent-market/shared-contracts';

type DatabaseRow = Record<string, unknown>;
type PricingFact = {
  nodeId: string;
  runtimeAgentId: string;
  marketAgentId: string;
  agentWallet: string;
  shareBps: number;
  nodeRiskMultiplierBps: number;
  reputationRiskMultiplierBps: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WALLET = /^0x[0-9a-f]{40}$/u;
const ATOMIC = /^(0|[1-9][0-9]*)$/u;
const QUOTE_STATUSES: readonly RiskContextQuoteStatus[] = [
  "not_issued", "active", "confirmed", "expired", "superseded", "manual_review", "requote_required",
];

const record = (value: unknown, code: string): DatabaseRow => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as DatabaseRow;
};

const stringArray = (value: unknown, code: string): string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(code);
  return value as string[];
};

const integer = (value: unknown, code: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(code);
  return parsed;
};

const wallet = (value: unknown, code: string): string => {
  const parsed = String(value).toLowerCase();
  if (!WALLET.test(parsed)) throw new Error(code);
  return parsed;
};

function parseAssignments(value: unknown): Map<string, NodeAssignment> {
  if (!Array.isArray(value)) throw new Error("RISK_TASK_ASSIGNMENTS_INVALID");
  const assignments = new Map<string, NodeAssignment>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
      throw new Error("RISK_TASK_ASSIGNMENTS_INVALID");
    }
    const assignment = NodeAssignmentSchema.parse(entry[1]);
    if (assignment.nodeId !== entry[0] || assignments.has(entry[0])) {
      throw new Error("RISK_TASK_ASSIGNMENTS_INVALID");
    }
    assignments.set(entry[0], assignment);
  }
  return assignments;
}

function parsePricingFacts(value: unknown): PricingFact[] {
  if (!Array.isArray(value)) throw new Error("RISK_TASK_PRICING_FACTS_INVALID");
  return value.map((raw) => {
    const row = record(raw, "RISK_TASK_PRICING_FACT_INVALID");
    const nodeId = String(row.node_id ?? "");
    const runtimeAgentId = String(row.runtime_agent_id ?? "");
    const marketAgentId = String(row.market_agent_id ?? "");
    if (!nodeId || !runtimeAgentId || !UUID.test(marketAgentId)) {
      throw new Error("RISK_TASK_PRICING_FACT_INVALID");
    }
    if (row.binding_status !== "active" || row.agent_status !== "published") {
      throw new Error("RISK_TASK_AGENT_BINDING_INACTIVE");
    }
    if (
      String(row.binding_id ?? "") !== String(row.fact_binding_id ?? "")
      || String(row.binding_runtime_agent_id ?? "") !== runtimeAgentId
      || String(row.binding_market_agent_id ?? "") !== marketAgentId
    ) {
      throw new Error("RISK_TASK_AGENT_BINDING_CONFLICT");
    }
    const parsed = AgentDepositNodeSchema.parse({
      agentId: marketAgentId,
      shareBps: integer(row.share_bps, "RISK_TASK_SHARE_INVALID"),
      nodeRiskMultiplierBps: integer(row.node_risk_multiplier_bps, "RISK_TASK_NODE_MULTIPLIER_INVALID"),
      reputationRiskMultiplierBps: integer(
        row.reputation_risk_multiplier_bps,
        "RISK_TASK_REPUTATION_MULTIPLIER_INVALID",
      ),
    });
    return {
      nodeId,
      runtimeAgentId,
      marketAgentId,
      agentWallet: wallet(row.agent_wallet, "RISK_TASK_AGENT_WALLET_MISSING"),
      shareBps: parsed.shareBps,
      nodeRiskMultiplierBps: parsed.nodeRiskMultiplierBps,
      reputationRiskMultiplierBps: parsed.reputationRiskMultiplierBps,
    };
  });
}

export function authoritativeRiskTaskFromDatabase(row: DatabaseRow): AuthoritativeRiskTask {
  if (['manual_review', 'cancelled', 'failed', 'disputed'].includes(String(row.task_status))) throw new Error('RISK_TASK_HALTED');
  const id = String(row.id ?? "");
  const taskVersion = integer(row.task_version, "RISK_TASK_VERSION_INVALID");
  const contextTaskVersion = integer(row.context_task_version, "RISK_CONTEXT_TASK_VERSION_INVALID");
  if (taskVersion !== contextTaskVersion) throw new Error("RISK_CONTEXT_TASK_VERSION_CONFLICT");
  if (row.context_status !== "active") throw new Error("RISK_CONTEXT_INACTIVE");
  if (!String(row.context_policy_version ?? "").trim()) throw new Error("RISK_CONTEXT_POLICY_MISSING");

  const publisherWallet = wallet(row.publisher_wallet, "RISK_TASK_PUBLISHER_WALLET_MISSING");
  const quoteStatus = String(row.quote_status ?? "");
  if (!QUOTE_STATUSES.includes(quoteStatus as RiskContextQuoteStatus)) {
    throw new Error("RISK_TASK_QUOTE_STATUS_INVALID");
  }
  const input = RiskAssessmentInputSchema.parse({
    taskId: id,
    title: row.title,
    description: row.description,
    requirements: stringArray(row.requirements, "RISK_TASK_REQUIREMENTS_INVALID"),
    declaredPermissions: stringArray(row.declared_permissions, "RISK_CONTEXT_PERMISSIONS_INVALID"),
    durationHours: Number(row.duration_hours),
    dependencyClasses: stringArray(row.dependency_classes, "RISK_CONTEXT_DEPENDENCIES_INVALID"),
  });
  const budgetAtomic = String(row.budget_atomic ?? "");
  if (!ATOMIC.test(budgetAtomic) || BigInt(budgetAtomic) <= 0n) throw new Error("RISK_TASK_BUDGET_INVALID");

  if (row.workflow_snapshot === null || row.workflow_snapshot === undefined) {
    if (Array.isArray(row.pricing_facts) && row.pricing_facts.length > 0) {
      throw new Error("RISK_TASK_PRICING_WITHOUT_GRAPH");
    }
    return {
      id: input.taskId,
      title: input.title,
      description: input.description,
      requirements: input.requirements,
      declaredPermissions: input.declaredPermissions,
      durationHours: input.durationHours,
      dependencyClasses: input.dependencyClasses,
      budgetAtomic,
      publisherWallet,
      authorizedQuoteWallets: [publisherWallet],
      quoteStatus: quoteStatus as RiskContextQuoteStatus,
      dag: null,
    };
  }

  const snapshot = record(row.workflow_snapshot, "RISK_TASK_WORKFLOW_INVALID");
  const graph = TaskGraphSchema.parse(snapshot.graph);
  const rowGraphRevision = integer(row.workflow_graph_revision, "RISK_TASK_GRAPH_REVISION_INVALID");
  const recordVersion = integer(row.workflow_record_version, "RISK_TASK_WORKFLOW_VERSION_INVALID");
  if (
    snapshot.taskId !== id
    || integer(snapshot.recordVersion, "RISK_TASK_WORKFLOW_VERSION_INVALID") !== recordVersion
    || graph.taskId !== id
    || graph.graphRevision !== rowGraphRevision
  ) {
    throw new Error("RISK_TASK_WORKFLOW_CONFLICT");
  }
  if (snapshot.graphConfirmedRevision !== graph.graphRevision) {
    throw new Error("RISK_TASK_GRAPH_UNCONFIRMED");
  }
  if (
    integer(row.pricing_graph_revision, "RISK_TASK_PRICING_REVISION_MISSING") !== graph.graphRevision
    || integer(row.pricing_workflow_record_version, "RISK_TASK_PRICING_WORKFLOW_VERSION_MISSING") !== recordVersion
    || !String(row.pricing_policy_version ?? "").trim()
  ) {
    throw new Error("RISK_TASK_PRICING_VERSION_CONFLICT");
  }

  const assignments = parseAssignments(snapshot.assignments);
  for (const node of graph.nodes.filter(({ required }) => required)) {
    if (assignments.get(node.nodeId)?.status !== "accepted") {
      throw new Error("RISK_TASK_GRAPH_ASSIGNMENTS_UNCONFIRMED");
    }
  }
  const accepted = [...assignments.values()].filter(({ status }) => status === "accepted");
  if (accepted.length === 0) throw new Error("RISK_TASK_GRAPH_ASSIGNMENTS_MISSING");

  const facts = parsePricingFacts(row.pricing_facts);
  if (facts.length !== accepted.length || new Set(facts.map(({ nodeId }) => nodeId)).size !== facts.length) {
    throw new Error("RISK_TASK_PRICING_FACTS_INCOMPLETE");
  }
  const factsByNode = new Map(facts.map((fact) => [fact.nodeId, fact]));
  const riskAssignments: RiskTaskAssignment[] = accepted.map((assignment) => {
    const fact = factsByNode.get(assignment.nodeId);
    if (!fact) throw new Error("RISK_TASK_PRICING_FACT_MISSING");
    if (assignment.selectedAgentId !== fact.runtimeAgentId) {
      throw new Error("RISK_TASK_AGENT_ASSIGNMENT_CONFLICT");
    }
    return {
      agentId: fact.marketAgentId,
      agentWallet: fact.agentWallet,
      shareBps: fact.shareBps,
      nodeRiskMultiplierBps: fact.nodeRiskMultiplierBps,
      reputationRiskMultiplierBps: fact.reputationRiskMultiplierBps,
    };
  });
  if (riskAssignments.reduce((sum, assignment) => sum + assignment.shareBps, 0) !== 10_000) {
    throw new Error("RISK_TASK_SHARE_TOTAL_INVALID");
  }

  return {
    id: input.taskId,
    title: input.title,
    description: input.description,
    requirements: input.requirements,
    declaredPermissions: input.declaredPermissions,
    durationHours: input.durationHours,
    dependencyClasses: input.dependencyClasses,
    budgetAtomic,
    publisherWallet,
    authorizedQuoteWallets: [...new Set([publisherWallet, ...facts.map(({ agentWallet }) => agentWallet)])],
    quoteStatus: quoteStatus as RiskContextQuoteStatus,
    dag: { revision: graph.graphRevision, finalized: true, assignments: riskAssignments },
  };
}

export class PostgresRiskTaskSource implements RiskTaskSource {
  constructor(private readonly sql: Sql) {}

  async loadAuthoritativeTask(taskId: string, db?: import('postgres').Sql | import('postgres').TransactionSql): Promise<AuthoritativeRiskTask | null> {
    if (!UUID.test(taskId)) throw new Error("RISK_TASK_ID_INVALID");
    const load = async (transaction: import('postgres').Sql | import('postgres').TransactionSql) => {
      const rows = await transaction<DatabaseRow[]>`
        SELECT
          task.id,
          task.status AS task_status,
          current_quote.id AS current_quote_id,
          current_quote.quote_version AS current_quote_version,
          current_quote.basis_fingerprint AS current_quote_hash,
          current_quote.quote_payload AS current_quote_payload,
          task.title,
          task.description,
          task.requirements,
          task.budget_atomic::text AS budget_atomic,
          task.publisher_wallet,
          task.version AS task_version,
          COALESCE((
            SELECT CASE
              WHEN quote.status = 'superseded' THEN 'superseded'
              WHEN quote.quote_payload->>'schemaVersion' IS DISTINCT FROM '2' THEN 'requote_required'
              WHEN quote.expires_at <= now() THEN 'expired'
              WHEN quote.manual_review_required AND quote.manual_approved_at IS NULL THEN 'manual_review'
              WHEN EXISTS (
                SELECT 1 FROM agent_market.risk_quote_confirmations confirmation
                WHERE confirmation.quote_id = quote.id AND confirmation.actor_type = 'publisher'
                  AND confirmation.quote_hash = quote.basis_fingerprint
                  AND confirmation.task_fingerprint = quote.task_fingerprint
                  AND lower(confirmation.actor_wallet) = lower(task.publisher_wallet)
              ) AND (
                quote.phase = 'preliminary' OR NOT EXISTS (
                  SELECT 1 FROM agent_market.risk_quote_agent_allocations allocation
                  WHERE allocation.quote_id = quote.id AND NOT EXISTS (
                    SELECT 1 FROM agent_market.risk_quote_confirmations confirmation
                    WHERE confirmation.quote_id = quote.id
                      AND confirmation.actor_type = 'agent'
                      AND confirmation.agent_id = allocation.agent_id
                      AND confirmation.quote_hash = quote.basis_fingerprint
                      AND confirmation.task_fingerprint = quote.task_fingerprint
                      AND lower(confirmation.actor_wallet) = lower(allocation.agent_wallet)
                  )
                )
              ) THEN 'confirmed'
              ELSE 'active'
            END
            FROM agent_market.risk_quotes quote
            WHERE quote.id = current_quote.id
            ORDER BY quote.quote_version DESC
            LIMIT 1
          ), 'not_issued') AS quote_status,
          context.task_version AS context_task_version,
          context.policy_version AS context_policy_version,
          context.declared_permissions,
          context.duration_hours::text AS duration_hours,
          context.dependency_classes,
          context.status AS context_status,
          workflow.record_version AS workflow_record_version,
          workflow.graph_revision AS workflow_graph_revision,
          workflow.snapshot AS workflow_snapshot,
          pricing.graph_revision AS pricing_graph_revision,
          pricing.workflow_record_version AS pricing_workflow_record_version,
          pricing.policy_version AS pricing_policy_version,
          COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'node_id', fact.node_id,
              'runtime_agent_id', fact.runtime_agent_id,
              'fact_binding_id', fact.binding_id,
              'market_agent_id', fact.market_agent_id,
              'share_bps', fact.share_bps,
              'node_risk_multiplier_bps', fact.node_risk_multiplier_bps,
              'reputation_risk_multiplier_bps', fact.reputation_risk_multiplier_bps,
              'binding_id', binding.id,
              'binding_runtime_agent_id', binding.runtime_agent_id,
              'binding_market_agent_id', binding.market_agent_id,
              'binding_status', binding.status,
              'agent_wallet', agent.owner_wallet,
              'agent_status', agent.status
            ) ORDER BY fact.node_id)
            FROM agent_market.task_graph_node_pricing_facts fact
            LEFT JOIN agent_market.runtime_agent_bindings binding ON binding.id = fact.binding_id
            LEFT JOIN agent_market.agents agent ON agent.id = fact.market_agent_id
            WHERE fact.task_id = task.id
              AND fact.graph_revision = workflow.graph_revision
          ), '[]'::jsonb) AS pricing_facts
        FROM agent_market.tasks task
        LEFT JOIN LATERAL (
          SELECT * FROM agent_market.risk_quotes
          WHERE task_id = task.id AND status = 'active'
          ORDER BY quote_version DESC LIMIT 1
        ) current_quote ON true
        LEFT JOIN agent_market.task_risk_contexts context
          ON context.task_id = task.id AND context.status = 'active'
        LEFT JOIN agent_market.queen_workflows workflow ON workflow.task_id = task.id
        LEFT JOIN agent_market.task_graph_pricing_versions pricing
          ON pricing.task_id = workflow.task_id
          AND pricing.graph_revision = workflow.graph_revision
        WHERE task.id = ${taskId}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      if (row.context_task_version === null || row.context_task_version === undefined) {
        throw new Error("RISK_CONTEXT_MISSING");
      }
      const task = authoritativeRiskTaskFromDatabase(row);
      return { ...task, currentQuote: row.current_quote_id ? {
        quoteId: String(row.current_quote_id), version: Number(row.current_quote_version),
        quoteHash: String(row.current_quote_hash),
        quote: RiskQuoteSchema.parse(row.current_quote_payload),
      } : null };
    };
    return db ? load(db) : this.sql.begin(load);
  }
}
