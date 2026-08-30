import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Badge, PageHeader, Panel } from "../components/Ui";
import { agentProviderLabel, publicAgentCatalog } from "../agentCatalog";
import { Localized } from "../i18n/LanguageProvider";
import { parseGraphqlResponse } from "../lib/graphqlResponse";
import { listOwnerAgents, type OwnerAgentRecord } from "../ownerAgentRegistry";

export { parseGraphqlResponse } from "../lib/graphqlResponse";

type AgentId = string;
type ChatMessage = { role: "user" | "assistant"; content: string };
type GraphqlOrchestrationResult = {
  requestId: string;
  runId: string;
  status: "succeeded";
  leadAgentId: string;
  finalOutput: string;
  steps: Array<{ agentId: string; modelTag: string; provider: string; output: string }>;
};
type HealthAgent = {
  agentId: string;
  displayName: string;
  provider: "ollama" | "deepseek" | "kimi" | "qwen" | "zhipu";
  ownership: string;
  modelTag: string;
  visibility?: string;
  selectableBy?: string;
  status: "online" | "offline" | "degraded";
};
type Health = { status: "online" | "offline" | "degraded"; agents: HealthAgent[]; reasonCode?: string };
type DisplayAgent = {
  id: AgentId;
  name: string;
  provider: string;
  ownership: string;
  model: string;
  visibility: string;
  selectableBy: string;
  note: string;
  verification: string;
};
type QueenTaskNode = {
  nodeId: string;
  type: string;
  title: string;
  dependencies: string[];
  required: boolean;
  judgesNodeId?: string;
  repairsNodeId?: string;
};
type QueenTaskGraphResult = {
  taskId: string;
  graphRevision: number;
  riskLevel: "low" | "medium" | "high";
  startPolicy: "auto" | "manualRequired";
  nodes: QueenTaskNode[];
  edges: Array<{ from: string; to: string; condition?: "always" | "approved" | "needs_revision" | "rejected" }>;
  rescuePolicy: { mode: "auto"; visibleToUser: false; evidenceVisible: true };
};
type QueenRankResult = {
  nodeId: string;
  autoSelectedAgentId?: string;
  candidates: QueenRankCandidate[];
};
type QueenRankCandidate = {
  agentId: string;
  displayName: string;
  modelTag: string;
  costPer1kTokensUsd: number;
  qualityScore: number;
  status: string;
  rankingScore?: number;
};

export function isIndependentQueenCandidate(
  node: QueenTaskNode,
  candidate: QueenRankCandidate,
  graph: QueenTaskGraphResult,
  selectedModelTags: Record<string, string>,
): boolean {
  const modelTag = candidate.modelTag.trim().toLowerCase();
  if (!modelTag) return false;

  const blockedNodeIds = node.type === "judge"
    ? [
      ...(node.judgesNodeId ? [node.judgesNodeId] : []),
      ...graph.nodes.filter((entry) => entry.type === "synthesize").map((entry) => entry.nodeId),
    ]
    : node.type === "synthesize"
      ? graph.nodes.filter((entry) => entry.type === "execute" || entry.type === "judge").map((entry) => entry.nodeId)
      : node.type === "execute"
        ? graph.nodes
          .filter((entry) => (entry.type === "judge" && entry.judgesNodeId === node.nodeId) || entry.type === "synthesize")
          .map((entry) => entry.nodeId)
        : [];
  return blockedNodeIds.every((nodeId) => selectedModelTags[nodeId]?.trim().toLowerCase() !== modelTag);
}
type QueenAssignmentResult = {
  nodeId: string;
  selectedAgentId: string;
  status: string;
};
type QueenWorkflowState = {
  status: "idle" | "proposing" | "ready" | "running" | "succeeded" | "error" | "cancelled";
  graph?: QueenTaskGraphResult;
  activeNodeId?: string;
  log: string[];
};

const MAX_ORCHESTRATION_AGENTS = 3;
const WORKFLOW_OPERATION_TIMEOUT_MS = 75_000;
const CANONICAL_QUEEN_FLOW = [
  { id: "requirement", label: "Requirement", type: "input" },
  { id: "queen-plan", label: "Queen plan", type: "plan" },
  { id: "agent-match", label: "Agent match", type: "match" },
  { id: "execute", label: "Execution", type: "execute" },
  { id: "judge", label: "Judge", type: "judge" },
  { id: "final-arbiter", label: "Final arbiter", type: "synthesize" },
  { id: "evidence", label: "Evidence", type: "deliver" },
] as const;
const ORCHESTRATE_AGENTS_MUTATION = `
mutation OrchestrateAgents($input: AgentOrchestrationInput!) {
  orchestrateAgents(input: $input) {
    requestId
    runId
    status
    leadAgentId
    finalOutput
    steps { agentId modelTag provider output }
  }
}
`;
const PROPOSE_TASK_GRAPH_MUTATION = `
mutation ProposeTaskGraph($input: ProposeTaskGraphInput!) {
  proposeTaskGraph(input: $input) {
    taskId
    graphRevision
    riskLevel
    startPolicy
    rescuePolicy { mode visibleToUser evidenceVisible }
    nodes { nodeId type title dependencies required }
    edges { from to condition }
  }
}
`;
const AMEND_TASK_GRAPH_MUTATION = `
mutation AmendTaskGraph($input: AmendTaskGraphInput!) {
  amendTaskGraph(input: $input) {
    taskId
    graphRevision
    riskLevel
    startPolicy
    confirmationStatus
    preservedAssignmentNodeIds
    rescuePolicy { mode visibleToUser evidenceVisible }
    nodes { nodeId type title dependencies required judgesNodeId repairsNodeId }
    edges { from to condition }
  }
}
`;
const RANK_NODE_AGENTS_MUTATION = `
mutation RankNodeAgents($input: RankNodeAgentsInput!) {
  rankNodeAgents(input: $input) {
    nodeId
    autoSelectedAgentId
    rankingPolicy
    candidates { agentId displayName modelTag costPer1kTokensUsd qualityScore status rankingScore }
  }
}
`;
const ACCEPT_NODE_ASSIGNMENT_MUTATION = `
mutation AcceptNodeAssignment($input: AcceptNodeAssignmentInput!) {
  acceptNodeAssignment(input: $input) {
    nodeId
    selectedAgentId
    status
  }
}
`;
const SELECT_NODE_AGENT_MUTATION = `
mutation SelectNodeAgent($input: SelectNodeAgentInput!) {
  selectNodeAgent(input: $input) {
    nodeId
    selectedAgentId
    status
  }
}
`;
const CONFIRM_TASK_GRAPH_MUTATION = `
mutation ConfirmTaskGraph($input: ConfirmTaskGraphInput!) {
  confirmTaskGraph(input: $input) {
    taskId
    graphRevision
    confirmationStatus
  }
}
`;
const START_TASK_RUN_MUTATION = `
mutation StartTaskRun($input: StartTaskRunInput!) {
  startTaskRun(input: $input) {
    taskId
    runId
    status
    reasonCode
  }
}
`;
const SUBMIT_NODE_OUTPUT_MUTATION = `
mutation SubmitNodeOutput($input: SubmitNodeOutputInput!) {
  submitNodeOutput(input: $input) {
    nodeId
    outputId
    output
    status
  }
}
`;
const JUDGE_NODE_OUTPUT_MUTATION = `
mutation JudgeNodeOutput($input: JudgeNodeOutputInput!) {
  judgeNodeOutput(input: $input) {
    nodeId
    judgeAgentId
    verdict
    score
    redTeamRequired
    status
  }
}
`;
const REQUEST_ADVERSARIAL_REVIEW_MUTATION = `
mutation RequestAdversarialReview($input: RequestAdversarialReviewInput!) {
  requestAdversarialReview(input: $input) {
    nodeId
    redTeamAgentId
    findings
    status
  }
}
`;
const REPAIR_NODE_MUTATION = `
mutation RepairNode($input: RepairNodeInput!) {
  repairNode(input: $input) {
    parentNodeId
    repairNodeId
    output
    status
  }
}
`;
const FINAL_ARBITRATE_MUTATION = `
mutation FinalArbitrate($input: FinalArbitrateInput!) {
  finalArbitrate(input: $input) {
    taskId
    finalArbiterAgentId
    verdict
    finalOutput
  }
}
`;
const WRITE_LEARNING_LOOP_MUTATION = `
mutation WriteLearningLoop($input: WriteLearningLoopInput!) {
  writeLearningLoop(input: $input) {
    memoryRecordId
    status
    summary
  }
}
`;

const fallbackAgents: DisplayAgent[] = publicAgentCatalog.map((agent) => ({
  id: agent.id,
  name: agent.displayName,
  provider: agent.providerLabel,
  ownership: agent.ownership,
  model: agent.modelTag,
  visibility: agent.visibility,
  selectableBy: agent.selectableBy,
  note: `${agent.note} Verification: ${agent.verification}.`,
  verification: agent.verification,
}));

export function LocalAgentsPage({ initialQueenWorkflow, walletAddress = null }: { initialQueenWorkflow?: QueenWorkflowState; walletAddress?: string | null } = {}) {
  const [selectedId, setSelectedId] = useState<AgentId>("personal-ai-agent-runtime-v4-1");
  const [health, setHealth] = useState<Health>({ status: "offline", agents: [], reasonCode: "RUNTIME_OFFLINE" });
  const [healthRevision, setHealthRevision] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: "Select an agent and send a short prompt. Live answers require the Cloudflare edge gateway and local runtime to be online." },
  ]);
  const [draft, setDraft] = useState("Give a concise status update for Agent Market.");
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [orchestrationIds, setOrchestrationIds] = useState<AgentId[]>([]);
  const [queenWorkflow, setQueenWorkflow] = useState<QueenWorkflowState>(initialQueenWorkflow ?? { status: "idle", log: [] });
  const [queenRanks, setQueenRanks] = useState<Record<string, QueenRankResult>>({});
  const [queenAssignments, setQueenAssignments] = useState<Record<string, QueenAssignmentResult>>({});
  const [queenNodeOutputs, setQueenNodeOutputs] = useState<Record<string, string>>({});
  const [queenBusy, setQueenBusy] = useState<string | null>(null);
  const [queenDraftGraph, setQueenDraftGraph] = useState<QueenTaskGraphResult | null>(null);
  const [ownerAgents, setOwnerAgents] = useState<OwnerAgentRecord[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const displayAgents = useMemo(() => buildDisplayAgents(health.agents, ownerAgents), [health.agents, ownerAgents]);
  const selectedAgent = useMemo(
    () => displayAgents.find((agent) => agent.id === selectedId) ?? displayAgents[0]!,
    [displayAgents, selectedId],
  );
  const healthById = useMemo(() => new Map(health.agents.map((agent) => [agent.agentId, agent])), [health.agents]);
  const orchestrationAgents = useMemo(
    () => orchestrationIds
      .map((id) => displayAgents.find((agent) => agent.id === id))
      .filter((agent): agent is DisplayAgent => agent !== undefined),
    [displayAgents, orchestrationIds],
  );
  const canAddSelected = !busy
    && orchestrationIds.length < MAX_ORCHESTRATION_AGENTS
    && !orchestrationIds.includes(selectedAgent.id)
    && !orchestrationAgents.some((agent) => agent.model.toLowerCase() === selectedAgent.model.toLowerCase());
  const orchestrationModelConflict = hasDuplicateModels(orchestrationAgents);
  const runtimeAvailable = health.status !== "offline";
  const canRunOrchestration = runtimeAvailable && !busy && orchestrationAgents.length >= 2 && !orchestrationModelConflict && draft.trim().length > 0;
  const visibleQueenGraph = queenDraftGraph ?? queenWorkflow.graph;

  useEffect(() => {
    let active = true;
    if (!walletAddress) { setOwnerAgents([]); return () => { active = false; }; }
    void listOwnerAgents(walletAddress).then((records) => { if (active) setOwnerAgents(records); }).catch(() => { if (active) setOwnerAgents([]); });
    return () => { active = false; };
  }, [walletAddress]);

  useEffect(() => {
    let active = true;
    fetch("/agent/healthz", { headers: { accept: "application/json" } })
      .then((response) => response.json() as Promise<Health>)
      .then((payload) => { if (active) setHealth(payload); })
      .catch(() => { if (active) setHealth({ status: "offline", agents: [], reasonCode: "RUNTIME_OFFLINE" }); });
    return () => { active = false; };
  }, [healthRevision]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt || busy || !runtimeAvailable) return;

    const requestId = crypto.randomUUID();
    const userMessage: ChatMessage = { role: "user", content: prompt };
    const assistantIndex = messages.length + 1;
    setMessages((current) => [...current, userMessage, { role: "assistant", content: "" }]);
    setDraft("");
    setBusy(true);
    setLastError(null);

    const abort = new AbortController();
    abortRef.current = abort;
    try {
      await runAgentRequest({
        agentId: selectedAgent.id,
        chatMessages: [...messages.filter((message) => message.content.trim()), userMessage].slice(-8),
        signal: abort.signal,
        onDelta: (delta) => setMessages((current) => current.map((message, index) => (
          index === assistantIndex ? { ...message, content: `${message.content}${delta}` } : message
        ))),
        onError: (message) => {
          setLastError(message);
          setMessages((current) => current.map((item, index) => (
            index === assistantIndex ? { ...item, content: `Runtime error: ${message}` } : item
          )));
        },
      });
    } catch (error) {
      if (!abort.signal.aborted) {
        const message = error instanceof Error ? error.message : "Chat request failed";
        setLastError(message);
        setMessages((current) => current.map((item, index) => (
          index === assistantIndex ? { ...item, content: `Runtime offline: ${message}` } : item
        )));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  async function runOrchestration() {
    const prompt = draft.trim();
    if (!canRunOrchestration) return;

    const abort = new AbortController();
    abortRef.current = abort;
    const lead = orchestrationAgents[0]!;

    setDraft("");
    setBusy(true);
    setLastError(null);
    setMessages((current) => [
      ...current,
      {
        role: "user",
        content: `Run sequential orchestration.\nLead: ${lead.name}\nOrder: ${orchestrationAgents.map((agent, index) => `${index + 1}. ${agent.name}`).join(" -> ")}\n\n${prompt}`,
      },
    ]);

    try {
      setMessages((current) => [...current, { role: "assistant", content: `[GraphQL orchestration / ${lead.name}]\nWaiting for runtime resolver...` }]);
      const result = await runGraphqlOrchestration({
        agentIds: orchestrationAgents.map((agent) => agent.id),
        prompt,
        signal: abort.signal,
      });
      setMessages((current) => replaceLastAssistant(current, () => formatOrchestrationResult(result)));
    } catch (error) {
      if (!abort.signal.aborted) {
        const message = error instanceof Error ? error.message : "Orchestration failed";
        setLastError(message);
        setMessages((current) => [...current, { role: "assistant", content: `Orchestration failed: ${message}` }]);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  async function proposeQueenWorkflow() {
    const requirement = draft.trim() || "Build a verified Agent Market task with Queen-led GraphQL orchestration.";
    const abort = new AbortController();
    abortRef.current = abort;
    setQueenWorkflow({ status: "proposing", log: ["Queen is decomposing the requirement into a task plan..."] });
    setQueenBusy("prepare");
    setLastError(null);
    try {
      const data = await runQueenMutation<{ proposeTaskGraph: QueenTaskGraphResult }>({
        operationName: "ProposeTaskGraph",
        query: PROPOSE_TASK_GRAPH_MUTATION,
        input: {
          requestId: crypto.randomUUID(),
          requirement,
          queenAgentId: "queen-router-v1",
        },
        signal: abort.signal,
      });
      const graph = data.proposeTaskGraph;
      setQueenRanks({});
      setQueenAssignments({});
      setQueenNodeOutputs({});
      setQueenWorkflow({
        status: "ready",
        graph,
        log: [
          `Task plan revision ${graph.graphRevision} is ready.`,
          `Risk: ${graph.riskLevel}; start policy: ${graph.startPolicy}.`,
          `Rescue policy is ${graph.rescuePolicy.evidenceVisible ? "evidence-visible" : "hidden"}.`,
          "Auto-filling recommended agents for every task node...",
        ],
      });
      await prepareQueenAssignments(graph, abort.signal);
      appendQueenLog("Auto-filled recommended agents and accepted assignments.");
    } catch (error) {
      if (!abort.signal.aborted) {
        const message = error instanceof Error ? error.message : "Queen workflow failed";
        setLastError(message);
        setQueenWorkflow({ status: "error", log: [message] });
      }
    } finally {
      setQueenBusy(null);
      abortRef.current = null;
    }
  }

  async function prepareQueenAssignments(graph: QueenTaskGraphResult, signal: AbortSignal) {
    const accepted: Record<string, QueenAssignmentResult> = {};
    const selectedModelTags: Record<string, string> = {};
    for (const node of graph.nodes) {
      const rankData = await runQueenMutation<{ rankNodeAgents: QueenRankResult }>({
        operationName: "RankNodeAgents",
        query: RANK_NODE_AGENTS_MUTATION,
        input: {
          taskId: graph.taskId,
          nodeId: node.nodeId,
          requiredCapabilities: capabilitiesForQueenNode(node),
        },
        signal,
      });
      setQueenRanks((current) => ({ ...current, [node.nodeId]: rankData.rankNodeAgents }));

      const selectedCandidate = rankData.rankNodeAgents.candidates.find((candidate) =>
        isIndependentQueenCandidate(node, candidate, graph, selectedModelTags),
      );
      if (!selectedCandidate) throw new Error(`节点「${node.title}」没有独立且合格的 Agent / No independent eligible agent.`);
      const selectedAgentId = selectedCandidate.agentId;

      const assignmentData = await runQueenMutation<{ acceptNodeAssignment: QueenAssignmentResult }>({
        operationName: "AcceptNodeAssignment",
        query: ACCEPT_NODE_ASSIGNMENT_MUTATION,
        input: { taskId: graph.taskId, nodeId: node.nodeId, agentId: selectedAgentId },
        signal,
      });
      accepted[node.nodeId] = assignmentData.acceptNodeAssignment;
      selectedModelTags[node.nodeId] = selectedCandidate.modelTag;
      setQueenAssignments((current) => ({ ...current, [node.nodeId]: assignmentData.acceptNodeAssignment }));
    }
    return accepted;
  }

  function beginQueenWorkflowEdit() {
    if (!queenWorkflow.graph || queenBusy) return;
    setQueenDraftGraph({
      ...queenWorkflow.graph,
      nodes: queenWorkflow.graph.nodes.map((node) => ({ ...node, dependencies: [...node.dependencies] })),
      edges: queenWorkflow.graph.edges.map((edge) => ({ ...edge })),
    });
  }

  async function saveQueenWorkflowEdit() {
    if (!queenDraftGraph || queenBusy) return;
    if (queenDraftGraph.nodes.some((node) => node.title.trim().length === 0)) {
      setLastError("Every workflow node needs a title before saving.");
      return;
    }
    const abort = new AbortController();
    abortRef.current = abort;
    setQueenBusy("amend");
    setLastError(null);
    try {
      const data = await runQueenMutation<{ amendTaskGraph: QueenTaskGraphResult & { confirmationStatus: string; preservedAssignmentNodeIds: string[] } }>({
        operationName: "AmendTaskGraph",
        query: AMEND_TASK_GRAPH_MUTATION,
        input: {
          taskId: queenDraftGraph.taskId,
          nodes: queenDraftGraph.nodes.map((node) => ({ ...node, title: node.title.trim() })),
          edges: queenDraftGraph.edges,
        },
        signal: abort.signal,
      });
      setQueenWorkflow((current) => ({
        ...current,
        graph: data.amendTaskGraph,
        log: [...current.log, `Workflow revision ${data.amendTaskGraph.graphRevision} saved; confirmation is pending.`].slice(-10),
      }));
      setQueenDraftGraph(null);
    } catch (error) {
      if (!abort.signal.aborted) {
        const message = error instanceof Error ? error.message : "Workflow amendment failed";
        setLastError(message);
        appendQueenLog(`Workflow amendment failed: ${message}`);
      }
    } finally {
      setQueenBusy(null);
      abortRef.current = null;
    }
  }

  async function selectQueenNodeAgent(nodeId: string, selectedAgentId: string) {
    const graph = queenWorkflow.graph;
    if (!graph || queenBusy) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setQueenBusy(`select:${nodeId}`);
    setLastError(null);
    try {
      const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
      const selectedCandidate = queenRanks[nodeId]?.candidates.find((candidate) => candidate.agentId === selectedAgentId);
      const selectedModelTags = Object.fromEntries(
        Object.entries(queenAssignments).flatMap(([assignedNodeId, assignment]) => {
          const modelTag = queenRanks[assignedNodeId]?.candidates.find((candidate) => candidate.agentId === assignment.selectedAgentId)?.modelTag;
          return modelTag ? [[assignedNodeId, modelTag]] : [];
        }),
      );
      if (!node || !selectedCandidate || !isIndependentQueenCandidate(node, selectedCandidate, graph, selectedModelTags)) {
        throw new Error("Judge 与 Final Arbiter 必须使用独立于被审查工作的模型 / independent review models are required.");
      }
      await runQueenMutation<{ selectNodeAgent: QueenAssignmentResult }>({
        operationName: "SelectNodeAgent",
        query: SELECT_NODE_AGENT_MUTATION,
        input: { taskId: graph.taskId, nodeId, selectedAgentId, selectedBy: "user" },
        signal: abort.signal,
      });
      const accepted = await runQueenMutation<{ acceptNodeAssignment: QueenAssignmentResult }>({
        operationName: "AcceptNodeAssignment",
        query: ACCEPT_NODE_ASSIGNMENT_MUTATION,
        input: { taskId: graph.taskId, nodeId, agentId: selectedAgentId },
        signal: abort.signal,
      });
      setQueenAssignments((current) => ({ ...current, [nodeId]: accepted.acceptNodeAssignment }));
      appendQueenLog(`User selected ${selectedAgentId} for ${nodeId}; confirmation is pending.`);
    } catch (error) {
      if (!abort.signal.aborted) {
        const message = error instanceof Error ? error.message : "Agent selection failed";
        setLastError(message);
        appendQueenLog(`Agent selection failed for ${nodeId}: ${message}`);
      }
    } finally {
      setQueenBusy(null);
      abortRef.current = null;
    }
  }

  async function runQueenNodeAction(node: QueenTaskNode, action: "rank" | "accept" | "execute" | "judge" | "red_team" | "repair" | "final" | "learn") {
    if (!queenWorkflow.graph || queenBusy) return;
    const graph = queenWorkflow.graph;
    const abort = new AbortController();
    abortRef.current = abort;
    setQueenBusy(`${action}:${node.nodeId}`);
    setLastError(null);
    try {
      if (action === "rank") {
        const data = await runQueenMutation<{ rankNodeAgents: QueenRankResult }>({
          operationName: "RankNodeAgents",
          query: RANK_NODE_AGENTS_MUTATION,
          input: {
            taskId: graph.taskId,
            nodeId: node.nodeId,
            requiredCapabilities: capabilitiesForQueenNode(node),
          },
          signal: abort.signal,
        });
        setQueenRanks((current) => ({ ...current, [node.nodeId]: data.rankNodeAgents }));
        appendQueenLog(`Ranked ${node.nodeId}; auto-selected ${data.rankNodeAgents.autoSelectedAgentId ?? "none"}.`);
      }
      if (action === "accept") {
        const selectedAgentId = queenRanks[node.nodeId]?.autoSelectedAgentId;
        if (!selectedAgentId) throw new Error(`No selected agent for ${node.nodeId}; rank first.`);
        const data = await runQueenMutation<{ acceptNodeAssignment: QueenAssignmentResult }>({
          operationName: "AcceptNodeAssignment",
          query: ACCEPT_NODE_ASSIGNMENT_MUTATION,
          input: { taskId: graph.taskId, nodeId: node.nodeId, agentId: selectedAgentId },
          signal: abort.signal,
        });
        setQueenAssignments((current) => ({ ...current, [node.nodeId]: data.acceptNodeAssignment }));
        appendQueenLog(`Accepted ${node.nodeId} by ${data.acceptNodeAssignment.selectedAgentId}.`);
      }
      if (action === "execute") {
        const executorAgentId = queenAssignments[node.nodeId]?.selectedAgentId;
        if (!executorAgentId) throw new Error(`Accept ${node.nodeId} first.`);
        const data = await runQueenMutation<{ submitNodeOutput: { nodeId: string; output: string; status: string } }>({
          operationName: "SubmitNodeOutput",
          query: SUBMIT_NODE_OUTPUT_MUTATION,
          input: { taskId: graph.taskId, nodeId: node.nodeId, executorAgentId },
          signal: abort.signal,
        });
        setQueenNodeOutputs((current) => ({ ...current, [node.nodeId]: data.submitNodeOutput.output }));
        appendQueenLog(`Submitted ${node.nodeId}: ${clipLog(data.submitNodeOutput.output)}`);
      }
      if (action === "judge") {
        const judgedNodeId = node.judgesNodeId ?? "execute-1";
        const judgeAgentId = queenAssignments[node.nodeId]?.selectedAgentId;
        if (!judgeAgentId) throw new Error(`Accept judge node ${node.nodeId} first.`);
        const data = await runQueenMutation<{ judgeNodeOutput: { verdict: string; score: number; redTeamRequired: boolean } }>({
          operationName: "JudgeNodeOutput",
          query: JUDGE_NODE_OUTPUT_MUTATION,
          input: { taskId: graph.taskId, nodeId: judgedNodeId, judgeAgentId },
          signal: abort.signal,
        });
        appendQueenLog(`Judged ${judgedNodeId}: ${data.judgeNodeOutput.verdict}, score ${data.judgeNodeOutput.score}, red-team ${data.judgeNodeOutput.redTeamRequired ? "required" : "not required"}.`);
      }
      if (action === "red_team") {
        const targetNodeId = firstNodeId(graph, "execute");
        const redTeamAgentId = queenAssignments[node.nodeId]?.selectedAgentId;
        if (!redTeamAgentId) throw new Error(`Accept red-team node ${node.nodeId} first.`);
        const data = await runQueenMutation<{ requestAdversarialReview: { findings: string } }>({
          operationName: "RequestAdversarialReview",
          query: REQUEST_ADVERSARIAL_REVIEW_MUTATION,
          input: { taskId: graph.taskId, nodeId: targetNodeId, redTeamAgentId },
          signal: abort.signal,
        });
        appendQueenLog(`Red-team findings: ${clipLog(data.requestAdversarialReview.findings)}`);
      }
      if (action === "repair") {
        const parentNodeId = node.repairsNodeId ?? firstNodeId(graph, "execute");
        const repairAgentId = queenAssignments[node.nodeId]?.selectedAgentId ?? queenAssignments[parentNodeId]?.selectedAgentId;
        if (!repairAgentId) throw new Error(`Accept repair node or parent executor first.`);
        const data = await runQueenMutation<{ repairNode: { repairNodeId: string; output: string } }>({
          operationName: "RepairNode",
          query: REPAIR_NODE_MUTATION,
          input: { taskId: graph.taskId, parentNodeId, repairAgentId },
          signal: abort.signal,
        });
        appendQueenLog(`Repair ${data.repairNode.repairNodeId}: ${clipLog(data.repairNode.output)}`);
      }
      if (action === "final") {
        const finalArbiterAgentId = queenAssignments[node.nodeId]?.selectedAgentId;
        if (!finalArbiterAgentId) throw new Error(`Accept final arbiter node ${node.nodeId} first.`);
        const data = await runQueenMutation<{ finalArbitrate: { verdict: string; finalOutput: string } }>({
          operationName: "FinalArbitrate",
          query: FINAL_ARBITRATE_MUTATION,
          input: { taskId: graph.taskId, finalArbiterAgentId },
          signal: abort.signal,
        });
        appendQueenLog(`Final arbitration ${data.finalArbitrate.verdict}: ${clipLog(data.finalArbitrate.finalOutput)}`);
      }
      if (action === "learn") {
        const data = await runQueenMutation<{ writeLearningLoop: { status: string; summary: string } }>({
          operationName: "WriteLearningLoop",
          query: WRITE_LEARNING_LOOP_MUTATION,
          input: {
            taskId: graph.taskId,
            summary: `Queen workflow ${graph.taskId} completed with graph revision ${graph.graphRevision}.`,
          },
          signal: abort.signal,
        });
        appendQueenLog(`Learning Loop ${data.writeLearningLoop.status}: ${clipLog(data.writeLearningLoop.summary)}`);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        const message = error instanceof Error ? error.message : "Queen node action failed";
        setLastError(message);
        appendQueenLog(`Error on ${action} ${node.nodeId}: ${message}`);
      }
    } finally {
      setQueenBusy(null);
      abortRef.current = null;
    }
  }

  async function startQueenWorkflow() {
    if (!queenWorkflow.graph || queenBusy) return;
    const graph = queenWorkflow.graph;
    if (graph.startPolicy === "manualRequired" && typeof window !== "undefined") {
      const approved = window.confirm("This workflow is marked high risk. Starting it may spend provider quota or run local models. Continue?");
      if (!approved) {
        appendQueenLog("Start cancelled by user after high-risk confirmation.");
        return;
      }
    }
    const abort = new AbortController();
    abortRef.current = abort;
    setQueenBusy("workflow");
    setLastError(null);
    setQueenWorkflow((current) => ({
      ...current,
      status: "running",
      activeNodeId: "confirm-workflow",
      log: [...current.log, "Confirming workflow and accepted assignments..."].slice(-10),
    }));
    try {
      const assignments = graph.nodes.some((node) => queenAssignments[node.nodeId]?.status !== "accepted")
        ? await prepareQueenAssignments(graph, abort.signal)
        : queenAssignments;
      if (Object.keys(assignments).length > 0) appendQueenLog("Recommended agents are confirmed.");

      const confirmation = await runQueenMutation<{ confirmTaskGraph: { graphRevision: number; confirmationStatus: string } }>({
        operationName: "ConfirmTaskGraph",
        query: CONFIRM_TASK_GRAPH_MUTATION,
        input: { taskId: graph.taskId },
        signal: abort.signal,
      });
      appendQueenLog(`Workflow revision ${confirmation.confirmTaskGraph.graphRevision} is ${confirmation.confirmTaskGraph.confirmationStatus}.`);

      const data = await runQueenMutation<{ startTaskRun: { status: string; reasonCode?: string; runId?: string } }>({
        operationName: "StartTaskRun",
        query: START_TASK_RUN_MUTATION,
        input: {
          taskId: graph.taskId,
          manualApproval: graph.startPolicy === "manualRequired" ? true : undefined,
        },
        signal: abort.signal,
      });
      appendQueenLog(`Workflow start: ${data.startTaskRun.status}${data.startTaskRun.reasonCode ? ` / ${data.startTaskRun.reasonCode}` : ""}${data.startTaskRun.runId ? ` / ${data.startTaskRun.runId}` : ""}`);
      if (data.startTaskRun.status !== "running") {
        throw new Error(data.startTaskRun.reasonCode ?? `Workflow start returned ${data.startTaskRun.status}`);
      }

      for (const node of graph.nodes) {
        setQueenWorkflow((current) => ({
          ...current,
          status: "running",
          activeNodeId: node.nodeId,
          log: [...current.log, `Running ${node.nodeId}: ${node.title}`].slice(-10),
        }));
        if (node.type === "execute") {
          const executorAgentId = assignments[node.nodeId]?.selectedAgentId;
          if (!executorAgentId) throw new Error(`No confirmed executor for ${node.title}.`);
          const output = await runQueenMutation<{ submitNodeOutput: { nodeId: string; output: string; status: string } }>({
            operationName: "SubmitNodeOutput",
            query: SUBMIT_NODE_OUTPUT_MUTATION,
            input: { taskId: graph.taskId, nodeId: node.nodeId, executorAgentId },
            signal: abort.signal,
          });
          setQueenNodeOutputs((current) => ({ ...current, [node.nodeId]: output.submitNodeOutput.output }));
          appendQueenLog(`Executor completed: ${clipLog(output.submitNodeOutput.output)}`);
        }
        if (node.type === "judge") {
          const judgeAgentId = assignments[node.nodeId]?.selectedAgentId;
          if (!judgeAgentId) throw new Error(`No confirmed judge for ${node.title}.`);
          const judgedNodeId = node.judgesNodeId ?? firstNodeId(graph, "execute");
          const verdict = await runQueenMutation<{ judgeNodeOutput: { verdict: string; score: number; redTeamRequired: boolean } }>({
            operationName: "JudgeNodeOutput",
            query: JUDGE_NODE_OUTPUT_MUTATION,
            input: { taskId: graph.taskId, nodeId: judgedNodeId, judgeAgentId },
            signal: abort.signal,
          });
          appendQueenLog(`Independent judge: ${verdict.judgeNodeOutput.verdict}, score ${verdict.judgeNodeOutput.score}.`);
        }
        if (node.type === "red_team") {
          const redTeamAgentId = assignments[node.nodeId]?.selectedAgentId;
          if (!redTeamAgentId) throw new Error(`No confirmed red-team agent for ${node.title}.`);
          const review = await runQueenMutation<{ requestAdversarialReview: { findings: string } }>({
            operationName: "RequestAdversarialReview",
            query: REQUEST_ADVERSARIAL_REVIEW_MUTATION,
            input: { taskId: graph.taskId, nodeId: firstNodeId(graph, "execute"), redTeamAgentId },
            signal: abort.signal,
          });
          appendQueenLog(`Adversarial review completed: ${clipLog(review.requestAdversarialReview.findings)}`);
        }
        if (node.type === "repair") {
          const parentNodeId = node.repairsNodeId ?? firstNodeId(graph, "execute");
          const repairAgentId = assignments[node.nodeId]?.selectedAgentId ?? assignments[parentNodeId]?.selectedAgentId;
          if (!repairAgentId) throw new Error(`No confirmed repair agent for ${node.title}.`);
          const repair = await runQueenMutation<{ repairNode: { repairNodeId: string; output: string } }>({
            operationName: "RepairNode",
            query: REPAIR_NODE_MUTATION,
            input: { taskId: graph.taskId, parentNodeId, repairAgentId },
            signal: abort.signal,
          });
          appendQueenLog(`Repair path prepared: ${clipLog(repair.repairNode.output)}`);
        }
        if (node.type === "synthesize") {
          const finalArbiterAgentId = assignments[node.nodeId]?.selectedAgentId;
          if (!finalArbiterAgentId) throw new Error(`No confirmed final arbiter for ${node.title}.`);
          const arbitration = await runQueenMutation<{ finalArbitrate: { verdict: string; finalOutput: string } }>({
            operationName: "FinalArbitrate",
            query: FINAL_ARBITRATE_MUTATION,
            input: { taskId: graph.taskId, finalArbiterAgentId },
            signal: abort.signal,
          });
          appendQueenLog(`Final arbiter: ${arbitration.finalArbitrate.verdict}; ${clipLog(arbitration.finalArbitrate.finalOutput)}`);
        }
        if (node.type === "deliver") {
          const memory = await runQueenMutation<{ writeLearningLoop: { status: string; summary: string } }>({
            operationName: "WriteLearningLoop",
            query: WRITE_LEARNING_LOOP_MUTATION,
            input: {
              taskId: graph.taskId,
              summary: `Queen workflow ${graph.taskId} completed with graph revision ${graph.graphRevision}.`,
            },
            signal: abort.signal,
          });
          appendQueenLog(`Learning Loop record: ${memory.writeLearningLoop.status}; ${clipLog(memory.writeLearningLoop.summary)}`);
        }
      }
      setQueenWorkflow((current) => finalizeQueenWorkflowState(current, "succeeded", "Workflow completed with all required nodes."));
    } catch (error) {
      const message = abort.signal.aborted
        ? "Workflow cancelled by user."
        : error instanceof Error ? error.message : "Queen start failed";
      if (!abort.signal.aborted) {
        setLastError(message);
      }
      setQueenWorkflow((current) => finalizeQueenWorkflowState(
        current,
        abort.signal.aborted ? "cancelled" : "error",
        abort.signal.aborted ? message : `Start error: ${message}`,
      ));
    } finally {
      setQueenBusy(null);
      abortRef.current = null;
    }
  }

  function appendQueenLog(message: string) {
    setQueenWorkflow((current) => ({ ...current, log: [...current.log, message].slice(-10) }));
  }

  function cancel() {
    abortRef.current?.abort();
    setBusy(false);
  }

  function cancelQueenWorkflow() {
    abortRef.current?.abort();
  }

  function addSelectedToOrchestration() {
    if (!canAddSelected) return;
    setOrchestrationIds((current) => [...current, selectedAgent.id]);
  }

  function resetOrchestration() {
    if (busy) return;
    setOrchestrationIds([]);
  }

  return (
    <Localized>
      <>
        <PageHeader
          eyebrow="LIVE AGENT PLAYGROUND"
          title="Talk to real agents"
          description="Workflow control surface for the local trained runtime plus DeepSeek, Kimi, Qwen, and Zhipu provider agents. Select agents in order, then let the lead agent orchestrate the final answer."
          actions={<Badge tone={health.status === "online" ? "cyan" : health.status === "degraded" ? "amber" : "rose"}>{health.status.toUpperCase()}</Badge>}
        />

        {!runtimeAvailable ? <div className="runtime-offline-callout" role="status"><div><strong>Runtime unavailable</strong><span>{health.reasonCode ?? "RUNTIME_OFFLINE"}. Queen planning, chat, and orchestration stay disabled until the signed Runtime health check succeeds.</span></div><button type="button" className="button button-ghost" onClick={() => setHealthRevision((current) => current + 1)}>Retry runtime health</button></div> : null}

        <Panel className="queen-workflow-panel">
          <div className="panel-heading">
            <div>
              <h2>Queen-led GraphQL workflow</h2>
              <p>Describe the task once. Queen plans the DAG, auto-fills recommended agents, asks for high-risk confirmation, then runs independent Judge and Final Arbiter gates behind one user-level flow.</p>
            </div>
            <Badge tone={queenWorkflow.status === "ready" || queenWorkflow.status === "succeeded" ? "cyan" : queenWorkflow.status === "running" ? "amber" : queenWorkflow.status === "error" || queenWorkflow.status === "cancelled" ? "rose" : "neutral"}>
              {queenWorkflow.status.toUpperCase()}
            </Badge>
          </div>
          <QueenFlowDiagram graph={visibleQueenGraph} activeNodeId={queenWorkflow.activeNodeId} status={queenWorkflow.status} />
          <div className="queen-workflow-grid">
            <div className="queen-workflow-copy">
              <strong>Hard flow</strong>
              <span>{"requirement -> task plan -> Auto-filled agents -> verified run -> delivery evidence"}</span>
              <button type="button" className="button button-primary" disabled={!runtimeAvailable || queenWorkflow.status === "proposing" || queenBusy !== null} onClick={proposeQueenWorkflow}>
                {queenWorkflow.status === "proposing" || queenBusy === "prepare" ? "Planning..." : "Generate workflow plan"}
              </button>
              <button type="button" className="button button-warning" disabled={!runtimeAvailable || !queenWorkflow.graph || queenBusy !== null || queenWorkflow.status === "succeeded"} onClick={startQueenWorkflow}>
                {queenBusy === "workflow" ? "Running..." : queenWorkflow.status === "succeeded" ? "Workflow completed" : "Start workflow"}
              </button>
              {queenBusy === "workflow" ? <button type="button" className="button button-ghost" onClick={cancelQueenWorkflow}>Cancel workflow</button> : null}
              {queenWorkflow.activeNodeId ? <span role="status"><strong>Current node</strong>: {queenWorkflow.activeNodeId}</span> : null}
            </div>
            <div className="queen-workflow-log">
              {(queenWorkflow.log.length > 0 ? queenWorkflow.log : ["No task graph proposed yet."]).map((item, index) => (
                <span key={`${item}-${index}`}>{item}</span>
              ))}
            </div>
          </div>
          {visibleQueenGraph ? (
            <div className="queen-dag">
              <div className="queen-dag-meta">
                <span>taskId: {visibleQueenGraph.taskId}</span>
                <span>risk: {visibleQueenGraph.riskLevel}</span>
                <span>start: {visibleQueenGraph.startPolicy}</span>
                <span>rescue: {visibleQueenGraph.rescuePolicy.mode}</span>
                <span>agents: Auto-filled</span>
                {queenDraftGraph ? (
                  <>
                    <button type="button" className="button button-primary" disabled={queenBusy !== null} onClick={saveQueenWorkflowEdit}>Save workflow changes</button>
                    <button type="button" className="button button-ghost" disabled={queenBusy !== null} onClick={() => setQueenDraftGraph(null)}>Cancel editing</button>
                  </>
                ) : (
                  <button type="button" className="button button-ghost" disabled={queenBusy !== null} onClick={beginQueenWorkflowEdit}>Edit workflow</button>
                )}
              </div>
              <div className="queen-node-list">
                {visibleQueenGraph.nodes.map((node) => {
                  const selectedAgentId = queenAssignments[node.nodeId]?.selectedAgentId ?? queenRanks[node.nodeId]?.autoSelectedAgentId;
                  const nodeStatus = queenAssignments[node.nodeId]?.status === "accepted"
                    ? "Accepted"
                    : selectedAgentId ? "Recommended" : "Queued";
                  return (
                    <div key={node.nodeId} className={`queen-node queen-node-${node.type}`}>
                      <strong>{node.type}</strong>
                      {queenDraftGraph ? (
                        <input
                          aria-label={`Edit ${node.nodeId} title`}
                          maxLength={160}
                          value={node.title}
                          onChange={(event) => setQueenDraftGraph((current) => current ? updateQueenNodeTitle(current, node.nodeId, event.target.value) : current)}
                        />
                      ) : <span>{node.title}</span>}
                      <small>{node.nodeId} {node.required ? "/ required" : "/ rescue"}</small>
                      <em>{node.dependencies.length > 0 ? `after ${node.dependencies.join(", ")}` : "entry"}</em>
                      <small>agent: {selectedAgentId ?? "Auto-fill pending"}</small>
                      <small>status: {nodeStatus}</small>
                      <select
                        aria-label={`Select agent for ${node.nodeId}`}
                        disabled={queenBusy !== null || (queenRanks[node.nodeId]?.candidates.length ?? 0) === 0}
                        value={selectedAgentId ?? ""}
                        onChange={(event) => { void selectQueenNodeAgent(node.nodeId, event.target.value); }}
                      >
                        {!selectedAgentId ? <option value="">Auto-fill pending</option> : null}
                        {(queenRanks[node.nodeId]?.candidates ?? []).map((candidate) => (
                          <option key={candidate.agentId} value={candidate.agentId}>{candidate.displayName}</option>
                        ))}
                      </select>
                      {(() => {
                        const output = queenNodeOutputs[node.nodeId];
                        return output ? <em>{clipLog(output)}</em> : null;
                      })()}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </Panel>

        <div className="playground-layout">
          <Panel className="agent-rail">
            <div className="panel-heading"><h2>Agents</h2><Badge tone="neutral">V1 C-PLANE</Badge></div>
            <div className="agent-option-list">
              {displayAgents.map((agent) => {
                const live = healthById.get(agent.id);
                const status = live?.status ?? "offline";
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className={`agent-option ${selectedId === agent.id ? "active" : ""}`}
                    onClick={() => setSelectedId(agent.id)}
                  >
                    <span className={`agent-status agent-status-${status}`} />
                    <strong>{agent.name}</strong>
                    <small>{agent.provider} / {agent.model}</small>
                    <em>{agent.ownership} / {agent.selectableBy}</em>
                  </button>
                );
              })}
            </div>
            <div className="runtime-boundary">
              <span>Boundary</span>
              <p>Worker validates access, Tunnel reaches only the local runtime, and the runtime calls Ollama or provider APIs server-side.</p>
            </div>
            <div className="orchestration-builder">
              <span>Sequential orchestration</span>
              <p>Pick the lead agent first. The next slot unlocks only after the previous slot is selected; final orchestration runs after at least two agents are chosen.</p>
              <p>One model can occupy only one slot. Local Ollama agents are owner-only and require an authenticated owner runtime scope before public selection.</p>
              <div className="orchestration-slots">
                {Array.from({ length: MAX_ORCHESTRATION_AGENTS }).map((_, index) => {
                  const agent = orchestrationAgents[index];
                  const locked = index > orchestrationIds.length;
                  return (
                    <div key={index} className={`orchestration-slot ${agent ? "filled" : locked ? "locked" : ""}`}>
                      <strong>{index === 0 ? "Lead" : `Step ${index + 1}`}</strong>
                      <span>{agent ? `${agent.name} / ${agent.model}` : locked ? "Locked" : "Select next agent"}</span>
                    </div>
                  );
                })}
              </div>
              <div className="button-row">
                <button type="button" className="button button-ghost" disabled={!canAddSelected} onClick={addSelectedToOrchestration}>
                  Add as {orchestrationIds.length === 0 ? "Lead" : `Step ${orchestrationIds.length + 1}`}
                </button>
                <button type="button" className="button button-ghost" disabled={busy || orchestrationIds.length === 0} onClick={resetOrchestration}>Reset</button>
              </div>
            </div>
          </Panel>

          <section className="chat-surface">
            <div className="chat-toolbar">
              <div>
                <span>{selectedAgent.provider}</span>
                <strong>{selectedAgent.name}</strong>
                <small>{selectedAgent.note}</small>
                <small>{selectedAgent.visibility} / {selectedAgent.selectableBy}</small>
              </div>
              <Badge tone={healthById.get(selectedAgent.id)?.status === "online" ? "cyan" : "amber"}>
                {(healthById.get(selectedAgent.id)?.status ?? "pending runtime").toUpperCase()}
              </Badge>
            </div>

            <div className="message-list" aria-live="polite">
              {messages.map((message, index) => (
                <div key={`${message.role}-${index}`} className={`message message-${message.role}`}>
                  <span>{message.role}</span>
                  <p>{message.content || (busy && index === messages.length - 1 ? "Streaming..." : "")}</p>
                </div>
              ))}
            </div>

            {lastError ? <div className="inline-state chat-error" role="status">{lastError}</div> : null}

            <form className="composer" onSubmit={submit}>
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} maxLength={4000} />
              <div className="composer-actions">
                <span>{selectedAgent.model}</span>
                <div className="button-row">
                  {busy ? <button type="button" className="button button-ghost" onClick={cancel}>Cancel</button> : null}
                  <button className="button button-primary" disabled={!runtimeAvailable || busy || draft.trim().length === 0}>Send</button>
                  <button type="button" className="button button-warning" disabled={!canRunOrchestration} onClick={runOrchestration}>Run orchestration</button>
                </div>
              </div>
            </form>
          </section>
        </div>
      </>
    </Localized>
  );
}

function QueenFlowDiagram({ graph, activeNodeId, status }: { graph: QueenTaskGraphResult | undefined; activeNodeId: string | undefined; status: QueenWorkflowState["status"] }) {
  const stages = graph?.nodes.length ? graph.nodes.map((node) => ({ id: node.nodeId, label: node.title, type: node.type })) : [...CANONICAL_QUEEN_FLOW];
  const fallbackActiveIndex = status === "proposing" ? 1 : status === "ready" ? 2 : status === "running" ? 3 : status === "succeeded" ? stages.length - 1 : status === "error" ? 4 : 0;
  const matchedActiveIndex = activeNodeId ? stages.findIndex((stage) => stage.id === activeNodeId) : -1;
  const activeIndex = matchedActiveIndex >= 0 ? matchedActiveIndex : fallbackActiveIndex;

  return <section className="queen-flow-diagram" aria-label="Queen workflow diagram">
    <ol className="queen-flow-track">
      {stages.map((stage, index) => {
        const stageState = status === "succeeded" || index < activeIndex ? "completed" : index === activeIndex ? status === "error" ? "error" : "active" : "waiting";
        return <li key={stage.id} className={`queen-flow-stage queen-flow-${stageState}`} data-state={stageState}>
          <span className="queen-flow-index">{String(index + 1).padStart(2, "0")}</span><strong>{stage.label}</strong><small>{stage.type} / {stageState}</small>
        </li>;
      })}
    </ol>
    {graph ? <ul className="queen-edge-list" aria-label="Graph edges">{graph.edges.map((edge) => <li key={`${edge.from}-${edge.to}-${edge.condition ?? "always"}`}><span>{edge.from}</span><b aria-hidden="true">→</b><span>{edge.to}</span><em>{edge.condition ?? "always"}</em></li>)}</ul> : <div className="queen-rescue-lane"><span>Judge</span><b aria-hidden="true">↘</b><span>Needs revision</span><b aria-hidden="true">→</b><span>Red Team</span><b aria-hidden="true">→</b><span>Repair</span><b aria-hidden="true">↗</b><span>Return to Judge</span></div>}
  </section>;
}

async function runGraphqlOrchestration(options: {
  agentIds: string[];
  prompt: string;
  signal: AbortSignal;
}): Promise<GraphqlOrchestrationResult> {
  const response = await fetch("/agent/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      query: ORCHESTRATE_AGENTS_MUTATION,
      operationName: "OrchestrateAgents",
      variables: {
        input: {
          requestId: crypto.randomUUID(),
          idempotencyKey: `graphql-${Date.now()}`,
          agentIds: options.agentIds,
          messages: [{ role: "user", content: options.prompt }],
        },
      },
    }),
    signal: options.signal,
  });
  const payload = await parseGraphqlResponse(response);
  if (!response.ok) throw new Error(`GraphQL gateway returned ${response.status}`);
  if (!isRecord(payload)) throw new Error("GraphQL response is invalid");
  const errors = payload.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    throw new Error(isRecord(first) && typeof first.message === "string" ? first.message : "GraphQL orchestration failed");
  }
  const data = isRecord(payload.data) ? payload.data : {};
  const result = isRecord(data.orchestrateAgents) ? data.orchestrateAgents : undefined;
  if (!isGraphqlOrchestrationResult(result)) throw new Error("GraphQL orchestration result is invalid");
  return result;
}

async function runQueenMutation<T>(options: {
  operationName: string;
  query: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<T> {
  const operationSignal = createWorkflowOperationSignal(options.signal);
  let response: Response;
  try {
    response = await fetch("/agent/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        query: options.query,
        operationName: options.operationName,
        variables: { input: options.input },
      }),
      signal: operationSignal,
    });
  } catch (error) {
    if (operationSignal.aborted && !options.signal.aborted) {
      throw new Error(`${options.operationName} timed out after ${WORKFLOW_OPERATION_TIMEOUT_MS / 1000} seconds.`);
    }
    throw error;
  }
  const payload = await parseGraphqlResponse(response);
  if (!response.ok) throw new Error(`GraphQL gateway returned ${response.status}`);
  if (!isRecord(payload)) throw new Error("GraphQL response is invalid");
  const errors = payload.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    throw new Error(isRecord(first) && typeof first.message === "string" ? first.message : "Queen workflow failed");
  }
  if (!isRecord(payload.data)) throw new Error("GraphQL response data is invalid");
  return payload.data as T;
}

export function createWorkflowOperationSignal(parentSignal: AbortSignal, timeoutMs = WORKFLOW_OPERATION_TIMEOUT_MS): AbortSignal {
  return AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)]);
}

export function finalizeQueenWorkflowState(
  current: QueenWorkflowState,
  status: "succeeded" | "error" | "cancelled",
  message: string,
): QueenWorkflowState {
  const { activeNodeId: _activeNodeId, ...rest } = current;
  return { ...rest, status, log: [...current.log, message].slice(-10) };
}

async function runAgentRequest(options: {
  agentId: AgentId;
  chatMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  signal: AbortSignal;
  onDelta: (delta: string) => void;
  onError: (message: string) => void;
}) {
  const response = await fetch("/agent/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      idempotencyKey: `web-${Date.now()}`,
      agentId: options.agentId,
      messages: options.chatMessages.slice(-8),
    }),
    signal: options.signal,
  });
  if (!response.ok || response.body === null) throw new Error(`Chat gateway returned ${response.status}`);
  await readSse(response.body, (eventName, payload) => {
    if (eventName === "delta" && typeof payload.delta === "string") options.onDelta(payload.delta);
    if (eventName === "error") options.onError(readRuntimeError(payload));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRuntimeError(payload: Record<string, unknown>) {
  const error = isRecord(payload.error) ? payload.error : {};
  if (typeof error.message === "string") return error.message;
  if (typeof error.code === "string") return error.code;
  return "Agent runtime failed";
}

function buildDisplayAgents(healthAgents: HealthAgent[], ownerAgents: OwnerAgentRecord[] = []) {
  const fallbackById = new Map(fallbackAgents.map((agent) => [agent.id, agent]));
  const liveAgents = healthAgents.map((agent) => {
    const fallback = fallbackById.get(agent.agentId);
    return {
      id: agent.agentId,
      name: agent.displayName,
      provider: providerLabel(agent.provider),
      ownership: agent.ownership,
      model: agent.modelTag,
      visibility: agent.visibility ?? "private",
      selectableBy: agent.selectableBy ?? "owner-only",
      note: fallback?.note ?? liveAgentNote(agent),
      verification: fallback?.verification ?? agent.status,
    };
  });
  const liveIds = new Set(liveAgents.map((agent) => agent.id));
  const ownerEntries = ownerAgents
    .filter((agent) => !liveIds.has(agent.id))
    .map((agent) => ({
      id: agent.id,
      name: agent.displayName,
      provider: agent.provider === "ollama" ? "Ollama" : "User HTTPS",
      ownership: "user-managed",
      model: agent.modelTag,
      visibility: agent.listingStatus,
      selectableBy: agent.selectableBy,
      note: agent.provider === "ollama"
        ? "Owner-only metadata. Offline until the signed local Runtime reports the same model."
        : agent.listingStatus === "pending-platform-test"
          ? "Paid Agent is hidden from the market until the platform test passes."
          : "Free HTTPS Agent admitted by the deterministic listing policy.",
      verification: agent.provider === "ollama" ? "offline" : agent.platformTestStatus,
    }));
  const ownerIds = new Set(ownerEntries.map((agent) => agent.id));
  return [...liveAgents, ...ownerEntries, ...fallbackAgents.filter((agent) => !liveIds.has(agent.id) && !ownerIds.has(agent.id))];
}

function hasDuplicateModels(agents: DisplayAgent[]): boolean {
  const seen = new Set<string>();
  for (const agent of agents) {
    const key = agent.model.toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function providerLabel(provider: HealthAgent["provider"]) {
  return agentProviderLabel(provider);
}

function liveAgentNote(agent: HealthAgent) {
  if (agent.provider === "ollama") return "Local runtime agent served through the Mac runtime boundary.";
  return "Hosted provider agent. API key stays server-side behind the runtime boundary.";
}

function capabilitiesForQueenNode(node: QueenTaskNode): string[] {
  if (node.type === "plan") return ["plan"];
  if (node.type === "judge") return ["judge"];
  if (node.type === "red_team") return ["red_team"];
  if (node.type === "synthesize" || node.type === "deliver") return ["final_arbitration"];
  return ["completion"];
}

export function updateQueenNodeTitle(graph: QueenTaskGraphResult, nodeId: string, title: string): QueenTaskGraphResult {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => node.nodeId === nodeId ? { ...node, title } : node),
  };
}

function firstNodeId(graph: QueenTaskGraphResult, type: string): string {
  return graph.nodes.find((node) => node.type === type)?.nodeId ?? graph.nodes[0]?.nodeId ?? "execute-1";
}

function clipLog(value: string): string {
  return value.length > 150 ? `${value.slice(0, 150)}...` : value;
}

function replaceLastAssistant(messages: ChatMessage[], replace: (content: string) => string): ChatMessage[] {
  let index = -1;
  for (let currentIndex = messages.length - 1; currentIndex >= 0; currentIndex -= 1) {
    if (messages[currentIndex]?.role === "assistant") {
      index = currentIndex;
      break;
    }
  }
  if (index < 0) return messages;
  return messages.map((message, currentIndex) => (
    currentIndex === index ? { ...message, content: replace(message.content) } : message
  ));
}

function formatOrchestrationResult(result: GraphqlOrchestrationResult): string {
  return [
    `[GraphQL orchestration complete]`,
    `requestId: ${result.requestId}`,
    `runId: ${result.runId}`,
    `lead: ${result.leadAgentId}`,
    "",
    "Steps:",
    ...result.steps.map((step, index) => `${index + 1}. ${step.agentId} / ${step.modelTag} / ${step.provider}`),
    "",
    result.finalOutput,
  ].join("\n");
}

function isGraphqlOrchestrationResult(value: unknown): value is GraphqlOrchestrationResult {
  if (!isRecord(value)) return false;
  return typeof value.requestId === "string"
    && typeof value.runId === "string"
    && value.status === "succeeded"
    && typeof value.leadAgentId === "string"
    && typeof value.finalOutput === "string"
    && Array.isArray(value.steps);
}

async function readSse(stream: ReadableStream<Uint8Array>, onEvent: (eventName: string, payload: Record<string, unknown>) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) parseSseChunk(chunk, onEvent);
    }
    if (buffer.trim()) parseSseChunk(buffer, onEvent);
  } finally {
    reader.releaseLock();
  }
}

function parseSseChunk(chunk: string, onEvent: (eventName: string, payload: Record<string, unknown>) => void) {
  const eventName = chunk.match(/^event:\s*(.+)$/m)?.[1]?.trim() ?? "message";
  const data = chunk.match(/^data:\s*(.+)$/m)?.[1];
  if (!data) return;
  try {
    onEvent(eventName, JSON.parse(data) as Record<string, unknown>);
  } catch {
    onEvent("error", { error: { message: "Invalid stream event" } });
  }
}
