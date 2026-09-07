import { describe, expect, it } from "vitest";

import {
  NodeAssignmentSchema,
  RequiredWorkflowStages,
  canonicalQueenPlanningApprovalBinding,
  QueenGraphqlRequestSchema,
  TaskGraphSchema,
} from "./queen-orchestration";

describe("Queen orchestration contracts", () => {
  it("accepts a DAG with mandatory stages, delivery, and hidden auto rescue policy", () => {
    const graph = TaskGraphSchema.parse({
      taskId: "11111111-1111-4111-8111-111111111111",
      graphRevision: 1,
      requiredStages: [
        "requirement",
        "graph",
        "ranking",
        "acceptance",
        "execution",
        "judge",
        "final_arbitration",
        "delivery",
      ],
      riskLevel: "low",
      startPolicy: "auto",
      nodes: [
        { nodeId: "plan-1", type: "plan", title: "Plan", dependencies: [], required: true },
        { nodeId: "execute-1", type: "execute", title: "Execute", dependencies: ["plan-1"], required: true },
        { nodeId: "judge-1", type: "judge", title: "Judge execute", dependencies: ["execute-1"], required: true, judgesNodeId: "execute-1" },
        { nodeId: "repair-1", type: "repair", title: "Repair fallback", dependencies: ["judge-1"], required: false, repairsNodeId: "execute-1" },
        { nodeId: "final-1", type: "synthesize", title: "Final arbitration", dependencies: ["judge-1"], required: true },
        { nodeId: "deliver-1", type: "deliver", title: "Deliver", dependencies: ["final-1"], required: true },
      ],
      edges: [
        { from: "plan-1", to: "execute-1" },
        { from: "execute-1", to: "judge-1" },
        { from: "judge-1", to: "repair-1", condition: "needs_revision" },
        { from: "judge-1", to: "final-1", condition: "approved" },
        { from: "final-1", to: "deliver-1" },
      ],
      rescuePolicy: { mode: "auto", visibleToUser: false, evidenceVisible: true },
    });

    expect(graph.nodes.map((node) => node.type)).toContain("plan");
    expect(graph.nodes.map((node) => node.type)).toContain("deliver");
    expect(graph.rescuePolicy).toMatchObject({ mode: "auto", visibleToUser: false });
    expect(graph.nodes[0]?.contract).toMatchObject({
      schemaVersion: "1",
      outputKeys: ["result"],
      failureRoute: "stop",
    });
  });

  it("rejects graphs that reduce required workflow stages", () => {
    expect(() => TaskGraphSchema.parse({
      taskId: "11111111-1111-4111-8111-111111111111",
      graphRevision: 1,
      requiredStages: ["requirement", "graph", "execution", "delivery"],
      riskLevel: "low",
      startPolicy: "auto",
      nodes: [
        { nodeId: "plan-1", type: "plan", title: "Plan", dependencies: [], required: true },
        { nodeId: "deliver-1", type: "deliver", title: "Deliver", dependencies: ["plan-1"], required: true },
      ],
      edges: [{ from: "plan-1", to: "deliver-1" }],
      rescuePolicy: { mode: "auto", visibleToUser: false, evidenceVisible: true },
    })).toThrow();
  });

  it("requires accepted assignment state before a node can count as confirmed", () => {
    const assignment = NodeAssignmentSchema.parse({
      nodeId: "execute-1",
      selectedAgentId: "qwen-qwen-plus",
      status: "accepted",
      selectedBy: "queen",
      acceptedAt: "2026-08-22T12:00:00.000Z",
    });

    expect(assignment.status).toBe("accepted");
  });

  it("locks required base assignments while allowing only canonical system repair increments", () => {
    const taskId = "11111111-1111-4111-8111-111111111111";
    const graph = TaskGraphSchema.parse({
      taskId, graphRevision: 1, requiredStages: [...RequiredWorkflowStages],
      riskLevel: "low", startPolicy: "auto",
      nodes: [
        { nodeId: "plan-1", type: "plan", title: "Plan", dependencies: [], required: true },
        { nodeId: "deliver-1", type: "deliver", title: "Deliver", dependencies: ["plan-1"], required: true },
      ],
      edges: [{ from: "plan-1", to: "deliver-1" }],
      rescuePolicy: { mode: "auto", visibleToUser: false, evidenceVisible: true },
    });
    const accepted = (nodeId: string) => ({
      nodeId, selectedAgentId: `${nodeId}-agent`, status: "accepted" as const,
      selectedBy: "queen" as const, acceptedAt: "2026-09-07T00:00:00.000Z",
      override: false, riskCodes: [],
    });
    const binding = canonicalQueenPlanningApprovalBinding({
      graph, assignments: [["deliver-1", accepted("deliver-1")], ["plan-1", accepted("plan-1")]],
      approvedRevision: 1, allowSystemAppended: false,
    });
    expect(binding.assignments).toEqual([
      ["deliver-1", accepted("deliver-1")], ["plan-1", accepted("plan-1")],
    ]);

    const repairNode = {
      nodeId: "repair-deliver-1-1", type: "repair" as const, title: "Repair",
      dependencies: ["deliver-1"], required: true, repairsNodeId: "deliver-1",
      metadata: { systemAppended: true, attempt: 1 },
    };
    expect(() => canonicalQueenPlanningApprovalBinding({
      graph: { ...graph, graphRevision: 2, nodes: [...graph.nodes, repairNode],
        edges: [...graph.edges, { from: "deliver-1", to: repairNode.nodeId, condition: "needs_revision" as const }] },
      assignments: [["plan-1", accepted("plan-1")], ["deliver-1", accepted("deliver-1")],
        [repairNode.nodeId, accepted(repairNode.nodeId)]],
      approvedRevision: 1, allowSystemAppended: true,
    })).not.toThrow();
    expect(() => canonicalQueenPlanningApprovalBinding({
      graph: { ...graph, graphRevision: 2, nodes: [...graph.nodes, { ...repairNode, type: "execute" }],
        edges: [...graph.edges, { from: "deliver-1", to: repairNode.nodeId, condition: "needs_revision" as const }] },
      assignments: [["plan-1", accepted("plan-1")], ["deliver-1", accepted("deliver-1")],
        [repairNode.nodeId, accepted(repairNode.nodeId)]],
      approvedRevision: 1, allowSystemAppended: true,
    })).toThrow("QUEEN_APPROVAL_SYSTEM_INCREMENT_INVALID");
  });

  it("rejects dependency cycles before runtime execution", () => {
    expect(() => TaskGraphSchema.parse({
      taskId: "11111111-1111-4111-8111-111111111111",
      graphRevision: 1,
      requiredStages: [
        "requirement", "graph", "ranking", "acceptance", "execution", "judge", "final_arbitration", "delivery",
      ],
      riskLevel: "high",
      startPolicy: "manualRequired",
      nodes: [
        { nodeId: "plan-1", type: "plan", title: "Plan", dependencies: ["deliver-1"], required: true },
        { nodeId: "deliver-1", type: "deliver", title: "Deliver", dependencies: ["plan-1"], required: true },
      ],
      edges: [],
      rescuePolicy: { mode: "auto", visibleToUser: false, evidenceVisible: true },
    })).toThrow("Task graph must be acyclic");
  });

  it("accepts GraphQL state-machine mutations with input variables", () => {
    const request = QueenGraphqlRequestSchema.parse({
      query: "mutation ProposeTaskGraph($input: ProposeTaskGraphInput!) { proposeTaskGraph(input: $input) { taskId } }",
      operationName: "ProposeTaskGraph",
      variables: {
        input: {
          requestId: "22222222-2222-4222-8222-222222222222",
          requirement: "Build a verified agent workflow",
          queenAgentId: "queen-router-v1",
        },
      },
    });

    expect(request.operationName).toBe("ProposeTaskGraph");
  });
});
