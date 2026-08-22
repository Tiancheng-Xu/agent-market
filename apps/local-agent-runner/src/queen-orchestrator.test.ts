import { describe, expect, it, vi } from "vitest";

import type { AgentCandidate, QueenMutationName } from "@agent-market/shared-contracts";

import { createQueenOrchestrator } from "./queen-orchestrator";

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

  it("rejects judge self-review and final arbitration by Queen", async () => {
    const orchestrator = createQueenOrchestrator({ agents: agents(), now, queenAgentId: "queen-router-v1" });
    const proposed = await mutate(orchestrator, "ProposeTaskGraph", {
      requirement: "Write a simple implementation plan",
      queenAgentId: "queen-router-v1",
    });
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

    expect(judged.errors[0].extensions.code).toBe("JUDGE_NOT_INDEPENDENT");
    expect(arbitrated.errors[0].extensions.code).toBe("FINAL_ARBITER_NOT_INDEPENDENT");
  });

  it("triggers red-team on low judge score and writes redacted learning-loop records", async () => {
    const orchestrator = createQueenOrchestrator({ agents: agents(), now, queenAgentId: "queen-router-v1" });
    const proposed = await mutate(orchestrator, "ProposeTaskGraph", {
      requirement: "Write a simple implementation plan",
      queenAgentId: "queen-router-v1",
    });
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
      if (request.role === "final_arbiter") return "final approved output";
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
    expect(repaired.data.repairNode.output).toBe("repair output");
    expect(final.data.finalArbitrate.finalOutput).toBe("final approved output");
    expect(executeAgentText.mock.calls.map(([request]) => request.role)).toEqual([
      "executor",
      "judge",
      "red_team",
      "repair",
      "final_arbiter",
    ]);
  });

  it("runs Queen mutations through the Mastra/LangGraph framework boundary", async () => {
    const frameworkRuntime = { mastra: {} as any, execute: vi.fn(async (input) => ({ ...input, runtime: { mastra: "registered", langGraph: "compiled" }, stages: ["test"] })) };
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
