import {
  QueenGraphqlRequestSchema,
  RequiredWorkflowStages,
  TaskGraphSchema,
  type AgentCandidate,
  type NodeAssignment,
  type QueenGraphqlRequest,
  type QueenMutationName,
  type TaskGraph,
  type TaskNode,
} from "@agent-market/shared-contracts";

import { rankAgentCandidates } from "./queen-ranking";
import { createQueenFrameworkRuntime, type QueenFrameworkRuntime } from "./queen-workflow-runtime";

type QueenTaskRecord = {
  taskId: string;
  requirement: string;
  queenAgentId: string;
  graph: TaskGraph;
  assignments: Map<string, NodeAssignment>;
  outputs: Map<string, { executorAgentId: string; output: string; outputId: string }>;
  learningRecords: Array<{ memoryRecordId: string; summary: string }>;
};

export type QueenAgentExecutionRole = "executor" | "judge" | "red_team" | "repair" | "final_arbiter";

export type QueenAgentExecutionRequest = {
  taskId: string;
  nodeId?: string;
  agentId: string;
  role: QueenAgentExecutionRole;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
};

export type QueenOrchestratorOptions = {
  agents: AgentCandidate[];
  queenAgentId: string;
  now?: () => Date;
  executeAgentText?: (request: QueenAgentExecutionRequest) => Promise<string>;
  frameworkRuntime?: QueenFrameworkRuntime;
  allowOwnerOnlyAgents?: boolean;
};

export type QueenGraphqlResponse = {
  data: Record<string, any> | null;
  errors?: Array<{
    message: string;
    extensions: { code: string; retryable: boolean };
  }>;
};

export function createQueenOrchestrator(options: QueenOrchestratorOptions) {
  const now = options.now ?? (() => new Date());
  const tasks = new Map<string, QueenTaskRecord>();
  const frameworkRuntime = options.frameworkRuntime ?? createQueenFrameworkRuntime();

  return {
    async handleGraphql(request: QueenGraphqlRequest): Promise<QueenGraphqlResponse> {
      const parsed = QueenGraphqlRequestSchema.safeParse(request);
      if (!parsed.success) return graphqlError("VALIDATION_FAILED", "Queen GraphQL request shape is invalid");

      const operationName = parsed.data.operationName ?? inferOperationName(parsed.data.query);
      if (operationName === undefined) return graphqlError("VALIDATION_FAILED", "Unsupported Queen GraphQL operation");
      const input = parsed.data.variables.input;

      try {
        await frameworkRuntime.execute({
          operationName,
          taskId: typeof input["taskId"] === "string" ? input["taskId"] : undefined,
          nodeId: typeof input["nodeId"] === "string" ? input["nodeId"] : undefined,
          stages: [],
        });
        switch (operationName) {
          case "ProposeTaskGraph":
            return data("proposeTaskGraph", proposeTaskGraph(input));
          case "RankNodeAgents":
            return data("rankNodeAgents", rankNodeAgents(input));
          case "SelectNodeAgent":
            return data("selectNodeAgent", selectNodeAgent(input));
          case "AcceptNodeAssignment":
            return data("acceptNodeAssignment", acceptNodeAssignment(input));
          case "ConfirmTaskGraph":
            return data("confirmTaskGraph", confirmTaskGraph(input));
          case "StartTaskRun":
            return data("startTaskRun", startTaskRun(input));
          case "SubmitNodeOutput":
            return data("submitNodeOutput", await submitNodeOutput(input));
          case "JudgeNodeOutput":
            return await judgeNodeOutput(input);
          case "RequestAdversarialReview":
            return data("requestAdversarialReview", await requestAdversarialReview(input));
          case "RepairNode":
            return data("repairNode", await repairNode(input));
          case "FinalArbitrate":
            return await finalArbitrate(input);
          case "WriteLearningLoop":
            return data("writeLearningLoop", writeLearningLoop(input));
        }
      } catch (error) {
        return graphqlError("STATE_ERROR", safeMessage(error));
      }
    },
  };

  function proposeTaskGraph(input: Record<string, unknown>) {
    const requirement = stringInput(input, "requirement");
    const queenAgentId = optionalStringInput(input, "queenAgentId") ?? options.queenAgentId;
    const taskId = optionalStringInput(input, "taskId") ?? crypto.randomUUID();
    const riskLevel = inferRiskLevel(requirement);
    const startPolicy = riskLevel === "high" ? "manualRequired" : "auto";
    const nodes: TaskNode[] = [
      { nodeId: "plan-1", type: "plan", title: "Plan", dependencies: [], required: true },
      { nodeId: "execute-1", type: "execute", title: "Execute", dependencies: ["plan-1"], required: true },
      { nodeId: "judge-1", type: "judge", title: "Judge execute", dependencies: ["execute-1"], required: true, judgesNodeId: "execute-1" },
      { nodeId: "repair-1", type: "repair", title: "Repair fallback", dependencies: ["judge-1"], required: false, repairsNodeId: "execute-1" },
      ...(riskLevel === "high"
        ? [{ nodeId: "redteam-1", type: "red_team" as const, title: "Red-team review", dependencies: ["judge-1"], required: true }]
        : []),
      { nodeId: "final-1", type: "synthesize", title: "Final arbitration", dependencies: riskLevel === "high" ? ["redteam-1"] : ["judge-1"], required: true },
      { nodeId: "deliver-1", type: "deliver", title: "Deliver", dependencies: ["final-1"], required: true },
    ];
    const graph = TaskGraphSchema.parse({
      taskId,
      graphRevision: 1,
      requiredStages: [...RequiredWorkflowStages],
      riskLevel,
      startPolicy,
      nodes,
      edges: [
        { from: "plan-1", to: "execute-1" },
        { from: "execute-1", to: "judge-1" },
        { from: "judge-1", to: "repair-1", condition: "needs_revision" },
        ...(riskLevel === "high"
          ? [
              { from: "judge-1", to: "redteam-1", condition: "needs_revision" as const },
              { from: "redteam-1", to: "final-1" },
            ]
          : [{ from: "judge-1", to: "final-1", condition: "approved" as const }]),
        { from: "final-1", to: "deliver-1" },
      ],
      rescuePolicy: { mode: "auto", visibleToUser: false, evidenceVisible: true },
    });
    tasks.set(taskId, {
      taskId,
      requirement,
      queenAgentId,
      graph,
      assignments: new Map(),
      outputs: new Map(),
      learningRecords: [],
    });
    return graph;
  }

  function rankNodeAgents(input: Record<string, unknown>) {
    const task = taskFor(input);
    const nodeId = stringInput(input, "nodeId");
    const node = nodeFor(task, nodeId);
    const requiredCapabilities = stringArrayInput(input, "requiredCapabilities", capabilitiesForNode(node));
    const eligibleAgents = node.type === "plan"
      ? options.agents
      : options.agents.filter((agent) => agent.agentId !== task.queenAgentId);
    const candidates = rankAgentCandidates({
      nodeType: node.type,
      requiredCapabilities,
      now: now(),
      candidates: eligibleAgents,
    });
    const autoSelectedAgentId = candidates[0]?.agentId;
    if (autoSelectedAgentId !== undefined) {
      task.assignments.set(nodeId, {
        nodeId,
        selectedAgentId: autoSelectedAgentId,
        status: "selected",
        selectedBy: "queen",
        override: false,
        riskCodes: [],
      });
    }
    return {
      nodeId,
      candidates,
      autoSelectedAgentId,
      rankingPolicy: "model-pool-draw-license-tags-capability-cost-availability-latency-quality-old-model-retirement-new-model-exploration-distinct-model",
    };
  }

  function selectNodeAgent(input: Record<string, unknown>) {
    const task = taskFor(input);
    const nodeId = stringInput(input, "nodeId");
    const selectedAgentId = stringInput(input, "selectedAgentId");
    const selectedBy = optionalStringInput(input, "selectedBy") === "user" ? "user" : "queen";
    const override = selectedBy === "user";
    const riskCodes = stringArrayInput(input, "riskCodes", []);
    if (override && riskCodes.length > 0 && input["riskNoticeAccepted"] !== true) {
      throw new Error("User override risk notice must be accepted");
    }
    assertSelectableAgent(selectedAgentId);
    const assignment: NodeAssignment = {
      nodeId,
      selectedAgentId,
      status: "selected",
      selectedBy,
      override,
      overrideReason: optionalStringInput(input, "overrideReason"),
      riskNoticeAccepted: input["riskNoticeAccepted"] === true ? true : undefined,
      riskCodes,
    };
    task.assignments.set(nodeId, assignment);
    return assignment;
  }

  function acceptNodeAssignment(input: Record<string, unknown>) {
    const task = taskFor(input);
    const nodeId = stringInput(input, "nodeId");
    const selectedAgentId = optionalStringInput(input, "agentId") ?? optionalStringInput(input, "selectedAgentId");
    const existing = task.assignments.get(nodeId);
    if (existing === undefined && selectedAgentId === undefined) throw new Error("Node assignment is not selected");
    if (selectedAgentId !== undefined) assertSelectableAgent(selectedAgentId);
    const assignment: NodeAssignment = {
      nodeId,
      selectedAgentId: selectedAgentId ?? existing!.selectedAgentId,
      status: "accepted",
      selectedBy: existing?.selectedBy ?? "queen",
      acceptedAt: now().toISOString(),
      override: existing?.override ?? false,
      overrideReason: existing?.overrideReason,
      riskNoticeAccepted: existing?.riskNoticeAccepted,
      riskCodes: existing?.riskCodes ?? [],
    };
    task.assignments.set(nodeId, assignment);
    return assignment;
  }

  function confirmTaskGraph(input: Record<string, unknown>) {
    const task = taskFor(input);
    return { taskId: task.taskId, graphRevision: task.graph.graphRevision, confirmationStatus: "confirmed" };
  }

  function startTaskRun(input: Record<string, unknown>) {
    const task = taskFor(input);
    const missing = task.graph.nodes
      .filter((node) => node.required)
      .filter((node) => task.assignments.get(node.nodeId)?.status !== "accepted")
      .map((node) => node.nodeId);
    if (missing.length > 0) {
      return { taskId: task.taskId, status: "blocked", reasonCode: "ASSIGNMENT_NOT_ACCEPTED", missingNodeIds: missing };
    }
    if (task.graph.startPolicy === "manualRequired" && input["manualApproval"] !== true) {
      return { taskId: task.taskId, status: "blocked", reasonCode: "HIGH_RISK_MANUAL_START_REQUIRED" };
    }
    return { taskId: task.taskId, runId: crypto.randomUUID(), status: "running" };
  }

  async function submitNodeOutput(input: Record<string, unknown>) {
    const task = taskFor(input);
    const nodeId = stringInput(input, "nodeId");
    const executorAgentId = stringInput(input, "executorAgentId");
    assertSelectableAgent(executorAgentId);
    const output = optionalStringInput(input, "output") ?? await executeAgentText({
      taskId: task.taskId,
      nodeId,
      agentId: executorAgentId,
      role: "executor",
      messages: [{ role: "user", content: buildExecutorPrompt(task, nodeId) }],
    });
    const outputId = crypto.randomUUID();
    task.outputs.set(nodeId, { executorAgentId, output, outputId });
    return { nodeId, outputId, output, status: "submitted" };
  }

  async function judgeNodeOutput(input: Record<string, unknown>): Promise<QueenGraphqlResponse> {
    const task = taskFor(input);
    const nodeId = stringInput(input, "nodeId");
    const judgeAgentId = stringInput(input, "judgeAgentId");
    assertSelectableAgent(judgeAgentId);
    const output = task.outputs.get(nodeId);
    if (output === undefined) return graphqlError("NODE_OUTPUT_NOT_FOUND", "Node output must be submitted before judging");
    if (judgeAgentId === task.queenAgentId || judgeAgentId === output.executorAgentId) {
      return graphqlError("JUDGE_NOT_INDEPENDENT", "Judge must be independent from Queen and executor");
    }
    const judgeText = input["score"] === undefined || input["verdict"] === undefined
      ? await executeAgentText({
          taskId: task.taskId,
          nodeId,
          agentId: judgeAgentId,
          role: "judge",
          messages: [{ role: "user", content: buildJudgePrompt(task, nodeId, output.output) }],
        })
      : undefined;
    const parsedJudge = judgeText !== undefined ? parseJudgeText(judgeText) : undefined;
    const score = typeof input["score"] === "number" ? numberInput(input, "score") : parsedJudge?.score ?? 1;
    const verdict = optionalStringInput(input, "verdict") ?? parsedJudge?.verdict ?? "approved";
    const redTeamRequired = score < 0.65 || verdict !== "approved";
    return data("judgeNodeOutput", {
      nodeId,
      judgeAgentId,
      verdict,
      score,
      redTeamRequired,
      status: redTeamRequired ? "needs_revision" : "approved",
    });
  }

  async function requestAdversarialReview(input: Record<string, unknown>) {
    const task = taskFor(input);
    const nodeId = stringInput(input, "nodeId");
    const redTeamAgentId = stringInput(input, "redTeamAgentId");
    assertSelectableAgent(redTeamAgentId);
    const findings = optionalStringInput(input, "findings") ?? await executeAgentText({
      taskId: task.taskId,
      nodeId,
      agentId: redTeamAgentId,
      role: "red_team",
      messages: [{ role: "user", content: buildRedTeamPrompt(task, nodeId) }],
    });
    return {
      taskId: task.taskId,
      nodeId,
      redTeamAgentId,
      findings,
      status: "adversarial_reviewing",
    };
  }

  async function repairNode(input: Record<string, unknown>) {
    const task = taskFor(input);
    const parentNodeId = stringInput(input, "parentNodeId");
    const repairAgentId = optionalStringInput(input, "repairAgentId") ?? optionalStringInput(input, "agentId") ?? task.outputs.get(parentNodeId)?.executorAgentId;
    if (repairAgentId === undefined) throw new Error("Repair agent is required");
    assertSelectableAgent(repairAgentId);
    const output = optionalStringInput(input, "output") ?? await executeAgentText({
      taskId: task.taskId,
      nodeId: parentNodeId,
      agentId: repairAgentId,
      role: "repair",
      messages: [{ role: "user", content: buildRepairPrompt(task, parentNodeId) }],
    });
    return { taskId: task.taskId, parentNodeId, repairNodeId: `repair-${parentNodeId}-${task.graph.graphRevision}`, output, status: "planned" };
  }

  async function finalArbitrate(input: Record<string, unknown>): Promise<QueenGraphqlResponse> {
    const task = taskFor(input);
    const finalArbiterAgentId = stringInput(input, "finalArbiterAgentId");
    assertSelectableAgent(finalArbiterAgentId);
    if (finalArbiterAgentId === task.queenAgentId) {
      return graphqlError("FINAL_ARBITER_NOT_INDEPENDENT", "Final Arbiter must be independent from Queen");
    }
    const finalOutput = optionalStringInput(input, "finalOutput") ?? await executeAgentText({
      taskId: task.taskId,
      agentId: finalArbiterAgentId,
      role: "final_arbiter",
      messages: [{ role: "user", content: buildFinalArbiterPrompt(task) }],
    });
    return data("finalArbitrate", {
      taskId: task.taskId,
      finalArbiterAgentId,
      verdict: optionalStringInput(input, "verdict") ?? "approved",
      finalOutput,
    });
  }

  function writeLearningLoop(input: Record<string, unknown>) {
    const task = taskFor(input);
    const memoryRecordId = crypto.randomUUID();
    const summary = redactSensitiveText(stringInput(input, "summary"));
    task.learningRecords.push({ memoryRecordId, summary });
    return { memoryRecordId, status: "written", summary };
  }

  function taskFor(input: Record<string, unknown>): QueenTaskRecord {
    const taskId = stringInput(input, "taskId");
    const task = tasks.get(taskId);
    if (task === undefined) throw new Error(`Task ${taskId} does not exist`);
    return task;
  }

  async function executeAgentText(request: QueenAgentExecutionRequest): Promise<string> {
    if (options.executeAgentText === undefined) throw new Error("Agent execution hook is not configured");
    return options.executeAgentText(request);
  }

  function assertSelectableAgent(agentId: string): void {
    const agent = options.agents.find((item) => item.agentId === agentId);
    if (agent === undefined) throw new Error(`Agent ${agentId} does not exist`);
    if (agent.status === "offline") throw new Error(`Agent ${agentId} is offline`);
    if (agent.selectableBy === "owner-only" && options.allowOwnerOnlyAgents !== true) throw new Error(`Agent ${agentId} is owner-only and cannot be selected from the public workflow`);
  }
}

function data(fieldName: string, value: unknown): QueenGraphqlResponse {
  return { data: { [fieldName]: value } };
}

function graphqlError(code: string, message: string): QueenGraphqlResponse {
  return {
    data: null,
    errors: [{ message, extensions: { code, retryable: false } }],
  };
}

function inferOperationName(query: string): QueenMutationName | undefined {
  const match = query.match(/\b(ProposeTaskGraph|RankNodeAgents|SelectNodeAgent|AcceptNodeAssignment|ConfirmTaskGraph|StartTaskRun|SubmitNodeOutput|JudgeNodeOutput|RequestAdversarialReview|RepairNode|FinalArbitrate|WriteLearningLoop)\b/);
  return match?.[1] as QueenMutationName | undefined;
}

function inferRiskLevel(requirement: string): "low" | "medium" | "high" {
  return /\b(fund|funds|wallet|chain|contract|medical|legal|finance|security|private key)\b/i.test(requirement)
    ? "high"
    : "low";
}

function capabilitiesForNode(node: TaskNode): string[] {
  if (node.type === "judge") return ["judge"];
  if (node.type === "red_team") return ["red_team"];
  if (node.type === "synthesize" || node.type === "deliver") return ["final_arbitration"];
  if (node.type === "plan") return ["plan"];
  return ["completion"];
}

function nodeFor(task: QueenTaskRecord, nodeId: string): TaskNode {
  const node = task.graph.nodes.find((item) => item.nodeId === nodeId);
  if (node === undefined) throw new Error(`Node ${nodeId} does not exist`);
  return node;
}

function stringInput(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing string input: ${key}`);
  return value;
}

function optionalStringInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberInput(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Missing number input: ${key}`);
  return value;
}

function stringArrayInput(input: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = input[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : fallback;
}

function redactSensitiveText(value: string): string {
  return value.replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted-secret]");
}

function buildExecutorPrompt(task: QueenTaskRecord, nodeId: string): string {
  return `Execute node ${nodeId} for requirement:\n${task.requirement}`;
}

function buildJudgePrompt(task: QueenTaskRecord, nodeId: string, output: string): string {
  return `Judge node ${nodeId} for requirement:\n${task.requirement}\n\nExecutor output:\n${output}\n\nReturn verdict and score.`;
}

function buildRedTeamPrompt(task: QueenTaskRecord, nodeId: string): string {
  return `Red-team node ${nodeId} for requirement:\n${task.requirement}\nFind missing evidence, unsafe assumptions, and contradictions.`;
}

function buildRepairPrompt(task: QueenTaskRecord, nodeId: string): string {
  return `Repair node ${nodeId} for requirement:\n${task.requirement}\nAddress judge and red-team findings.`;
}

function buildFinalArbiterPrompt(task: QueenTaskRecord): string {
  return `Final arbitrate task ${task.taskId} for requirement:\n${task.requirement}\nUse isolated context and decide the final output.`;
}

function parseJudgeText(value: string): { verdict: "approved" | "needs_revision" | "rejected"; score: number } {
  const verdictMatch = value.match(/\b(approved|needs_revision|rejected)\b/i);
  const scoreMatch = value.match(/score:\s*([0-9]+(?:\.[0-9]+)?)/i);
  return {
    verdict: verdictMatch?.[1]?.toLowerCase() === "rejected"
      ? "rejected"
      : verdictMatch?.[1]?.toLowerCase() === "needs_revision"
        ? "needs_revision"
        : "approved",
    score: scoreMatch?.[1] !== undefined ? Number(scoreMatch[1]) : 1,
  };
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message.slice(0, 240) : "Queen orchestrator failed";
}
