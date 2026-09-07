import type { AgentCandidate } from "@agent-market/shared-contracts";
import { expect, it, vi } from "vitest";
import { createQueenOrchestrator } from "./queen-orchestrator";
import { QueenTaskStateSchema } from "./queen-task-graph";
import { MemoryQueenWorkflowStore } from "./queen-workflow-store";

const candidate = (agentId: string, capabilities: string[]): AgentCandidate => ({
  agentId, displayName: agentId, capabilities, tags: [], provider: "qwen",
  ownership: "third-party/provider-api", selectableBy: "public-market", status: "online",
  costPer1kTokensUsd: 0.01, latencyMs: 100, qualityScore: 0.9,
  firstSeenAt: "2026-01-01T00:00:00.000Z", modelTag: agentId,
  modelDigest: "provider-managed", riskCodes: [],
});

it("maps the durable graph to independent Queen agents and re-judges repaired output", async () => {
  const { createQueenOrchestratorPorts } = await import("./queen-orchestrator-ports");
  const store = new MemoryQueenWorkflowStore();
  const agents = [
    candidate("queen-router-v1", ["plan", "completion"]),
    candidate("executor", ["completion"]),
    candidate("judge", ["judge"]),
    candidate("red-team", ["red_team"]),
    candidate("final-arbiter", ["final_arbitration"]),
  ];
  let judgment = 0;
  const executeAgentText = vi.fn(async ({ role }: { role: string; operationKey: string }) => {
    if (role === "executor") return "first output";
    if (role === "judge") return ++judgment === 1
      ? "verdict: needs_revision\nscore: 0.40"
      : "verdict: approved\nscore: 0.95";
    if (role === "repair") return "repaired output";
    if (role === "red_team") return "verdict: approved\nfindings: no blocking issue";
    if (role === "final_arbiter") return "verdict: approved\napproved final output";
    throw new Error("UNEXPECTED_ROLE");
  });
  const bootstrap = createQueenOrchestrator({ agents, queenAgentId: "queen-router-v1", workflowStore: store, executeAgentText });
  const taskId = "0191f6f8-cb6b-7f31-81ad-c497d7d90321";
  const proposed = await bootstrap.handleGraphql({
    operationName: "ProposeTaskGraph", query: "mutation ProposeTaskGraph { proposeTaskGraph }",
    variables: { input: { taskId, requirement: "Move production funds with strict review" } },
  });
  expect(proposed.errors).toBeUndefined();
  const graph = proposed.data?.proposeTaskGraph;
  const agentByNodeType: Record<string, string> = {
    plan: "queen-router-v1",
    execute: "executor",
    judge: "judge",
    red_team: "red-team",
    synthesize: "final-arbiter",
    deliver: "executor",
  };
  for (const node of graph.nodes.filter((item: { required: boolean }) => item.required)) {
    const accepted = await bootstrap.handleGraphql({
      operationName: "AcceptNodeAssignment",
      query: "mutation AcceptNodeAssignment { acceptNodeAssignment }",
      variables: { input: { taskId, nodeId: node.nodeId, agentId: agentByNodeType[node.type] } },
    });
    expect(accepted.errors).toBeUndefined();
  }
  const state = QueenTaskStateSchema.parse({
    scopeId: "0191f6f8-cb6b-7f31-81ad-c497d7d90322", taskId, graphRevision: 1,
    taskFingerprint: `sha256:${"a".repeat(64)}`, riskLevel: "high",
  });
  const ports = createQueenOrchestratorPorts({
    agents, queenAgentId: "queen-router-v1", workflowStore: store, executeAgentText,
  });
  expect(await ports.execute(state, "execute-key")).toBe(`queen-output:${taskId}:execute-1`);
  expect(await ports.judge({ ...state, outputRef: "output" }, "judge-1")).toBe("needs_revision");
  expect(await ports.repair({ ...state, outputRef: "output", decision: "needs_revision" }, "repair-1"))
    .toBe(`queen-output:${taskId}:execute-1:repair:1`);
  expect(await ports.judge({ ...state, outputRef: "repaired", repairCount: 1 }, "judge-2")).toBe("approved");
  expect(await ports.redTeam!({ ...state, outputRef: "repaired", decision: "approved", repairCount: 1 }, "red-1"))
    .toBe("approved");
  expect(await ports.finalize({ ...state, outputRef: "repaired", decision: "approved",
    redTeamDecision: "approved", repairCount: 1 }, "final-1"))
    .toBe(`queen-final:${taskId}`);
  expect(executeAgentText.mock.calls.map(([request]) => request.role)).toEqual([
    "executor", "judge", "repair", "judge", "red_team", "final_arbiter",
  ]);
  expect(executeAgentText.mock.calls.map(([request]) => request.operationKey)).toEqual([
    "execute-key", "judge-1", "repair-1", "judge-2", "red-1", "final-1",
  ]);
  const saved = await store.load(taskId);
  expect(saved?.judgments[0]?.[1].verdict).toBe("approved");
  expect(saved?.finalArbitration?.finalOutput).toBe("verdict: approved\napproved final output");
});
