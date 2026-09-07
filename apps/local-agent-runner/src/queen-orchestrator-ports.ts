import type {
  AgentCandidate,
  QueenMutationName,
} from "@agent-market/shared-contracts";
import {
  createQueenOrchestrator,
  type QueenAgentExecutionRequest,
  type QueenGraphqlResponse,
} from "./queen-orchestrator";
import type { QueenTaskGraphPorts, QueenTaskState } from "./queen-task-graph";
import type { QueenWorkflowStore } from "./queen-workflow-store";

type Options = {
  agents: AgentCandidate[];
  queenAgentId: string;
  workflowStore: QueenWorkflowStore;
  executeAgentText(request: QueenAgentExecutionRequest): Promise<string>;
  allowOwnerOnlyAgents?: boolean;
};

export function createQueenOrchestratorPorts(options: Options): QueenTaskGraphPorts {
  const orchestrator = createQueenOrchestrator(options);
  const mutate = async (operationName: QueenMutationName, input: Record<string, unknown>) => {
    const field = operationName[0]!.toLowerCase() + operationName.slice(1);
    const response: QueenGraphqlResponse = await orchestrator.handleGraphql({
      operationName,
      query: `mutation ${operationName} { ${field} }`,
      variables: { input },
    });
    if (response.errors?.length || response.data === null) {
      const error = response.errors?.[0];
      const code = error?.extensions.code ?? "QUEEN_OPERATION_FAILED";
      throw new Error(`${operationName}:${code}:${error?.message ?? "unknown error"}`);
    }
    return response.data[field] as Record<string, unknown>;
  };
  const snapshot = async (state: QueenTaskState) => {
    const value = await options.workflowStore.load(state.taskId);
    if (!value || value.taskId !== state.taskId
        || value.graph.graphRevision < state.graphRevision) {
      throw new Error("QUEEN_WORKFLOW_SNAPSHOT_INVALID");
    }
    return value;
  };
  const identities = async (state: QueenTaskState) => {
    const value = await snapshot(state);
    const result: Record<string, string> = {};
    for (const [nodeId, assignment] of value.assignments) {
      const node = value.graph.nodes.find(item => item.nodeId === nodeId);
      if (node?.type === "execute") result.executor = assignment.selectedAgentId;
      if (node?.type === "judge") result.judge = assignment.selectedAgentId;
      if (node?.type === "red_team") result.redTeam = assignment.selectedAgentId;
      if (node?.type === "synthesize") result.final = assignment.selectedAgentId;
    }
    return result;
  };
  return {
    async authorize(state, action) {
      const value = await snapshot(state);
      if (action === "execute") {
        if (value.graphConfirmedRevision !== null && value.graphConfirmedRevision !== state.graphRevision) {
          throw new Error("QUEEN_GRAPH_VERSION_MISMATCH");
        }
        return;
      }
      if (action !== "plan" && action !== "approve"
          && (value.graphConfirmedRevision !== state.graphRevision || !value.runId)) {
        throw new Error("QUEEN_RUN_NOT_AUTHORIZED");
      }
    },
    async plan() { throw new Error("QUEEN_PLANNING_MUST_USE_PLANNING_EVENT"); },
    async execute(state, operationKey) {
      let value = await snapshot(state);
      if (value.graphConfirmedRevision === null) {
        const assignments = new Map(value.assignments);
        const missingNodeIds = value.graph.nodes.filter(node => node.required
          && assignments.get(node.nodeId)?.status !== "accepted").map(node => node.nodeId);
        if (missingNodeIds.length > 0) {
          throw new Error(`QUEEN_PREAPPROVED_ASSIGNMENTS_REQUIRED:${missingNodeIds.join(",")}`);
        }
        await mutate("ConfirmTaskGraph", { taskId: state.taskId });
        value = await snapshot(state);
      }
      if (!value.runId) {
        const start = await mutate("StartTaskRun", {
          taskId: state.taskId,
          manualApproval: true,
        });
        if (start.status !== "running" || typeof start.runId !== "string") {
          throw new Error(`QUEEN_RUN_START_BLOCKED:${String(start.reasonCode ?? "UNKNOWN")}`);
        }
      }
      const ids = await identities(state);
      const output = await mutate("SubmitNodeOutput", {
        taskId: state.taskId, nodeId: "execute-1", executorAgentId: ids.executor, operationKey,
      });
      if (typeof output.outputId !== "string") throw new Error("QUEEN_OUTPUT_NOT_DURABLE");
      return `queen-output:${state.taskId}:execute-1`;
    },
    async judge(state, operationKey) {
      const ids = await identities(state);
      const result = await mutate("JudgeNodeOutput", {
        taskId: state.taskId, nodeId: "execute-1", judgeAgentId: ids.judge, operationKey,
      });
      return result.verdict === "approved" ? "approved"
        : result.verdict === "rejected" ? "rejected" : "needs_revision";
    },
    async redTeam(state, operationKey) {
      const ids = await identities(state);
      const result = await mutate("RequestAdversarialReview", {
        taskId: state.taskId, nodeId: "execute-1", redTeamAgentId: ids.redTeam,
        attempt: state.repairCount + 1, operationKey,
      });
      const findings = String(result.findings ?? "");
      if (/\bverdict\s*:\s*approved\b/iu.test(findings)) return "approved";
      if (/\bverdict\s*:\s*rejected\b/iu.test(findings)) return "rejected";
      return "needs_revision";
    },
    async repair(state, operationKey) {
      if (state.decision !== "needs_revision" && state.redTeamDecision !== "needs_revision") {
        throw new Error("QUEEN_REPAIR_NOT_AUTHORIZED");
      }
      const ids = await identities(state);
      const result = await mutate("RepairNode", {
        taskId: state.taskId, parentNodeId: "execute-1",
        repairAgentId: ids.executor, attempt: state.repairCount + 1, operationKey,
      });
      if (typeof result.output !== "string") throw new Error("QUEEN_REPAIR_OUTPUT_MISSING");
      return `queen-output:${state.taskId}:execute-1:repair:${state.repairCount + 1}`;
    },
    async finalize(state, operationKey) {
      if (state.decision !== "approved" || (state.riskLevel === "high" && state.redTeamDecision !== "approved")) {
        throw new Error("QUEEN_FINAL_GATE_FAILED");
      }
      const ids = await identities(state);
      const result = await mutate("FinalArbitrate", {
        taskId: state.taskId, finalArbiterAgentId: ids.final, operationKey,
      });
      if (result.verdict !== "approved" || typeof result.finalOutput !== "string") {
        throw new Error("QUEEN_FINAL_ARBITRATION_FAILED");
      }
      return `queen-final:${state.taskId}`;
    },
  };
}
