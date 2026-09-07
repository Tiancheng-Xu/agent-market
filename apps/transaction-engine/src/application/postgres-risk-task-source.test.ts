import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { PostgresRiskTaskSource } from "./postgres-risk-task-source";

const taskId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const publisher = "0x1111111111111111111111111111111111111111";
const agentWallet = "0x2222222222222222222222222222222222222222";

function fakeSql(responses: unknown[][]) {
  let begins = 0;
  const tag = (async () => responses.shift() ?? []) as unknown as Sql;
  Object.assign(tag, {
    begin: async (callback: (transaction: Sql) => Promise<unknown>) => {
      begins += 1;
      return callback(tag);
    },
  });
  return { sql: tag, begins: () => begins };
}

const baseRow = () => ({
  id: taskId,
  title: "Audit an Agent delivery",
  description: "Verify the delivery against deterministic acceptance criteria.",
  requirements: ["Return a signed evidence manifest"],
  budget_atomic: "100000",
  publisher_wallet: publisher,
  task_version: 3,
  quote_status: "not_issued",
  context_task_version: 3,
  context_policy_version: "risk-context-v1",
  declared_permissions: ["read_context", "write_artifact"],
  duration_hours: "24.00",
  dependency_classes: ["provider_api"],
  context_status: "active",
  workflow_record_version: null,
  workflow_graph_revision: null,
  workflow_snapshot: null,
  pricing_graph_revision: null,
  pricing_workflow_record_version: null,
  pricing_policy_version: null,
  pricing_facts: [],
});

const graph = {
  taskId,
  graphRevision: 2,
  requiredStages: ["requirement", "graph", "ranking", "acceptance", "execution", "judge", "final_arbitration", "delivery"],
  riskLevel: "medium",
  startPolicy: "manualRequired",
  nodes: [
    {
      nodeId: "plan",
      type: "plan",
      title: "Plan",
      dependencies: [],
      required: true,
      contract: {
        schemaVersion: "1",
        contextInputs: [],
        outputKeys: ["plan"],
        artifactMediaTypes: [],
        milestone: "Plan accepted",
        acceptanceCriteria: ["Plan is complete"],
        budgetAtomic: "50000",
        permissions: ["read_context"],
        timeoutSeconds: 300,
        failureRoute: "stop",
      },
    },
    {
      nodeId: "deliver",
      type: "deliver",
      title: "Deliver",
      dependencies: ["plan"],
      required: true,
      contract: {
        schemaVersion: "1",
        contextInputs: ["plan"],
        outputKeys: ["result"],
        artifactMediaTypes: ["application/json"],
        milestone: "Evidence delivered",
        acceptanceCriteria: ["Evidence schema passes"],
        budgetAtomic: "50000",
        permissions: ["read_context", "write_artifact"],
        timeoutSeconds: 300,
        failureRoute: "manual_review",
      },
    },
  ],
  edges: [{ from: "plan", to: "deliver", condition: "approved" }],
  rescuePolicy: { mode: "auto", visibleToUser: false, evidenceVisible: true },
};

const assignment = (nodeId: string) => ({
  nodeId,
  selectedAgentId: "runtime-agent-v1",
  status: "accepted",
  selectedBy: "queen",
  acceptedAt: "2026-09-01T12:00:00.000Z",
  override: false,
  riskCodes: [],
});

const fact = (nodeId: string, shareBps: number) => ({
  node_id: nodeId,
  runtime_agent_id: "runtime-agent-v1",
  fact_binding_id: "33333333-3333-4333-8333-333333333333",
  market_agent_id: agentId,
  share_bps: shareBps,
  node_risk_multiplier_bps: 10000,
  reputation_risk_multiplier_bps: 11000,
  binding_id: "33333333-3333-4333-8333-333333333333",
  binding_runtime_agent_id: "runtime-agent-v1",
  binding_market_agent_id: agentId,
  binding_status: "active",
  agent_wallet: agentWallet,
  agent_status: "published",
});

const finalRow = () => ({
  ...baseRow(),
  workflow_record_version: 4,
  workflow_graph_revision: 2,
  workflow_snapshot: {
    taskId,
    recordVersion: 4,
    graph,
    assignments: [["plan", assignment("plan")], ["deliver", assignment("deliver")]],
    graphConfirmedRevision: 2,
  },
  pricing_graph_revision: 2,
  pricing_workflow_record_version: 4,
  pricing_policy_version: "pricing-facts-v1",
  pricing_facts: [fact("plan", 4000), fact("deliver", 6000)],
});

describe("PostgresRiskTaskSource", () => {
  it("loads a version-matched preliminary task in one transaction", async () => {
    const database = fakeSql([[baseRow()]]);
    const result = await new PostgresRiskTaskSource(database.sql).loadAuthoritativeTask(taskId);
    expect(result).toMatchObject({
      id: taskId,
      budgetAtomic: "100000",
      authorizedQuoteWallets: [publisher],
      quoteStatus: "not_issued",
      dag: null,
    });
    expect(database.begins()).toBe(1);
  });

  it("resolves accepted graph nodes through active bindings and exact pricing facts", async () => {
    const database = fakeSql([[finalRow()]]);
    const result = await new PostgresRiskTaskSource(database.sql).loadAuthoritativeTask(taskId);
    expect(result?.authorizedQuoteWallets).toEqual([publisher, agentWallet]);
    expect(result?.dag).toEqual({
      revision: 2,
      finalized: true,
      assignments: [
        { agentId, agentWallet, shareBps: 4000, nodeRiskMultiplierBps: 10000, reputationRiskMultiplierBps: 11000 },
        { agentId, agentWallet, shareBps: 6000, nodeRiskMultiplierBps: 10000, reputationRiskMultiplierBps: 11000 },
      ],
    });
  });

  it.each([
    ["unconfirmed graph", { workflow_snapshot: { ...finalRow().workflow_snapshot, graphConfirmedRevision: null } }, "RISK_TASK_GRAPH_UNCONFIRMED"],
    ["missing wallet", { pricing_facts: [{ ...fact("plan", 4000), agent_wallet: null }, fact("deliver", 6000)] }, "RISK_TASK_AGENT_WALLET_MISSING"],
    ["inactive binding", { pricing_facts: [{ ...fact("plan", 4000), binding_status: "retired" }, fact("deliver", 6000)] }, "RISK_TASK_AGENT_BINDING_INACTIVE"],
    ["incomplete shares", { pricing_facts: [fact("plan", 4000), fact("deliver", 5000)] }, "RISK_TASK_SHARE_TOTAL_INVALID"],
    ["stale context", { context_task_version: 2 }, "RISK_CONTEXT_TASK_VERSION_CONFLICT"],
  ])("fails closed for %s", async (_label, override, code) => {
    const database = fakeSql([[{ ...finalRow(), ...override }]]);
    await expect(new PostgresRiskTaskSource(database.sql).loadAuthoritativeTask(taskId)).rejects.toThrow(code);
  });

  it("returns null only when the task itself does not exist", async () => {
    const database = fakeSql([[]]);
    await expect(new PostgresRiskTaskSource(database.sql).loadAuthoritativeTask(taskId)).resolves.toBeNull();
  });
});
