import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  AgentCandidateSchema,
  NodeAssignmentSchema,
  canonicalQueenPlanningApprovalBinding,
  type AgentCandidate,
} from "@agent-market/shared-contracts";
import type { Sql } from "postgres";
import { createQueenOrchestrator } from "./queen-orchestrator";
import { createQueenPlanningAuthorization } from "./queen-planning-authorization";
import { createQueenTaskGraph, QueenTaskStateSchema, queenTaskThreadId } from "./queen-task-graph";
import { PostgresQueenWorkflowStore } from "./queen-workflow-store";
import type { QueenWorkflowEvent } from "./queen-workflow-event";

const nodePriority: Record<string, number> = {
  plan: 0, execute: 1, judge: 2, red_team: 3, synthesize: 4, deliver: 5,
};

const assignmentRole = (nodeType: string) => nodeType === "deliver" ? "executor"
  : nodeType === "execute" ? "executor"
    : nodeType === "synthesize" ? "final"
      : nodeType;

const independentRoles = new Set(["executor", "judge", "red_team", "final"]);
const canonicalModelIdentity = (modelTag: string) => modelTag.trim().toLowerCase();

export function createQueenDurablePlanning(options: {
  sql: Sql; authorizationSql: Sql; checkpointer: PostgresSaver; queenAgentId: string;
  agents: AgentCandidate[];
}) {
  const agents = AgentCandidateSchema.array().min(1).parse(options.agents);
  const store = new PostgresQueenWorkflowStore(options.sql, "queen_runtime_public");
  const authorize = createQueenPlanningAuthorization(options.authorizationSql);
  const forbidden = async (): Promise<never> => { throw new Error("QUEEN_PLAN_ONLY_GRANT"); };
  return async (event: QueenWorkflowEvent): Promise<void> => {
    const payload = await authorize(event);
    const requirement = JSON.stringify(payload);
    const state = QueenTaskStateSchema.parse({
      scopeId: event.scopeId, taskId: event.taskId, graphRevision: event.graphRevision,
      taskFingerprint: event.taskFingerprint,
    });
    const config = { configurable: { thread_id: queenTaskThreadId(state) } };
    const loadPlan = async () => {
      const snapshot = await store.load(event.taskId);
      if (snapshot && (snapshot.requirement !== requirement || snapshot.queenAgentId !== options.queenAgentId
          || snapshot.graph.graphRevision !== event.graphRevision || snapshot.runId !== null
          || snapshot.graphConfirmedRevision !== null)) {
        throw new Error("QUEEN_PLANNING_SNAPSHOT_CONFLICT");
      }
      return snapshot;
    };
    const graph = createQueenTaskGraph({
      authorize: async (_state, action) => {
        if (action !== "plan") return forbidden();
        await authorize(event);
      },
      plan: async () => {
        let snapshot = await loadPlan();
        const queen = createQueenOrchestrator({ agents, queenAgentId: options.queenAgentId, workflowStore: store });
        if (!snapshot) {
          // Fresh orchestrator per request: never share cached task state across wallets.
          const result = await queen.handleGraphql({
            operationName: "ProposeTaskGraph", query: "mutation ProposeTaskGraph { proposeTaskGraph }",
            variables: { input: { taskId: event.taskId, requirement } },
          });
          if (result.errors?.length || !result.data?.proposeTaskGraph) throw new Error("QUEEN_PLANNING_FAILED");
          snapshot = await loadPlan();
        }
        if (!snapshot) throw new Error("QUEEN_PLANNING_NOT_DURABLE");
        const selectedByRole = new Map<string, AgentCandidate>();
        const claimRole = (role: string, candidate: AgentCandidate) => {
          const existing = selectedByRole.get(role);
          if (existing && existing.agentId !== candidate.agentId) {
            throw new Error("QUEEN_PLANNING_ROLE_ASSIGNMENT_CONFLICT");
          }
          if (!existing && independentRoles.has(role)) {
            for (const [otherRole, other] of selectedByRole) {
              if ((independentRoles.has(otherRole) || otherRole === "plan")
                  && (other.agentId === candidate.agentId
                    || canonicalModelIdentity(other.modelTag) === canonicalModelIdentity(candidate.modelTag))) {
                throw new Error("QUEEN_PLANNING_ROLE_INDEPENDENCE_REQUIRED");
              }
            }
          }
          selectedByRole.set(role, candidate);
        };
        for (const node of [...snapshot.graph.nodes].filter((item) => item.required)
          .sort((left, right) => (nodePriority[left.type] ?? 99) - (nodePriority[right.type] ?? 99)
            || left.nodeId.localeCompare(right.nodeId))) {
          const role = assignmentRole(node.type);
          const current = snapshot.assignments.find(([nodeId]) => nodeId === node.nodeId)?.[1];
          const parsed = current === undefined ? undefined : NodeAssignmentSchema.safeParse(current);
          if (parsed && !parsed.success) throw new Error("QUEEN_PLANNING_ASSIGNMENT_INVALID");
          if (parsed?.data.status === "accepted") {
            const acceptedAgent = agents.find(agent => agent.agentId === parsed.data.selectedAgentId);
            if (!acceptedAgent) throw new Error("QUEEN_PLANNING_ASSIGNMENT_AGENT_INVALID");
            claimRole(role, acceptedAgent);
            continue;
          }
          if (parsed?.data.status !== undefined && parsed.data.status !== "selected") {
            throw new Error("QUEEN_PLANNING_ASSIGNMENT_STATE_INVALID");
          }
          let selected = role === "plan"
            ? agents.find(agent => agent.agentId === options.queenAgentId && agent.capabilities.includes("plan"))
            : selectedByRole.get(role);
          if (selected === undefined) {
            const blocked = [...selectedByRole.entries()]
              .filter(([otherRole]) => independentRoles.has(otherRole) || otherRole === "plan")
              .map(([, candidate]) => candidate);
            const ranked = await queen.handleGraphql({
              operationName: "RankNodeAgents", query: "mutation RankNodeAgents { rankNodeAgents }",
              variables: { input: {
                taskId: event.taskId,
                nodeId: node.nodeId,
                excludedAgentIds: blocked.map(candidate => candidate.agentId),
                excludedModelTags: blocked.map(candidate => canonicalModelIdentity(candidate.modelTag)),
              } },
            });
            const rankedCandidates: unknown = ranked.data?.rankNodeAgents?.candidates;
            if (ranked.errors?.length || !Array.isArray(rankedCandidates)) {
              throw new Error("QUEEN_REQUIRED_NODE_AGENT_UNAVAILABLE");
            }
            const candidates = rankedCandidates.map((candidate) => {
              const agentId = candidate && typeof candidate === "object"
                ? (candidate as Record<string, unknown>).agentId : undefined;
              return typeof agentId === "string" ? agents.find(agent => agent.agentId === agentId) : undefined;
            });
            if (candidates.some(candidate => candidate === undefined)) {
              throw new Error("QUEEN_REQUIRED_NODE_AGENT_UNAVAILABLE");
            }
            selected = candidates.find((candidate): candidate is AgentCandidate => candidate !== undefined
              && (!independentRoles.has(role)
              || [...selectedByRole.entries()].every(([otherRole, other]) =>
                (!independentRoles.has(otherRole) && otherRole !== "plan")
                || (other.agentId !== candidate.agentId
                  && canonicalModelIdentity(other.modelTag) !== canonicalModelIdentity(candidate.modelTag)))));
          }
          if (!selected) throw new Error("QUEEN_REQUIRED_INDEPENDENT_AGENT_UNAVAILABLE");
          claimRole(role, selected);
          const accepted = await queen.handleGraphql({
            operationName: "AcceptNodeAssignment", query: "mutation AcceptNodeAssignment { acceptNodeAssignment }",
            variables: { input: { taskId: event.taskId, nodeId: node.nodeId, agentId: selected.agentId } },
          });
          if (accepted.errors?.length || accepted.data?.acceptNodeAssignment?.status !== "accepted") {
            throw new Error("QUEEN_REQUIRED_NODE_ASSIGNMENT_FAILED");
          }
          snapshot = await loadPlan();
          if (!snapshot) throw new Error("QUEEN_PLANNING_NOT_DURABLE");
        }
        canonicalQueenPlanningApprovalBinding({
          graph: snapshot.graph,
          assignments: snapshot.assignments,
          approvedRevision: event.graphRevision,
          allowSystemAppended: false,
        });
        return `queen-plan:${event.taskId}:${snapshot.recordVersion}`;
      },
      execute: forbidden, judge: forbidden, redTeam: forbidden, repair: forbidden, finalize: forbidden,
    }, options.checkpointer);
    const existing = await graph.getState(config);
    if (existing.next.length === 0 && !existing.values?.taskId) {
      await graph.invoke(state, config);
    } else if (!existing.next.includes("approval")) {
      // Interrupted writes or a later business phase require explicit reconciliation.
      throw new Error("QUEEN_PLANNING_CHECKPOINT_RECONCILIATION_REQUIRED");
    }
    const saved = await graph.getState(config);
    const snapshot = await loadPlan();
    if (!snapshot || saved.next.length !== 1 || saved.next[0] !== "approval"
        || saved.values.status !== "awaiting_approval"
        || saved.values.planRef !== `queen-plan:${event.taskId}:${snapshot.recordVersion}`) {
      throw new Error("QUEEN_PLANNING_CHECKPOINT_NOT_DURABLE");
    }
    await authorize(event);
  };
}
