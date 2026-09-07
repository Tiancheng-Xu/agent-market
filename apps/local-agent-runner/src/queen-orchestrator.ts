import { createHash } from "node:crypto";

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

import { selectThreeWithAudit } from "./queen-ranking";
import { createQueenFrameworkRuntime, type QueenFrameworkRuntime } from "./queen-workflow-runtime";
import type { QueenWorkflowSnapshot, QueenWorkflowStore } from "./queen-workflow-store";

const canonicalModelIdentity = (modelTag: string) => modelTag.trim().toLowerCase();

type QueenTaskRecord = {
  taskId: string;
  recordVersion: number;
  operationResults: Map<string, { agentId: string; result: Record<string, unknown> }>;
  requirement: string;
  queenAgentId: string;
  graph: TaskGraph;
  assignments: Map<string, NodeAssignment>;
  outputs: Map<string, { executorAgentId: string; output: string; outputId: string }>;
  judgments: Map<string, { nodeId: string; judgeAgentId: string; verdict: string; score: number; redTeamRequired: boolean; status: string }>;
  finalArbitration: { taskId: string; finalArbiterAgentId: string; verdict: string; finalOutput: string } | undefined;
  learningRecords: Array<{ memoryRecordId: string; summary: string }>;
  systemNodeIds: Map<string, string>;
  graphConfirmedRevision: number | undefined;
  runId: string | undefined;
};

export type QueenAgentExecutionRole = "executor" | "judge" | "red_team" | "repair" | "final_arbiter";

export type QueenAgentExecutionRequest = {
  taskId: string;
  nodeId?: string;
  agentId: string;
  role: QueenAgentExecutionRole;
  operationKey: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
};

export type QueenOrchestratorOptions = {
  agents: AgentCandidate[];
  queenAgentId: string;
  now?: () => Date;
  executeAgentText?: (request: QueenAgentExecutionRequest) => Promise<string>;
  frameworkRuntime?: QueenFrameworkRuntime;
  allowOwnerOnlyAgents?: boolean;
  workflowStore?: QueenWorkflowStore;
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
  const operationTasks = new WeakMap<Record<string, unknown>, Map<string, QueenTaskRecord>>();
  const frameworkRuntime = options.frameworkRuntime ?? createQueenFrameworkRuntime();

  return {
    async handleGraphql(request: QueenGraphqlRequest): Promise<QueenGraphqlResponse> {
      const parsed = QueenGraphqlRequestSchema.safeParse(request);
      if (!parsed.success) return graphqlError("VALIDATION_FAILED", "Queen GraphQL request shape is invalid");

      const operationName = parsed.data.operationName ?? inferOperationName(parsed.data.query);
      if (operationName === undefined) return graphqlError("VALIDATION_FAILED", "Unsupported Queen GraphQL operation");
      const input = parsed.data.variables.input;

      try {
        await hydrateTask(input);
        const stagedTasks = new Map(tasks);
        const requestedTaskId = optionalStringInput(input, "taskId");
        if (requestedTaskId !== undefined) {
          const existing = tasks.get(requestedTaskId);
          if (existing !== undefined) stagedTasks.set(requestedTaskId, structuredClone(existing));
        }
        operationTasks.set(input, stagedTasks);
        const frameworkInput = {
          operationName,
          taskId: typeof input["taskId"] === "string" ? input["taskId"] : undefined,
          nodeId: typeof input["nodeId"] === "string" ? input["nodeId"] : undefined,
          stages: [],
        };
        let response!: QueenGraphqlResponse;
        const executeOperation = async () => {
        switch (operationName) {
          case "ProposeTaskGraph":
            response = data("proposeTaskGraph", proposeTaskGraph(input));
            break;
          case "AmendTaskGraph":
            response = data("amendTaskGraph", amendTaskGraph(input));
            break;
          case "RankNodeAgents":
            response = data("rankNodeAgents", rankNodeAgents(input));
            break;
          case "SelectNodeAgent":
            response = data("selectNodeAgent", selectNodeAgent(input));
            break;
          case "AcceptNodeAssignment":
            response = data("acceptNodeAssignment", acceptNodeAssignment(input));
            break;
          case "ConfirmTaskGraph":
            response = data("confirmTaskGraph", confirmTaskGraph(input));
            break;
          case "StartTaskRun":
            response = data("startTaskRun", startTaskRun(input));
            break;
          case "SubmitNodeOutput":
            response = data("submitNodeOutput", await submitNodeOutput(input));
            break;
          case "JudgeNodeOutput":
            response = await judgeNodeOutput(input);
            break;
          case "RequestAdversarialReview":
            response = await requestAdversarialReview(input);
            break;
          case "RepairNode":
            response = data("repairNode", await repairNode(input));
            break;
          case "FinalArbitrate":
            response = await finalArbitrate(input);
            break;
          case "WriteLearningLoop":
            response = data("writeLearningLoop", writeLearningLoop(input));
            break;
        }
        };
        if (frameworkRuntime.executeOperation) {
          await frameworkRuntime.executeOperation(frameworkInput, executeOperation);
        } else {
          // Compatibility for explicitly injected runtimes; not a durable-execution claim.
          await frameworkRuntime.execute(frameworkInput);
          await executeOperation();
        }
        if (response.data !== null) {
          await persistTask(input, response);
          const taskId = optionalStringInput(input, "taskId") ?? findResponseTaskId(response);
          const stagedTask = taskId === undefined ? undefined : stagedTasks.get(taskId);
          if (stagedTask !== undefined) tasks.set(stagedTask.taskId, stagedTask);
        }
        operationTasks.delete(input);
        return response;
      } catch (error) {
        operationTasks.delete(input);
        return graphqlError("STATE_ERROR", safeMessage(error));
      }
    },
  };

  function proposeTaskGraph(input: Record<string, unknown>) {
    const taskRecords = taskRecordsFor(input);
    const requirement = stringInput(input, "requirement");
    const queenAgentId = optionalStringInput(input, "queenAgentId") ?? options.queenAgentId;
    const taskId = optionalStringInput(input, "taskId") ?? crypto.randomUUID();
    const existing = taskRecords.get(taskId);
    if (existing !== undefined) {
      if (existing.requirement !== requirement || existing.queenAgentId !== queenAgentId) {
        throw new Error(`Task ${taskId} already exists with a different proposal`);
      }
      return existing.graph;
    }
    const riskLevel = inferRiskLevel(requirement);
    const startPolicy = riskLevel === "high" ? "manualRequired" : "auto";
    const nodes: TaskNode[] = [
      { nodeId: "plan-1", type: "plan", title: "Plan", dependencies: [], required: true, contract: contractFor("plan") },
      { nodeId: "execute-1", type: "execute", title: "Execute", dependencies: ["plan-1"], required: true, contract: contractFor("execute") },
      { nodeId: "judge-1", type: "judge", title: "Judge execute", dependencies: ["execute-1"], required: true, judgesNodeId: "execute-1", contract: contractFor("judge") },
      { nodeId: "repair-1", type: "repair", title: "Repair fallback", dependencies: ["judge-1"], required: false, repairsNodeId: "execute-1", contract: contractFor("repair") },
      ...(riskLevel === "high"
        ? [{ nodeId: "redteam-1", type: "red_team" as const, title: "Red-team review", dependencies: ["judge-1"], required: true, contract: contractFor("red_team") }]
        : []),
      { nodeId: "final-1", type: "synthesize", title: "Final arbitration", dependencies: riskLevel === "high" ? ["redteam-1"] : ["judge-1"], required: true, contract: contractFor("synthesize") },
      { nodeId: "deliver-1", type: "deliver", title: "Deliver", dependencies: ["final-1"], required: true, contract: contractFor("deliver") },
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
    taskRecords.set(taskId, {
      taskId,
      recordVersion: 0,
      operationResults: new Map(),
      requirement,
      queenAgentId,
      graph,
      assignments: new Map(),
      outputs: new Map(),
      judgments: new Map(),
      finalArbitration: undefined,
      learningRecords: [],
      systemNodeIds: new Map(),
      graphConfirmedRevision: undefined,
      runId: undefined,
    });
    return graph;
  }

  function amendTaskGraph(input: Record<string, unknown>) {
    const task = taskFor(input);
    assertTaskMutable(task);
    const previousNodeTypes = new Map(task.graph.nodes.map((node) => [node.nodeId, node.type]));
    const graph = TaskGraphSchema.parse({
      ...task.graph,
      graphRevision: task.graph.graphRevision + 1,
      nodes: input["nodes"],
      edges: input["edges"],
    });
    const nextNodeTypes = new Map(graph.nodes.map((node) => [node.nodeId, node.type]));
    const preservedAssignmentNodeIds: string[] = [];

    for (const nodeId of task.assignments.keys()) {
      if (previousNodeTypes.get(nodeId) === nextNodeTypes.get(nodeId)) {
        preservedAssignmentNodeIds.push(nodeId);
      } else {
        task.assignments.delete(nodeId);
      }
    }

    task.graph = graph;
    task.graphConfirmedRevision = undefined;
    return {
      ...graph,
      confirmationStatus: "pending",
      preservedAssignmentNodeIds,
    };
  }

  function rankNodeAgents(input: Record<string, unknown>) {
    const task = taskFor(input);
    assertTaskMutable(task);
    const nodeId = stringInput(input, "nodeId");
    const node = nodeFor(task, nodeId);
    const requiredCapabilities = stringArrayInput(input, "requiredCapabilities", capabilitiesForNode(node));
    const excludedAgentIds = new Set(stringArrayInput(input, "excludedAgentIds", []));
    const excludedModelTags = new Set(stringArrayInput(input, "excludedModelTags", [])
      .map(canonicalModelIdentity));
    const queen = options.agents.find((agent) => agent.agentId === task.queenAgentId);
    if (node.type !== "plan") {
      excludedAgentIds.add(task.queenAgentId);
      if (queen) excludedModelTags.add(canonicalModelIdentity(queen.modelTag));
    }
    const eligibleAgents = options.agents.filter((agent) => !excludedAgentIds.has(agent.agentId)
      && !excludedModelTags.has(canonicalModelIdentity(agent.modelTag)));
    const category = optionalStringInput(input, "category");
    const requiredTags = stringArrayInput(input, "requiredTags", []);
    const callerScope = options.allowOwnerOnlyAgents === true ? "owner" : "public";
    const selection = selectThreeWithAudit({
      nodeType: node.type,
      ...(category === undefined ? {} : { category }),
      requiredTags,
      requiredCapabilities,
      callerScope,
      now: now(),
      candidates: eligibleAgents,
      selectionPolicy: {
        taskId: task.taskId,
        matchingRound: task.graph.graphRevision,
        policyVersion: "fair-exploration-v1",
        disableColdStart: task.graph.riskLevel === "high",
      },
    });
    const candidates = selection.candidates;
    const autoSelectedAgentId = candidates[0]?.agentId;
    if (autoSelectedAgentId !== undefined) {
      assertSelectableAgent(autoSelectedAgentId);
      task.assignments.set(nodeId, {
        nodeId,
        selectedAgentId: autoSelectedAgentId,
        status: "selected",
        selectedBy: "queen",
        override: false,
        riskCodes: [],
      });
      task.graphConfirmedRevision = undefined;
    }
    return {
      nodeId,
      candidates,
      autoSelectedAgentId,
      rankingPolicy: "hard-filter-two-history-one-seeded-cold-start-decayed-window-quality-owner-scope-distinct-model-v1",
      matchingAudit: selection.audit,
    };
  }

  function selectNodeAgent(input: Record<string, unknown>) {
    const task = taskFor(input);
    assertTaskMutable(task);
    const nodeId = stringInput(input, "nodeId");
    nodeFor(task, nodeId);
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
    task.graphConfirmedRevision = undefined;
    return assignment;
  }

  function acceptNodeAssignment(input: Record<string, unknown>) {
    const task = taskFor(input);
    assertTaskMutable(task);
    const nodeId = stringInput(input, "nodeId");
    nodeFor(task, nodeId);
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
    task.graphConfirmedRevision = undefined;
    return assignment;
  }

  function confirmTaskGraph(input: Record<string, unknown>) {
    const task = taskFor(input);
    assertTaskMutable(task);
    const missingNodeIds = missingRequiredAssignments(task);
    if (missingNodeIds.length > 0) {
      throw new Error(`Required assignments must be accepted before confirmation: ${missingNodeIds.join(", ")}`);
    }
    task.graphConfirmedRevision = task.graph.graphRevision;
    return { taskId: task.taskId, graphRevision: task.graph.graphRevision, confirmationStatus: "confirmed" };
  }

  function startTaskRun(input: Record<string, unknown>) {
    const task = taskFor(input);
    if (task.runId !== undefined) {
      return { taskId: task.taskId, runId: task.runId, status: "running" };
    }
    const missing = missingRequiredAssignments(task);
    if (missing.length > 0) {
      return { taskId: task.taskId, status: "blocked", reasonCode: "ASSIGNMENT_NOT_ACCEPTED", missingNodeIds: missing };
    }
    if (task.graphConfirmedRevision !== task.graph.graphRevision) {
      return { taskId: task.taskId, status: "blocked", reasonCode: "GRAPH_NOT_CONFIRMED" };
    }
    if (task.graph.startPolicy === "manualRequired" && input["manualApproval"] !== true) {
      return { taskId: task.taskId, status: "blocked", reasonCode: "HIGH_RISK_MANUAL_START_REQUIRED" };
    }
    task.runId = crypto.randomUUID();
    return { taskId: task.taskId, runId: task.runId, status: "running" };
  }

  async function submitNodeOutput(input: Record<string, unknown>) {
    const task = taskFor(input);
    assertRunStarted(task);
    const nodeId = stringInput(input, "nodeId");
    const executorAgentId = stringInput(input, "executorAgentId");
    assertSelectableAgent(executorAgentId);
    const node = nodeFor(task, nodeId);
    if (node.type !== "execute") throw new Error("SubmitNodeOutput requires an execute node");
    assertAcceptedAssignment(task, nodeId, executorAgentId);
    const existing = task.outputs.get(nodeId);
    if (existing !== undefined) {
      if (existing.executorAgentId !== executorAgentId) throw new Error("Node output executor cannot change after submission");
      return { nodeId, ...existing, status: "submitted" };
    }
    const output = optionalStringInput(input, "output") ?? await executeAgentText({
      taskId: task.taskId,
      nodeId,
      agentId: executorAgentId,
      role: "executor",
      operationKey: operationKeyFor(task, input, "executor", nodeId),
      messages: [{ role: "user", content: buildExecutorPrompt(task, nodeId) }],
    });
    const outputId = crypto.randomUUID();
    task.outputs.set(nodeId, { executorAgentId, output, outputId });
    return { nodeId, outputId, output, status: "submitted" };
  }

  async function judgeNodeOutput(input: Record<string, unknown>): Promise<QueenGraphqlResponse> {
    const task = taskFor(input);
    assertRunStarted(task);
    const nodeId = stringInput(input, "nodeId");
    const judgeAgentId = stringInput(input, "judgeAgentId");
    assertSelectableAgent(judgeAgentId);
    const output = task.outputs.get(nodeId);
    if (output === undefined) return graphqlError("NODE_OUTPUT_NOT_FOUND", "Node output must be submitted before judging");
    if (!isIndependentAgent(judgeAgentId, [task.queenAgentId, output.executorAgentId])) {
      return graphqlError("JUDGE_NOT_INDEPENDENT", "Judge must be independent from Queen and executor");
    }
    const judgeNode = task.graph.nodes.find((node) => node.type === "judge" && node.judgesNodeId === nodeId);
    if (judgeNode !== undefined) assertAcceptedAssignment(task, judgeNode.nodeId, judgeAgentId);
    const existing = task.judgments.get(nodeId);
    if (existing !== undefined) {
      if (existing.judgeAgentId !== judgeAgentId) return graphqlError("JUDGE_NOT_INDEPENDENT", "Judge cannot change after judgment");
      return data("judgeNodeOutput", existing);
    }
    const judgeText = input["score"] === undefined || input["verdict"] === undefined
      ? await executeAgentText({
          taskId: task.taskId,
          nodeId,
          agentId: judgeAgentId,
          role: "judge",
          operationKey: operationKeyFor(task, input, "judge", nodeId),
          messages: [{ role: "user", content: buildJudgePrompt(task, nodeId, output.output) }],
        })
      : undefined;
    const parsedJudge = judgeText !== undefined ? parseJudgeText(judgeText) : undefined;
    const explicitVerdict = optionalStringInput(input, "verdict");
    if (explicitVerdict !== undefined && !isReviewVerdict(explicitVerdict)) throw new Error("JUDGE_RESULT_INVALID");
    if (judgeText !== undefined && parsedJudge === undefined) throw new Error("JUDGE_RESULT_INVALID");
    const score = typeof input["score"] === "number" ? numberInput(input, "score") : parsedJudge?.score;
    const verdict = explicitVerdict ?? parsedJudge?.verdict;
    if (score === undefined || score < 0 || score > 1 || verdict === undefined) throw new Error("JUDGE_RESULT_INVALID");
    const redTeamRequired = score < 0.65 || verdict !== "approved";
    const judgment = {
      nodeId,
      judgeAgentId,
      verdict,
      score,
      redTeamRequired,
      status: redTeamRequired ? "needs_revision" : "approved",
    };
    task.judgments.set(nodeId, judgment);
    return data("judgeNodeOutput", judgment);
  }

  async function requestAdversarialReview(input: Record<string, unknown>): Promise<QueenGraphqlResponse> {
    const task = taskFor(input);
    assertRunStarted(task);
    const nodeId = stringInput(input, "nodeId");
    const redTeamAgentId = stringInput(input, "redTeamAgentId");
    assertSelectableAgent(redTeamAgentId);
    const reviewedAgentIds = [
      task.queenAgentId,
      ...[...task.outputs.values()].map((output) => output.executorAgentId),
      ...[...task.judgments.values()].map((judgment) => judgment.judgeAgentId),
    ];
    if (!isIndependentAgent(redTeamAgentId, reviewedAgentIds)) {
      return graphqlError("RED_TEAM_NOT_INDEPENDENT", "Red Team must be independent from Queen, executors, and judges");
    }
    const redTeamNode = task.graph.nodes.find((node) => node.type === "red_team" && node.metadata?.systemAppended !== true);
    if (redTeamNode !== undefined) assertAcceptedAssignment(task, redTeamNode.nodeId, redTeamAgentId);
    const attempt = optionalNumberInput(input, "attempt") ?? 1;
    const resultKey = JSON.stringify(["red_team", nodeId, attempt]);
    const previous = task.operationResults.get(resultKey);
    if (previous) {
      if (previous.agentId !== redTeamAgentId) throw new Error("QUEEN_OPERATION_AGENT_CONFLICT");
      return data("requestAdversarialReview", structuredClone(previous.result));
    }
    const findings = optionalStringInput(input, "findings") ?? await executeAgentText({
      taskId: task.taskId,
      nodeId,
      agentId: redTeamAgentId,
      role: "red_team",
      operationKey: operationKeyFor(task, input, "red_team", nodeId, attempt),
      messages: [{ role: "user", content: buildRedTeamPrompt(task, nodeId) }],
    });
    const appended = appendSystemNode(task, "red_team", nodeId, redTeamAgentId, attempt);
    const result = {
      taskId: task.taskId,
      nodeId,
      reviewNodeId: appended.nodeId,
      graphRevision: appended.graphRevision,
      redTeamAgentId,
      findings,
      status: "adversarial_reviewing",
    };
    task.operationResults.set(resultKey, { agentId: redTeamAgentId, result });
    return data("requestAdversarialReview", result);
  }

  async function repairNode(input: Record<string, unknown>) {
    const task = taskFor(input);
    assertRunStarted(task);
    const parentNodeId = stringInput(input, "parentNodeId");
    const repairAgentId = optionalStringInput(input, "repairAgentId") ?? optionalStringInput(input, "agentId") ?? task.outputs.get(parentNodeId)?.executorAgentId;
    if (repairAgentId === undefined) throw new Error("Repair agent is required");
    assertSelectableAgent(repairAgentId);
    const attempt = optionalNumberInput(input, "attempt") ?? 1;
    const resultKey = JSON.stringify(["repair", parentNodeId, attempt]);
    const previous = task.operationResults.get(resultKey);
    if (previous) {
      if (previous.agentId !== repairAgentId) throw new Error("QUEEN_OPERATION_AGENT_CONFLICT");
      return structuredClone(previous.result);
    }
    const output = optionalStringInput(input, "output") ?? await executeAgentText({
      taskId: task.taskId,
      nodeId: parentNodeId,
      agentId: repairAgentId,
      role: "repair",
      operationKey: operationKeyFor(task, input, "repair", parentNodeId, attempt),
      messages: [{ role: "user", content: buildRepairPrompt(task, parentNodeId) }],
    });
    const appended = appendSystemNode(task, "repair", parentNodeId, repairAgentId, attempt);
    const result = { taskId: task.taskId, parentNodeId, repairNodeId: appended.nodeId, graphRevision: appended.graphRevision, output, status: "planned" };
    task.operationResults.set(resultKey, { agentId: repairAgentId, result });
    task.outputs.set(parentNodeId, {
      executorAgentId: repairAgentId,
      output,
      outputId: crypto.randomUUID(),
    });
    task.judgments.delete(parentNodeId);
    return result;
  }

  async function finalArbitrate(input: Record<string, unknown>): Promise<QueenGraphqlResponse> {
    const task = taskFor(input);
    assertRunStarted(task);
    const finalArbiterAgentId = stringInput(input, "finalArbiterAgentId");
    assertSelectableAgent(finalArbiterAgentId);
    const reviewedAgentIds = [
      task.queenAgentId,
      ...[...task.outputs.values()].map((output) => output.executorAgentId),
      ...[...task.judgments.values()].map((judgment) => judgment.judgeAgentId),
      ...task.graph.nodes
        .filter((node) => node.type === "red_team")
        .flatMap((node) => task.assignments.get(node.nodeId)?.selectedAgentId ?? []),
    ];
    if (!isIndependentAgent(finalArbiterAgentId, reviewedAgentIds)) {
      return graphqlError("FINAL_ARBITER_NOT_INDEPENDENT", "Final Arbiter must be independent from Queen, executors, and judges");
    }
    const finalNode = task.graph.nodes.find((node) => node.type === "synthesize");
    if (finalNode !== undefined) assertAcceptedAssignment(task, finalNode.nodeId, finalArbiterAgentId);
    if (task.finalArbitration !== undefined) {
      if (task.finalArbitration.finalArbiterAgentId !== finalArbiterAgentId) return graphqlError("FINAL_ARBITER_NOT_INDEPENDENT", "Final Arbiter cannot change after arbitration");
      return data("finalArbitrate", task.finalArbitration);
    }
    const explicitVerdict = optionalStringInput(input, "verdict");
    if (explicitVerdict !== undefined && !isReviewVerdict(explicitVerdict)) {
      return graphqlError("FINAL_ARBITER_RESULT_INVALID", "Final Arbiter verdict is invalid");
    }
    const suppliedOutput = optionalStringInput(input, "finalOutput");
    const modelOutput = suppliedOutput ?? await executeAgentText({
      taskId: task.taskId,
      agentId: finalArbiterAgentId,
      role: "final_arbiter",
      operationKey: operationKeyFor(task, input, "final_arbiter"),
      messages: [{ role: "user", content: buildFinalArbiterPrompt(task) }],
    });
    const parsedVerdict = parseVerdict(modelOutput);
    const verdict = explicitVerdict ?? parsedVerdict;
    if (verdict === undefined) {
      return graphqlError("FINAL_ARBITER_RESULT_INVALID", "Final Arbiter must return an explicit verdict");
    }
    const arbitration = {
      taskId: task.taskId,
      finalArbiterAgentId,
      verdict,
      finalOutput: modelOutput,
    };
    task.finalArbitration = arbitration;
    return data("finalArbitrate", arbitration);
  }

  function writeLearningLoop(input: Record<string, unknown>) {
    const task = taskFor(input);
    assertRunStarted(task);
    const memoryRecordId = crypto.randomUUID();
    const summary = redactSensitiveText(stringInput(input, "summary"));
    task.learningRecords.push({ memoryRecordId, summary });
    return { memoryRecordId, status: "written", summary };
  }

  function taskFor(input: Record<string, unknown>): QueenTaskRecord {
    const taskId = stringInput(input, "taskId");
    const task = taskRecordsFor(input).get(taskId);
    if (task === undefined) throw new Error(`Task ${taskId} does not exist`);
    return task;
  }

  function taskRecordsFor(input: Record<string, unknown>): Map<string, QueenTaskRecord> {
    return operationTasks.get(input) ?? tasks;
  }

  async function hydrateTask(input: Record<string, unknown>): Promise<void> {
    const taskId = optionalStringInput(input, "taskId");
    if (taskId === undefined || tasks.has(taskId) || options.workflowStore === undefined) return;
    const snapshot = await options.workflowStore.load(taskId);
    if (snapshot === null) return;
    tasks.set(taskId, {
      taskId: snapshot.taskId,
      recordVersion: snapshot.recordVersion,
      operationResults: new Map(snapshot.operationResults ?? []),
      requirement: snapshot.requirement,
      queenAgentId: snapshot.queenAgentId,
      graph: TaskGraphSchema.parse(snapshot.graph),
      assignments: new Map(snapshot.assignments),
      outputs: new Map(snapshot.outputs),
      judgments: new Map(snapshot.judgments),
      finalArbitration: snapshot.finalArbitration ?? undefined,
      learningRecords: snapshot.learningRecords,
      systemNodeIds: new Map(snapshot.systemNodeIds),
      graphConfirmedRevision: snapshot.graphConfirmedRevision ?? undefined,
      runId: snapshot.runId ?? undefined,
    });
  }

  async function persistTask(input: Record<string, unknown>, response: QueenGraphqlResponse): Promise<void> {
    if (options.workflowStore === undefined) return;
    const taskId = optionalStringInput(input, "taskId") ?? findResponseTaskId(response);
    if (taskId === undefined) return;
    const task = taskRecordsFor(input).get(taskId);
    if (task === undefined) return;
    const expectedRecordVersion = task.recordVersion;
    const snapshot: QueenWorkflowSnapshot = {
      taskId: task.taskId,
      recordVersion: expectedRecordVersion + 1,
      operationResults: [...task.operationResults.entries()],
      requirement: task.requirement,
      queenAgentId: task.queenAgentId,
      graph: task.graph,
      assignments: [...task.assignments.entries()],
      outputs: [...task.outputs.entries()],
      judgments: [...task.judgments.entries()],
      finalArbitration: task.finalArbitration ?? null,
      learningRecords: task.learningRecords,
      systemNodeIds: [...task.systemNodeIds.entries()],
      graphConfirmedRevision: task.graphConfirmedRevision ?? null,
      runId: task.runId ?? null,
      updatedAt: now().toISOString(),
    };
    await options.workflowStore.save(snapshot, expectedRecordVersion);
    task.recordVersion = snapshot.recordVersion;
  }

  function missingRequiredAssignments(task: QueenTaskRecord): string[] {
    return task.graph.nodes
      .filter((node) => node.required)
      .filter((node) => task.assignments.get(node.nodeId)?.status !== "accepted")
      .map((node) => node.nodeId);
  }

  function assertTaskMutable(task: QueenTaskRecord): void {
    if (task.graphConfirmedRevision !== undefined) {
      throw new Error(`Task ${task.taskId} graph and assignments are locked after confirmation`);
    }
    if (task.runId !== undefined) {
      throw new Error(`Task ${task.taskId} graph and assignments are locked after run start`);
    }
  }

  function assertRunStarted(task: QueenTaskRecord): void {
    if (task.runId === undefined) throw new Error(`Task ${task.taskId} must be started before node execution`);
  }

  function assertAcceptedAssignment(task: QueenTaskRecord, nodeId: string, agentId: string): void {
    const assignment = task.assignments.get(nodeId);
    if (assignment?.status !== "accepted" || assignment.selectedAgentId !== agentId) {
      throw new Error(`Agent ${agentId} is not the accepted assignment for node ${nodeId}`);
    }
  }

  function isIndependentAgent(agentId: string, blockedAgentIds: string[]): boolean {
    const candidate = options.agents.find((agent) => agent.agentId === agentId);
    if (candidate === undefined) return false;
    const blockedModelTags = new Set(blockedAgentIds.flatMap((blockedId) => {
      const blocked = options.agents.find((agent) => agent.agentId === blockedId);
      return blocked === undefined ? [] : [canonicalModelIdentity(blocked.modelTag)];
    }));
    return !blockedAgentIds.includes(agentId)
      && !blockedModelTags.has(canonicalModelIdentity(candidate.modelTag));
  }

  function operationKeyFor(
    task: QueenTaskRecord,
    input: Record<string, unknown>,
    role: QueenAgentExecutionRole,
    nodeId = "task",
    attempt = 1,
  ): string {
    const supplied = optionalStringInput(input, "operationKey");
    if (supplied !== undefined) {
      if (supplied.length > 192 || !/^[A-Za-z0-9:._-]+$/u.test(supplied)) throw new Error("QUEEN_OPERATION_KEY_INVALID");
      return supplied;
    }
    return `sha256:${createHash("sha256").update(JSON.stringify([
      "queen-node-operation.v1", task.taskId, task.graph.graphRevision, role, nodeId, attempt,
    ])).digest("hex")}`;
  }

  function appendSystemNode(
    task: QueenTaskRecord,
    type: "red_team" | "repair",
    parentNodeId: string,
    agentId: string,
    attempt: number,
  ): { nodeId: string; graphRevision: number } {
    nodeFor(task, parentNodeId);
    const normalizedAttempt = Math.max(1, Math.trunc(attempt));
    const idempotencyKey = `${type}:${parentNodeId}:${normalizedAttempt}`;
    const existingNodeId = task.systemNodeIds.get(idempotencyKey);
    if (existingNodeId !== undefined) return { nodeId: existingNodeId, graphRevision: task.graph.graphRevision };

    const nodeId = `${type}-${parentNodeId}-${normalizedAttempt}`;
    const node: TaskNode = {
      nodeId,
      type,
      title: type === "red_team" ? `Adversarial review for ${parentNodeId}` : `Repair ${parentNodeId}`,
      dependencies: [parentNodeId],
      required: true,
      ...(type === "repair" ? { repairsNodeId: parentNodeId } : {}),
      assignedAgentId: agentId,
      contract: contractFor(type),
      metadata: { systemAppended: true, attempt: normalizedAttempt },
    };
    task.graph = TaskGraphSchema.parse({
      ...task.graph,
      graphRevision: task.graph.graphRevision + 1,
      nodes: [...task.graph.nodes, node],
      edges: [...task.graph.edges, { from: parentNodeId, to: nodeId, condition: "needs_revision" }],
    });
    task.assignments.set(nodeId, {
      nodeId,
      selectedAgentId: agentId,
      status: "accepted",
      selectedBy: "queen",
      acceptedAt: now().toISOString(),
      override: false,
      riskCodes: [],
    });
    task.systemNodeIds.set(idempotencyKey, nodeId);
    return { nodeId, graphRevision: task.graph.graphRevision };
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

function findResponseTaskId(response: QueenGraphqlResponse): string | undefined {
  if (response.data === null) return undefined;
  for (const value of Object.values(response.data)) {
    if (typeof value === "object" && value !== null && typeof (value as { taskId?: unknown }).taskId === "string") {
      return (value as { taskId: string }).taskId;
    }
  }
  return undefined;
}

function graphqlError(code: string, message: string): QueenGraphqlResponse {
  return {
    data: null,
    errors: [{ message, extensions: { code, retryable: false } }],
  };
}

function inferOperationName(query: string): QueenMutationName | undefined {
  const match = query.match(/\b(ProposeTaskGraph|AmendTaskGraph|RankNodeAgents|SelectNodeAgent|AcceptNodeAssignment|ConfirmTaskGraph|StartTaskRun|SubmitNodeOutput|JudgeNodeOutput|RequestAdversarialReview|RepairNode|FinalArbitrate|WriteLearningLoop)\b/);
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

function contractFor(type: TaskNode["type"]): TaskNode["contract"] {
  const failureRoute = type === "execute"
    ? "repair"
    : type === "judge"
      ? "red_team"
      : type === "red_team"
        ? "repair"
        : type === "repair"
          ? "manual_review"
          : "stop";
  return {
    schemaVersion: "1",
    contextInputs: type === "plan" ? ["requirement"] : ["requirement", "dependency_outputs"],
    outputKeys: type === "judge" ? ["verdict", "score"] : ["result"],
    artifactMediaTypes: type === "deliver" ? ["application/json"] : [],
    milestone: `Complete ${type} node`,
    acceptanceCriteria: ["Output satisfies the declared schema", "No deterministic Gate is bypassed"],
    budgetAtomic: "0",
    permissions: type === "judge"
      ? ["read_context", "write_artifact", "request_review"]
      : ["read_context", "write_artifact"],
    timeoutSeconds: 300,
    failureRoute,
  };
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

function optionalNumberInput(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

function isReviewVerdict(value: string): value is "approved" | "needs_revision" | "rejected" {
  return value === "approved" || value === "needs_revision" || value === "rejected";
}

function parseVerdict(value: string): "approved" | "needs_revision" | "rejected" | undefined {
  const verdictMatch = value.match(/\b(approved|needs_revision|rejected)\b/i);
  const verdict = verdictMatch?.[1]?.toLowerCase();
  return verdict !== undefined && isReviewVerdict(verdict) ? verdict : undefined;
}

function parseJudgeText(value: string): { verdict: "approved" | "needs_revision" | "rejected"; score: number } | undefined {
  const verdict = parseVerdict(value);
  const scoreMatch = value.match(/score:\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (verdict === undefined || scoreMatch?.[1] === undefined) return undefined;
  const score = Number(scoreMatch[1]);
  return Number.isFinite(score) && score >= 0 && score <= 1 ? { verdict, score } : undefined;
}

function safeMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message.slice(0, 240) : "Queen orchestrator failed";
}
