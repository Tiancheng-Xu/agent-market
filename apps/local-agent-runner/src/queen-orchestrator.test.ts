import { describe, expect, it, vi } from "vitest";

import type { AgentCandidate, QueenMutationName } from "@agent-market/shared-contracts";

import { createQueenOrchestrator } from "./queen-orchestrator";
import { createQueenFrameworkRuntime } from "./queen-workflow-runtime";

const now = () => new Date("2026-08-22T12:00:00.000Z");

describe("queen orchestrator state machine", () => {
  it("proposes a DAG with hidden rescue policy and manual start for high-risk work", async () => {
    const orchestrator = createQueenOrchestrator({ agents: agents(), now, queenAgentId: "queen-router-v1" });

    const response = await mutate(orchestrator, "ProposeTaskGraph", {
      requirement: "Move funds on chain and deliver a verified workflow",
      queenAgentId: "queen-router-v1",
    });

    expect(response.data.proposeTaskGraph.riskLevel).toBe("high");
    expect(response.data.proposeTaskGraph.startPolicy).toBe("manualRequired");
    expect(response.data.proposeTaskGraph.rescuePolicy).toMatchObject({
      mode: "auto",
      visibleToUser: false,
      evidenceVisible: true,
    });
    expect(response.data.proposeTaskGraph.nodes.map((node: { type: string }) => node.type)).toContain("red_team");
  });

  it("ranks and auto-selects node agents using cost-priority ranking", async () => {
    const orchestrator = createQueenOrchestrator({ agents: agents(), now, queenAgentId: "queen-router-v1" });
    const proposed = await mutate(orchestrator, "ProposeTaskGraph", {
      requirement: "Write a simple implementation plan",
      queenAgentId: "queen-router-v1",
    });

    const ranked = await mutate(orchestrator, "RankNodeAgents", {
      taskId: proposed.data.proposeTaskGraph.taskId,
      nodeId: "execute-1",
      requiredCapabilities: ["completion"],
    });

    expect(ranked.data.rankNodeAgents.candidates.map((candidate: { agentId: string }) => candidate.agentId)[0]).toBe("cheap-executor");
    expect(ranked.data.rankNodeAgents.autoSelectedAgentId).toBe("cheap-executor");
  });

  it("ignores a forged owner callerScope and gates owner-only auto-selection on the server scope", async () => {
    const orchestrator = createQueenOrchestrator({
      agents: [
        ...agents(),
        candidate("owner-local", {
          provider: "ollama",
          ownership: "owner-trained",
          selectableBy: "owner-only",
          costPer1kTokensUsd: 0,
          qualityScore: 0.99,
        }),
      ],
      now,
      queenAgentId: "queen-router-v1",
    });
    const proposed = await mutate(orchestrator, "ProposeTaskGraph", {
      requirement: "Write a simple implementation plan",
      queenAgentId: "queen-router-v1",
    });

    const ranked = await mutate(orchestrator, "RankNodeAgents", {
      taskId: proposed.data.proposeTaskGraph.taskId,
      nodeId: "execute-1",
      requiredCapabilities: ["completion"],
      callerScope: "owner",
    });

    expect(ranked.data.rankNodeAgents.candidates.map((candidate: { agentId: string }) => candidate.agentId)).not.toContain("owner-local");
    expect(ranked.data.rankNodeAgents.autoSelectedAgentId).not.toBe("owner-local");
  });

  it("blocks start until every required node assignment is accepted", async () => {
    const orchestrator = createQueenOrchestrator({ agents: agents(), now, queenAgentId: "queen-router-v1" });
    const proposed = await mutate(orchestrator, "ProposeTaskGraph", {
      requirement: "Write a simple implementation plan",
      queenAgentId: "queen-router-v1",
    });

    const started = await mutate(orchestrator, "StartTaskRun", {
      taskId: proposed.data.proposeTaskGraph.taskId,
    });

    expect(started.data.startTaskRun.status).toBe("blocked");
    expect(started.data.startTaskRun.reasonCode).toBe("ASSIGNMENT_NOT_ACCEPTED");
  });

  it("blocks start until the current graph and accepted assignments are confirmed", async () => {
    const orchestrator = createQueenOrchestrator({ agents: agents(), now, queenAgentId: "queen-router-v1" });
    const proposed = await mutate(orchestrator, "ProposeTaskGraph", {
      requirement: "Write a simple implementation plan",
      queenAgentId: "queen-router-v1",
    });
    const taskId = proposed.data.proposeTaskGraph.taskId;
    await acceptRequiredAssignments(orchestrator, proposed.data.proposeTaskGraph);

    const started = await mutate(orchestrator, "StartTaskRun", { taskId });

    expect(started.data.startTaskRun).toMatchObject({
      taskId,
      status: "blocked",
      reasonCode: "GRAPH_NOT_CONFIRMED",
    });
  });

  it("amends before confirmation, then locks graph and assignments at confirmation", async () => {
    const orchestrator = createQueenOrchestrator({ agents: agents(), now, queenAgentId: "queen-router-v1" });
    const proposed = await mutate(orchestrator, "ProposeTaskGraph", {
      requirement: "Write a simple implementation plan",
      queenAgentId: "queen-router-v1",
    });
    const graph = proposed.data.proposeTaskGraph;
    await acceptRequiredAssignments(orchestrator, graph);

    const amended = await mutate(orchestrator, "AmendTaskGraph", {
      taskId: graph.taskId,
      nodes: graph.nodes.map((node: { nodeId: string; title: string }) => (
        node.nodeId === "execute-1" ? { ...node, title: "Execute revised scope" } : node
      )),
      edges: graph.edges,
    });

    expect(amended.data.amendTaskGraph).toMatchObject({
      taskId: graph.taskId,
      graphRevision: 2,
      confirmationStatus: "pending",
    });
    expect(amended.data.amendTaskGraph.preservedAssignmentNodeIds).toEqual(
      graph.nodes.filter((node: { required: boolean }) => node.required).map((node: { nodeId: string }) => node.nodeId),
    );
    await mutate(orchestrator, "ConfirmTaskGraph", { taskId: graph.taskId });

    const lockedAmendment = await mutate(orchestrator, "AmendTaskGraph", {
      taskId: graph.taskId,
      nodes: amended.data.amendTaskGraph.nodes,
      edges: amended.data.amendTaskGraph.edges,
    });
    expect(lockedAmendment.errors[0].message).toContain("locked after confirmation");
  });

  it("locks graph amendments after the task run starts", async () => {
    const orchestrator = createQueenOrchestrator({ agents: agents(), now, queenAgentId: "queen-router-v1" });
    const proposed = await mutate(orchestrator, "ProposeTaskGraph", {
      requirement: "Write a simple implementation plan",
      queenAgentId: "queen-router-v1",
    });
    const graph = proposed.data.proposeTaskGraph;
    await acceptRequiredAssignments(orchestrator, graph);
    await mutate(orchestrator, "ConfirmTaskGraph", { taskId: graph.taskId });
    const started = await mutate(orchestrator, "StartTaskRun", { taskId: graph.taskId });

    const amended = await mutate(orchestrator, "AmendTaskGraph", {
      taskId: graph.taskId,
      nodes: graph.nodes,
      edges: graph.edges,
    });

    expect(started.data.startTaskRun.status).toBe("running");
    expect(amended.errors[0]).toMatchObject({
      extensions: { code: "STATE_ERROR" },
    });
    expect(amended.errors[0].message).toContain("locked");
  });

  it("rejects judge self-review and final arbitration by Queen, executor, or judge", async () => {
    const orchestrator = createQueenOrchestrator({ agents: agents(), now, queenAgentId: "queen-router-v1" });
    const proposed = await mutate(orchestrator, "ProposeTaskGraph", {
      requirement: "Write a simple implementation plan",
      queenAgentId: "queen-router-v1",
    });
    await startGraph(orchestrator, proposed.data.proposeTaskGraph);
    await mutate(orchestrator, "SubmitNodeOutput", {
      taskId: proposed.data.proposeTaskGraph.taskId,
      nodeId: "execute-1",
      executorAgentId: "cheap-executor",
      output: "executor output",
    });

    const judged = await mutate(orchestrator, "JudgeNodeOutput", {
      taskId: proposed.data.proposeTaskGraph.taskId,
      nodeId: "execute-1",
      judgeAgentId: "cheap-executor",
      score: 0.9,
      verdict: "approved",
    });
    const arbitrated = await mutate(orchestrator, "FinalArbitrate", {
      taskId: proposed.data.proposeTaskGraph.taskId,
      finalArbiterAgentId: "queen-router-v1",
      finalOutput: "final output",
    });
    const executorArbitrated = await mutate(orchestrator, "FinalArbitrate", {
      taskId: proposed.data.proposeTaskGraph.taskId,
      finalArbiterAgentId: "cheap-executor",
      finalOutput: "final output",
    });

    expect(judged.errors[0].extensions.code).toBe("JUDGE_NOT_INDEPENDENT");
    expect(arbitrated.errors[0].extensions.code).toBe("FINAL_ARBITER_NOT_INDEPENDENT");
    expect(executorArbitrated.errors[0].extensions.code).toBe("FINAL_ARBITER_NOT_INDEPENDENT");
  });

  it("rejects self-review aliases that use the same model tag", async () => {
    const orchestrator = createQueenOrchestrator({
      agents: [...agents(), candidate("executor-alias", { modelTag: " CHEAP-EXECUTOR ", capabilities: ["judge", "completion"] })],
      now,
      queenAgentId: "queen-router-v1",
    });
    const proposed = await mutate(orchestrator, "ProposeTaskGraph", { requirement: "Write a plan", queenAgentId: "queen-router-v1" });
    const graph = proposed.data.proposeTaskGraph;
    await acceptRequiredAssignments(orchestrator, graph);
    await mutate(orchestrator, "AcceptNodeAssignment", { taskId: graph.taskId, nodeId: "judge-1", agentId: "executor-alias" });
    await mutate(orchestrator, "ConfirmTaskGraph", { taskId: graph.taskId });
    await mutate(orchestrator, "StartTaskRun", { taskId: graph.taskId });
    await mutate(orchestrator, "SubmitNodeOutput", { taskId: graph.taskId, nodeId: "execute-1", executorAgentId: "cheap-executor", output: "output" });

    const judged = await mutate(orchestrator, "JudgeNodeOutput", {
      taskId: graph.taskId,
      nodeId: "execute-1",
      judgeAgentId: "executor-alias",
      score: 0.9,
      verdict: "approved",
    });

    expect(judged.errors[0].extensions.code).toBe("JUDGE_NOT_INDEPENDENT");
  });

  it("binds execution to accepted assignments and makes model-backed terminal mutations idempotent", async () => {
    const executeAgentText = vi.fn(async (request: { role: string }) => {
      if (request.role === "judge") return "verdict: approved\nscore: 0.91";
      if (request.role === "final_arbiter") return "verdict: approved\nfinal output";
      return `${request.role} output`;
    });
    const orchestrator = createQueenOrchestrator({ agents: agents(), now, queenAgentId: "queen-router-v1", executeAgentText });
    const proposed = await mutate(orchestrator, "ProposeTaskGraph", { requirement: "Write a plan", queenAgentId: "queen-router-v1" });
    const graph = proposed.data.proposeTaskGraph;
    await startGraph(orchestrator, graph);

    const wrongExecutor = await mutate(orchestrator, "SubmitNodeOutput", {
      taskId: graph.taskId,
      nodeId: "execute-1",
      executorAgentId: "expensive-executor",
    });
    expect(wrongExecutor.errors[0].extensions.code).toBe("STATE_ERROR");

    const firstOutput = await mutate(orchestrator, "SubmitNodeOutput", { taskId: graph.taskId, nodeId: "execute-1", executorAgentId: "cheap-executor" });
    const repeatedOutput = await mutate(orchestrator, "SubmitNodeOutput", { taskId: graph.taskId, nodeId: "execute-1", executorAgentId: "cheap-executor" });
    const firstJudge = await mutate(orchestrator, "JudgeNodeOutput", { taskId: graph.taskId, nodeId: "execute-1", judgeAgentId: "judge-agent" });
    const repeatedJudge = await mutate(orchestrator, "JudgeNodeOutput", { taskId: graph.taskId, nodeId: "execute-1", judgeAgentId: "judge-agent" });
    const firstFinal = await mutate(orchestrator, "FinalArbitrate", { taskId: graph.taskId, finalArbiterAgentId: "final-arbiter-agent" });
    const repeatedFinal = await mutate(orchestrator, "FinalArbitrate", { taskId: graph.taskId, finalArbiterAgentId: "final-arbiter-agent" });

    expect(repeatedOutput.data.submitNodeOutput.outputId).toBe(firstOutput.data.submitNodeOutput.outputId);
    expect(repeatedJudge.data.judgeNodeOutput).toEqual(firstJudge.data.judgeNodeOutput);
    expect(repeatedFinal.data.finalArbitrate).toEqual(firstFinal.data.finalArbitrate);
    expect(executeAgentText.mock.calls.map(([request]) => request.role)).toEqual(["executor", "judge", "final_arbiter"]);
  });

  it("triggers red-team on low judge score and writes redacted learning-loop records", async () => {
    const orchestrator = createQueenOrchestrator({ agents: agents(), now, queenAgentId: "queen-router-v1" });
    const proposed = await mutate(orchestrator, "ProposeTaskGraph", {
      requirement: "Write a simple implementation plan",
      queenAgentId: "queen-router-v1",
    });
    await startGraph(orchestrator, proposed.data.proposeTaskGraph);
    await mutate(orchestrator, "SubmitNodeOutput", {
      taskId: proposed.data.proposeTaskGraph.taskId,
      nodeId: "execute-1",
      executorAgentId: "cheap-executor",
      output: "executor output",
    });

    const judged = await mutate(orchestrator, "JudgeNodeOutput", {
      taskId: proposed.data.proposeTaskGraph.taskId,
      nodeId: "execute-1",
      judgeAgentId: "judge-agent",
      score: 0.42,
      verdict: "needs_revision",
    });
    const learned = await mutate(orchestrator, "WriteLearningLoop", {
      taskId: proposed.data.proposeTaskGraph.taskId,
      summary: "Do not leak sk-secret12345 in public evidence",
    });

    expect(judged.data.judgeNodeOutput.redTeamRequired).toBe(true);
    expect(learned.data.writeLearningLoop.summary).toContain("[redacted-secret]");
    expect(learned.data.writeLearningLoop.summary).not.toContain("sk-secret12345");
  });

  it("uses isolated model execution hooks for executor, judge, red-team, repair, and final arbiter", async () => {
    const executeAgentText = vi.fn(async (request: { role: string }) => {
      if (request.role === "executor") return "executor output";
      if (request.role === "judge") return "verdict: needs_revision\nscore: 0.52";
      if (request.role === "red_team") return "finding: missing evidence";
      if (request.role === "repair") return "repair output";
      if (request.role === "final_arbiter") return "verdict: approved\nfinal approved output";
      return "unknown";
    });
    const orchestrator = createQueenOrchestrator({
      agents: agents(),
      now,
      queenAgentId: "queen-router-v1",
      executeAgentText,
    });
    const proposed = await mutate(orchestrator, "ProposeTaskGraph", {
      requirement: "Write a simple implementation plan",
      queenAgentId: "queen-router-v1",
    });
    const taskId = proposed.data.proposeTaskGraph.taskId;
    await startGraph(orchestrator, proposed.data.proposeTaskGraph);

    const submitted = await mutate(orchestrator, "SubmitNodeOutput", {
      taskId,
      nodeId: "execute-1",
      executorAgentId: "cheap-executor",
    });
    const judged = await mutate(orchestrator, "JudgeNodeOutput", {
      taskId,
      nodeId: "execute-1",
      judgeAgentId: "judge-agent",
    });
    const redTeamed = await mutate(orchestrator, "RequestAdversarialReview", {
      taskId,
      nodeId: "execute-1",
      redTeamAgentId: "red-team-agent",
    });
    const repaired = await mutate(orchestrator, "RepairNode", {
      taskId,
      parentNodeId: "execute-1",
      repairAgentId: "cheap-executor",
    });
    const final = await mutate(orchestrator, "FinalArbitrate", {
      taskId,
      finalArbiterAgentId: "final-arbiter-agent",
    });

    expect(submitted.data.submitNodeOutput.output).toBe("executor output");
    expect(judged.data.judgeNodeOutput).toMatchObject({ verdict: "needs_revision", score: 0.52, redTeamRequired: true });
    expect(redTeamed.data.requestAdversarialReview.findings).toBe("finding: missing evidence");
    expect(redTeamed.data.requestAdversarialReview).toMatchObject({ reviewNodeId: "red_team-execute-1-1", graphRevision: 2 });
    expect(repaired.data.repairNode.output).toBe("repair output");
    expect(repaired.data.repairNode).toMatchObject({ repairNodeId: "repair-execute-1-1", graphRevision: 3 });
    expect(final.data.finalArbitrate.finalOutput).toBe("verdict: approved\nfinal approved output");
    expect(executeAgentText.mock.calls.map(([request]) => request.role)).toEqual([
      "executor",
      "judge",
      "red_team",
      "repair",
      "final_arbiter",
    ]);
  });

  it("runs Queen mutations through the injected framework boundary", async () => {
    const frameworkRuntime = { execute: vi.fn(async (input) => ({ ...input, stages: ["test"] })) };
    const orchestrator = createQueenOrchestrator({
      agents: agents(),
      now,
      queenAgentId: "queen-router-v1",
      frameworkRuntime,
    });

    await mutate(orchestrator, "ProposeTaskGraph", {
      requirement: "Write a simple implementation plan",
      queenAgentId: "queen-router-v1",
    });

    expect(frameworkRuntime.execute).toHaveBeenCalledWith(expect.objectContaining({
      operationName: "ProposeTaskGraph",
      stages: [],
    }));
  });

  it("routes graph amendments through the pure LangGraph policy boundary", async () => {
    const runtime = createQueenFrameworkRuntime();

    const result = await runtime.execute({
      operationName: "AmendTaskGraph",
      stages: [],
    });

    expect(result.operationPolicy).toBe("graph-management");
    expect(result.stages).toEqual([
      "langgraph:normalize",
      "langgraph:graph-management",
      "langgraph:policy-check",
    ]);
  });

  it("rejects owner-only local agents from public workflow selection", async () => {
    const orchestrator = createQueenOrchestrator({
      agents: [
        ...agents(),
        candidate("owner-local", {
          provider: "ollama",
          ownership: "owner-trained",
          selectableBy: "owner-only",
          modelTag: "personal-ai-agent-runtime:v4.1",
          modelDigest: "2c422ec890241b8492e08d4ba69f79f25efcf8ae4220e83797d2df9cbc7eb52a",
        }),
      ],
      now,
      queenAgentId: "queen-router-v1",
    });
    const proposed = await mutate(orchestrator, "ProposeTaskGraph", {
      requirement: "Write a simple implementation plan",
      queenAgentId: "queen-router-v1",
    });

    const selected = await mutate(orchestrator, "SelectNodeAgent", {
      taskId: proposed.data.proposeTaskGraph.taskId,
      nodeId: "execute-1",
      selectedAgentId: "owner-local",
    });

    expect(selected.errors[0].extensions.code).toBe("STATE_ERROR");
    expect(selected.errors[0].message).toContain("owner-only");
  });

  it("fails closed when Judge or Final Arbiter output has no explicit verdict", async () => {
    const executeAgentText = vi.fn(async ({ role }: { role: string }) => `${role} returned unstructured prose`);
    const orchestrator = createQueenOrchestrator({ agents: agents(), now, queenAgentId: "queen-router-v1", executeAgentText });
    const proposed = await mutate(orchestrator, "ProposeTaskGraph", {
      requirement: "Write a simple implementation plan",
      queenAgentId: "queen-router-v1",
    });
    const graph = proposed.data.proposeTaskGraph;
    await startGraph(orchestrator, graph);
    await mutate(orchestrator, "SubmitNodeOutput", {
      taskId: graph.taskId,
      nodeId: "execute-1",
      executorAgentId: "cheap-executor",
      output: "executor output",
    });

    const judged = await mutate(orchestrator, "JudgeNodeOutput", {
      taskId: graph.taskId,
      nodeId: "execute-1",
      judgeAgentId: "judge-agent",
    });
    const final = await mutate(orchestrator, "FinalArbitrate", {
      taskId: graph.taskId,
      finalArbiterAgentId: "final-arbiter-agent",
    });

    expect(judged.errors[0].message).toContain("JUDGE_RESULT_INVALID");
    expect(final.errors[0].extensions.code).toBe("FINAL_ARBITER_RESULT_INVALID");
  });

  it("rejects Red Team and Final Arbiter identities that overlap reviewed roles", async () => {
    const orchestrator = createQueenOrchestrator({ agents: agents(), now, queenAgentId: "queen-router-v1" });
    const proposed = await mutate(orchestrator, "ProposeTaskGraph", {
      requirement: "Move funds on chain with independent review",
      queenAgentId: "queen-router-v1",
    });
    const graph = proposed.data.proposeTaskGraph;
    await acceptRequiredAssignments(orchestrator, graph);
    await mutate(orchestrator, "AcceptNodeAssignment", { taskId: graph.taskId, nodeId: "final-1", agentId: "red-team-agent" });
    await mutate(orchestrator, "ConfirmTaskGraph", { taskId: graph.taskId });
    await mutate(orchestrator, "StartTaskRun", { taskId: graph.taskId, manualApproval: true });
    await mutate(orchestrator, "SubmitNodeOutput", {
      taskId: graph.taskId, nodeId: "execute-1", executorAgentId: "cheap-executor", output: "output",
    });
    await mutate(orchestrator, "JudgeNodeOutput", {
      taskId: graph.taskId, nodeId: "execute-1", judgeAgentId: "judge-agent", score: 0.4, verdict: "needs_revision",
    });
    const invalidRedTeam = await mutate(orchestrator, "RequestAdversarialReview", {
      taskId: graph.taskId, nodeId: "execute-1", redTeamAgentId: "judge-agent", findings: "verdict: approved",
    });
    const validRedTeam = await mutate(orchestrator, "RequestAdversarialReview", {
      taskId: graph.taskId, nodeId: "execute-1", redTeamAgentId: "red-team-agent", findings: "verdict: approved",
    });
    const invalidFinal = await mutate(orchestrator, "FinalArbitrate", {
      taskId: graph.taskId, finalArbiterAgentId: "red-team-agent", verdict: "approved", finalOutput: "output",
    });

    expect(invalidRedTeam.errors[0].extensions.code).toBe("RED_TEAM_NOT_INDEPENDENT");
    expect(validRedTeam.errors).toBeUndefined();
    expect(invalidFinal.errors[0].extensions.code).toBe("FINAL_ARBITER_NOT_INDEPENDENT");
  });
});

async function mutate(
  orchestrator: ReturnType<typeof createQueenOrchestrator>,
  operationName: QueenMutationName,
  input: Record<string, unknown>,
): Promise<any> {
  const fieldName = operationName[0]!.toLowerCase() + operationName.slice(1);
  return orchestrator.handleGraphql({
    query: `mutation ${operationName}($input: ${operationName}Input!) { ${fieldName}(input: $input) { __typename } }`,
    operationName,
    variables: { input },
  });
}

async function acceptRequiredAssignments(
  orchestrator: ReturnType<typeof createQueenOrchestrator>,
  graph: { taskId: string; nodes: Array<{ nodeId: string; type?: string; required: boolean }> },
): Promise<void> {
  for (const node of graph.nodes.filter((candidate) => candidate.required)) {
    const agentId = node.nodeId.startsWith("judge-")
      ? "judge-agent"
      : node.nodeId.startsWith("final-")
        ? "final-arbiter-agent"
        : node.nodeId.startsWith("redteam-")
          ? "red-team-agent"
          : "cheap-executor";
    await mutate(orchestrator, "AcceptNodeAssignment", {
      taskId: graph.taskId,
      nodeId: node.nodeId,
      agentId,
    });
  }
}

async function startGraph(
  orchestrator: ReturnType<typeof createQueenOrchestrator>,
  graph: { taskId: string; nodes: Array<{ nodeId: string; type?: string; required: boolean }> },
): Promise<void> {
  await acceptRequiredAssignments(orchestrator, graph);
  await mutate(orchestrator, "ConfirmTaskGraph", { taskId: graph.taskId });
  const started = await mutate(orchestrator, "StartTaskRun", { taskId: graph.taskId });
  if (started.data.startTaskRun.status !== "running") throw new Error(`Failed to start graph ${graph.taskId}`);
}

function agents(): AgentCandidate[] {
  return [
    candidate("queen-router-v1", { provider: "codex", ownership: "local-private", capabilities: ["completion", "plan"], costPer1kTokensUsd: 0, qualityScore: 0.99, modelDigest: "local-private" }),
    candidate("cheap-executor", { capabilities: ["completion"], costPer1kTokensUsd: 0.001, qualityScore: 0.82 }),
    candidate("expensive-executor", { capabilities: ["completion"], costPer1kTokensUsd: 0.02, qualityScore: 0.9 }),
    candidate("judge-agent", { capabilities: ["judge", "completion"], costPer1kTokensUsd: 0.004, qualityScore: 0.87 }),
    candidate("red-team-agent", { capabilities: ["red_team", "completion"], costPer1kTokensUsd: 0.006, qualityScore: 0.86 }),
    candidate("final-arbiter-agent", { capabilities: ["final_arbitration", "completion"], costPer1kTokensUsd: 0.006, qualityScore: 0.9 }),
  ];
}

function candidate(agentId: string, overrides: Partial<AgentCandidate>): AgentCandidate {
  return {
    agentId,
    displayName: agentId,
    capabilities: ["completion"],
    tags: [],
    provider: "qwen",
    ownership: "third-party/provider-api",
    selectableBy: "public-market",
    status: "online",
    costPer1kTokensUsd: 0.01,
    latencyMs: 800,
    qualityScore: 0.8,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    modelTag: agentId,
    modelDigest: "provider-managed",
    riskCodes: [],
    ...overrides,
  };
}
