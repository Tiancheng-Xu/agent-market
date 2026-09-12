import {
  QueenReactFlow,
  type GraphEdge,
  type QueenNodePositions,
} from "./QueenReactFlow";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { EdgeChange, NodeChange } from "@xyflow/react";

import { Badge, PageHeader, Panel } from "../components/Ui";
import { agentProviderLabel, publicAgentCatalog } from "../agentCatalog";
import { Localized, translateLocalizedText, useLanguage } from "../i18n/LanguageProvider";
import "./LocalAgentsPage.css";
import { parseGraphqlResponse } from "../lib/graphqlResponse";
import { listOwnerAgents, type OwnerAgentRecord } from "../ownerAgentRegistry";
import { authenticateWalletSession } from "../lib/chainClient";
import { assertWalletSessionAuthenticated, subscribeWalletSession, walletSessionRevision } from "../lib/walletSession";
import { canConfirmQueenPlanning, createQueenPlanningClient, isPlanningTaskId,
  QUEEN_PLANNING_ERROR_STATUS, queenPlanningStatusLabel, type QueenPlanningStatus } from "../lib/queenPlanningClient";

export { parseGraphqlResponse } from "../lib/graphqlResponse";

// Page-owned explanatory copy only. IDs, model names and transport state codes
// are preserved; changing language must not change planning or approval state.
const queenLocalZhCopy: Readonly<Record<string, string>> = {
  "Chat and orchestration are disabled. Persisted Queen planning uses the separate authenticated TE gateway; Runtime health does not prove its worker readiness.": "聊天与编排暂不可用。已保存任务的 Queen 规划使用独立的认证 TE 网关；Runtime 健康检查不能证明规划 Worker 已就绪。",
  "Connect a wallet using the existing wallet control, then explicitly sign in.": "请先通过页面的钱包入口连接钱包，再主动签名登录。",
  "Local demonstration only. Not a real task, persisted plan, assignment or execution.": "仅供本地演示，不代表真实任务、持久化计划、任务分配或执行结果。",
  "Local demonstration only. No persisted task loaded.": "仅供本地演示，尚未加载持久化任务。",
  "No private plan loaded. Read a persisted task; no demo fallback.": "尚未加载私有计划。请读取持久化任务；不会用演示图代替真实计划。",
  "No committed graph read back for this task. Queued is not generated; refresh persisted status. No demonstration fallback.": "尚未读回此任务已持久化的任务图。排队不等于生成完成，请刷新持久化状态；不会回退到演示图。",
  "Wallet session invalidated. Sign in again to read private plans.": "钱包会话已失效，请重新签名登录后读取私有计划。",
  "Queued only, not a generated graph or execution.": "仅表示已排队，不代表任务图已生成或任务已执行。",
  "Approval recorded, not execution completed.": "仅表示审批已记录，不代表执行完成。",
  "Planning producer/worker readiness is not enabled on this host. History can still be read; no flags were changed.": "此主机未启用规划生产者或 Worker 就绪门控。仍可读取历史记录；未修改任何开关。",
  "Click Sign in and read to sign in again. No automatic signature or mutation retry.": "请点击“签名登录并读取”重新登录。不会自动签名或重试写入操作。",
  "Readback unavailable. Refresh status before any further action; do not assume a mutation failed or retry execution.": "暂时无法读回状态。请先刷新状态，再进行后续操作；不能据此认定写入失败或重试执行。",
  "Local demonstration changes only. Nothing was sent or persisted.": "仅修改本地演示图，未发送请求，也未写入持久化存储。",
  "No persisted planning request": "尚无持久化规划请求",
  "Authorization expired / revoked / stale (server does not distinguish); approval disabled. ": "授权已过期、撤销或失效（服务端未区分具体原因），审批已禁用。",
  "Planning: ": "规划状态：",
  "Approval: ": "审批状态：",
  " (approved)": "（已批准）",
  " (rejected)": "（已拒绝）",
  "; recording is not execution.": "；记录审批不等于执行任务。",
  "No approval recorded.": "尚未记录审批。",
  "Execution not verified.": "执行结果尚未验证。",
  "LOCAL DEMO": "本地演示",
  "READING / QUEUING": "读取或排队中",
  "NOT LOADED": "尚未加载",
  "Persisted task ID": "持久化任务 ID",
  "Queuing...": "正在排队...",
  "Local demo only": "仅查看本地演示",
  "agents: Auto-filled (local demo only)": "智能体：自动填充（仅本地演示）",
  "agents: persisted plan only; execution not verified": "智能体：仅展示持久化计划，执行结果尚未验证",
  "Save local demo changes": "保存本地演示修改",
  "Edit local demo": "编辑本地演示",
  "Demonstration only": "仅供演示",
  "No execution evidence": "暂无执行证据",
  "matching audit: unavailable": "匹配审计：暂不可用",
};

export function localQueenCopy(text: string, locale: "en" | "zh-CN"): string {
  if (locale !== "zh-CN") return text;
  return Object.entries(queenLocalZhCopy).reduce((result, [english, chinese]) => result.split(english).join(chinese), text);
}

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
  assignedAgentId?: string;
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
  matchingAudit?: {
    policyVersion: string;
    eligibleCount: number;
    selectedIds: string[];
    selectionReasons: Array<"history-rank" | "history-fallback" | "cold-start-exploration">;
    seedHash: string;
    historyCount: number;
    coldStartCount: number;
  };
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

export function LocalAgentsPage({
  initialQueenWorkflow,
  initialQueenRanks = {},
  walletAddress = null,
}: {
  initialQueenWorkflow?: QueenWorkflowState;
  initialQueenRanks?: Record<string, QueenRankResult>;
  walletAddress?: string | null;
} = {}) {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const queenCopy = (text: string) => localQueenCopy(text, locale);
  const [agentSearch, setAgentSearch] = useState("");
  const [openAgentGroups, setOpenAgentGroups] = useState<Record<string, boolean>>({ current: true });
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
  const [queenRanks, setQueenRanks] = useState<Record<string, QueenRankResult>>(initialQueenRanks);
  const [planningTaskId, setPlanningTaskId] = useState("");
  const [demoMode, setDemoMode] = useState(true);
  const [needsLogin, setNeedsLogin] = useState(true);
  const [planningNotice, setPlanningNotice] = useState("");
  const [readback, setReadback] = useState<{ wallet: string; revision: number; value: QueenPlanningStatus } | null>(null);
  const planningAbortRef = useRef<AbortController | null>(null);
  const planningSequence = useRef(0);
  const clientRef = useRef<ReturnType<typeof createQueenPlanningClient> | null>(null);
  const [queenBusy, setQueenBusy] = useState<string | null>(null);
  const [queenDraftGraph, setQueenDraftGraph] = useState<QueenTaskGraphResult | null>(null);
  const [queenNodePositions, setQueenNodePositions] = useState<QueenNodePositions>({});
  const [ownerAgents, setOwnerAgents] = useState<OwnerAgentRecord[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const displayAgents = useMemo(() => buildDisplayAgents(health.agents, ownerAgents), [health.agents, ownerAgents]);
  const selectedAgent = useMemo(
    () => displayAgents.find((agent) => agent.id === selectedId) ?? displayAgents[0]!,
    [displayAgents, selectedId],
  );
  const healthById = useMemo(() => new Map(health.agents.map((agent) => [agent.agentId, agent])), [health.agents]);
  const agentGroups = [
    { id: "current", label: zh ? "当前与已验证模型" : "Current and verified models" },
    { id: "candidates", label: zh ? "候选模型" : "Candidate models" },
    { id: "history", label: zh ? "历史模型" : "Historical models" },
  ].map((group) => ({
    ...group,
    agents: displayAgents.filter((agent) => {
      const historical = /historical|earlier self-trained/i.test(`${agent.name} ${agent.note}`);
      const groupId = historical ? "history"
        : healthById.get(agent.id)?.status === "online" || agent.verification === "verified" || ownerAgents.some((owner) => owner.id === agent.id)
          ? "current" : "candidates";
      const labels = [agent.name, agent.model, agent.provider, agent.ownership, agent.selectableBy, group.label];
      const searchable = labels.flatMap((label) => [label, translateLocalizedText("zh-CN", label)]).join(" ").toLowerCase();
      return groupId === group.id && searchable.includes(agentSearch.trim().toLowerCase());
    }),
  }));
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
  const livePlanning = readback?.wallet === walletAddress?.toLowerCase()
    && readback?.revision === walletSessionRevision() && readback.value.task.taskId === planningTaskId.trim()
    ? readback.value : null;
  const visibleQueenGraph = demoMode ? queenDraftGraph ?? queenWorkflow.graph : livePlanning?.request?.plan?.graph;
  const queenGraphEditable = demoMode && canEditQueenDraft(queenWorkflow.status, queenBusy);
  const presentedQueenWorkflow: QueenWorkflowState = demoMode ? queenWorkflow : {
    status: queenBusy ? "proposing" : "idle",
    log: [planningNotice, livePlanning ? queenPlanningStatusLabel(livePlanning) : "No private plan loaded. Read a persisted task; no demo fallback."].filter(Boolean),
  };

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

  function clearPlanning() {
    planningSequence.current += 1;
    planningAbortRef.current?.abort();
    planningAbortRef.current = null;
    clientRef.current = null;
    setReadback(null);
    setQueenBusy(null);
    setPlanningNotice("");
    setQueenDraftGraph(null);
    setQueenNodePositions({});
    setQueenRanks({});
    setQueenWorkflow({ status: "idle", log: [] });
  }

  useEffect(() => {
    clearPlanning();
    try { assertWalletSessionAuthenticated(); setNeedsLogin(!walletAddress); }
    catch { setNeedsLogin(true); }
    const unsubscribe = subscribeWalletSession(() => {
      clearPlanning();
      setNeedsLogin(true);
      setPlanningNotice("Wallet session invalidated. Sign in again to read private plans.");
    });
    return () => {
      unsubscribe();
      planningSequence.current += 1;
      planningAbortRef.current?.abort();
    };
  }, [walletAddress]);

  async function runPlanningAction(action: "read" | "login" | "propose" | "confirm") {
    const taskId = planningTaskId.trim();
    if (!walletAddress || !isPlanningTaskId(taskId) || queenBusy) return;
    if (action === "propose" && !livePlanning) return;
    if (action === "confirm" && (!livePlanning || !canConfirmQueenPlanning(livePlanning))) return;
    const revision = walletSessionRevision();
    const sequence = ++planningSequence.current;
    const abort = new AbortController();
    planningAbortRef.current?.abort();
    planningAbortRef.current = abort;
    setDemoMode(false);
    setQueenBusy(action);
    setPlanningNotice("");
    const current = () => sequence === planningSequence.current
      && revision === walletSessionRevision() && !abort.signal.aborted;
    const applyReadback = (value: QueenPlanningStatus) => {
      if (current()) setReadback({ wallet: walletAddress.toLowerCase(), revision, value });
    };
    try {
      if (action === "login") {
        // The only signature path is this explicitly clicked action.
        await authenticateWalletSession(walletAddress);
        if (!current()) return;
        clientRef.current = createQueenPlanningClient();
        setNeedsLogin(false);
      }
      const client = clientRef.current ??= createQueenPlanningClient();
      if (action === "propose") {
        const result = await client.propose(livePlanning!.task, abort.signal);
        if (!current()) return;
        setReadback(null);
        setPlanningNotice(`requestId: ${result.requestId}; ${result.status}; duplicate: ${result.duplicate}. Queued only, not a generated graph or execution.`);
      }
      if (action === "confirm") {
        const result = await client.confirm(livePlanning!, true, abort.signal);
        if (!current()) return;
        setReadback(null);
        setPlanningNotice(`approvalId: ${result.approvalId}; ${result.status}; duplicate: ${result.duplicate}. Approval recorded, not execution completed.`);
      }
      applyReadback(await client.read(taskId, abort.signal));
    } catch (error) {
      if (!current()) return;
      setReadback(null);
      const code = error instanceof Error ? error.message : "QUEEN_GRAPHQL_UNAVAILABLE";
      const authFailure = ["AUTH_SESSION_INVALID", "AUTH_REAUTH_REQUIRED", "AUTH_WALLET_CHANGED"].includes(code);
      if (authFailure) { setNeedsLogin(true); clientRef.current = null; }
      const safe = Object.hasOwn(QUEEN_PLANNING_ERROR_STATUS, code)
        || ["AUTH_REAUTH_REQUIRED", "AUTH_WALLET_CHANGED", "QUEEN_REQUEST_TIMEOUT", "QUEEN_GRAPHQL_INVALID_RESPONSE"].includes(code)
        ? code : "QUEEN_GRAPHQL_UNAVAILABLE";
      setPlanningNotice((previous) => [previous, safe, safe === "QUEEN_ASYNC_PLANNING_DISABLED"
        ? "Planning producer/worker readiness is not enabled on this host. History can still be read; no flags were changed."
        : authFailure ? "Click Sign in and read to sign in again. No automatic signature or mutation retry."
          : "Readback unavailable. Refresh status before any further action; do not assume a mutation failed or retry execution."].filter(Boolean).join(" "));
    } finally {
      if (current()) { setQueenBusy(null); planningAbortRef.current = null; }
    }
  }

  function beginQueenWorkflowEdit() {
    if (!demoMode || !queenWorkflow.graph || !queenGraphEditable) return;
    setQueenDraftGraph(structuredClone(queenWorkflow.graph));
    setQueenNodePositions({});
  }

  function saveQueenWorkflowEdit() {
    if (!demoMode || !queenDraftGraph || queenBusy) return;
    setQueenWorkflow({ status: "ready", graph: queenDraftGraph, log: ["Local demonstration changes only. Nothing was sent or persisted."] });
    setQueenDraftGraph(null);
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
        <div className="local-agents-intro">
        <PageHeader
          eyebrow="LIVE AGENT PLAYGROUND"
          title="Talk to real agents"
          description={locale === "zh-CN" ? "选择智能体，描述任务，再查看流程与交付证据。" : "Select an agent, describe a task, then inspect the workflow and delivery evidence."}
          actions={<Badge tone={health.status === "online" ? "cyan" : health.status === "degraded" ? "amber" : "rose"}>{health.status.toUpperCase()}</Badge>}
        />

        </div>

        {!runtimeAvailable ? <div className="runtime-offline-callout" role="status"><div><strong>Runtime unavailable</strong><span>{health.reasonCode ?? "RUNTIME_OFFLINE"}. {queenCopy("Chat and orchestration are disabled. Persisted Queen planning uses the separate authenticated TE gateway; Runtime health does not prove its worker readiness.")}</span></div><button type="button" className="button button-ghost" onClick={() => setHealthRevision((current) => current + 1)}>Retry runtime health</button></div> : null}

        <Panel className="queen-workflow-panel">
          <div className="panel-heading">
            <div>
              <h2>Queen-led GraphQL workflow</h2>
              <p>{locale === "zh-CN" ? "Queen 规划，你确认；Agent 执行，Judge 与 Final Arbiter 独立验收。" : "Queen plans. You confirm. Agents execute under independent Judge and Final Arbiter review."}</p>
            </div>
            <Badge tone="neutral">
              {queenCopy(demoMode ? "LOCAL DEMO" : queenBusy ? "READING / QUEUING" : (livePlanning?.request?.planningOperationStatus ?? "NOT LOADED").toUpperCase())}
            </Badge>
          </div>
          <div className="queen-workflow-grid">
            <div className="queen-workflow-copy">
              <label className="queen-task-prompt">
                <span>{zh ? "持久化任务 ID（UUID）" : "Persisted task ID (UUID)"}</span>
                <input value={planningTaskId} maxLength={36} aria-label={queenCopy("Persisted task ID")} onChange={(event) => {
                  clearPlanning(); setPlanningTaskId(event.target.value); setDemoMode(false);
                }} />
              </label>
              <p>{zh ? "需求仅从已保存任务读取，不使用聊天输入。连接钱包不等于签名登录。" : "Requirement comes only from the saved task, never the chat prompt. Connecting a wallet is not signing in."}</p>
              <p>{zh ? "真实主机及 Worker 就绪尚未验证；只有服务端允许才可排队。浏览器无执行权。" : "Live host/worker readiness is not verified; queuing requires server admission. The browser has no execution authority."}</p>
              {livePlanning ? <p>taskVersion: {livePlanning.task.taskVersion}; {zh ? "任务状态：" : "task status: "}{livePlanning.task.status}</p> : null}
              {livePlanning?.request ? <p style={{ overflowWrap: "anywhere" }}>requestId: {livePlanning.request.requestId}; graphRevision: {livePlanning.request.graphRevision}; fingerprint: {livePlanning.request.taskFingerprint}</p> : null}
              <div className="button-row">
              <button type="button" className="button button-ghost" disabled={!walletAddress || !isPlanningTaskId(planningTaskId.trim()) || queenBusy !== null} onClick={() => { void runPlanningAction("login"); }}>
                {zh ? "签名登录并读取" : "Sign in and read"}
              </button>
              <button type="button" className="button button-ghost" disabled={!walletAddress || needsLogin || !isPlanningTaskId(planningTaskId.trim()) || queenBusy !== null} onClick={() => { void runPlanningAction("read"); }}>
                {zh ? "刷新持久化状态" : "Refresh persisted status"}
              </button>
              <button type="button" className="button button-primary" disabled={demoMode || needsLogin || !livePlanning || livePlanning.task.status !== "open" || queenBusy !== null} onClick={() => { void runPlanningAction("propose"); }}>
                {queenBusy === "propose" ? queenCopy("Queuing...") : "Generate workflow plan"}
              </button>
              <button type="button" className="button button-warning" disabled={demoMode || needsLogin || !livePlanning || !canConfirmQueenPlanning(livePlanning) || queenBusy !== null} onClick={() => { void runPlanningAction("confirm"); }}>
                {zh ? "确认此版本计划（不执行）" : "Confirm this plan (not execution)"}
              </button>
              <button type="button" className="button button-ghost" onClick={() => { clearPlanning(); setDemoMode(true); }}>{queenCopy("Local demo only")}</button>
              </div>
              {!walletAddress ? <p role="status">{queenCopy("Connect a wallet using the existing wallet control, then explicitly sign in.")}</p> : null}
              {demoMode ? <p role="status">{queenCopy("Local demonstration only. Not a real task, persisted plan, assignment or execution.")}</p> : null}
            </div>
            <div className="queen-workflow-log" role="log" aria-label={locale === "zh-CN" ? "工作流进度" : "Workflow progress"}>
              {(presentedQueenWorkflow.log.length > 0 ? presentedQueenWorkflow.log : ["Local demonstration only. No persisted task loaded."]).map((item, index) => (
                <span key={`${item}-${index}`}>{queenCopy(item)}</span>
              ))}
            </div>
          </div>
          <details className="runtime-boundary queen-preflight">
            <summary>{locale === "zh-CN" ? "风险评估：仅本地验证，生产评估尚不可用" : "Risk assessment: local validation only; production unavailable"}</summary>
            <p><strong>Outside Queen DAG.</strong> The deterministic risk protocol and engine are <strong>verified-local</strong>. Production assessor unavailable because no production RiskAssessorClient is configured; this lane cannot claim a production assessment.</p>
          </details>
          {demoMode || visibleQueenGraph ? <QueenReactFlow
            graph={visibleQueenGraph ? {
              ...visibleQueenGraph,
              edges: visibleQueenGraph.edges.map(({ condition, ...edge }) => (
                condition === undefined ? edge : { ...edge, condition }
              )),
            } : undefined}
            activeNodeId={demoMode ? queenWorkflow.activeNodeId : undefined}
            status={demoMode ? queenWorkflow.status : "idle"}
            editMode={queenDraftGraph !== null && queenGraphEditable}
            locked={!queenGraphEditable}
            nodePositions={queenNodePositions}
            onNodePositionsChange={setQueenNodePositions}
            onNodesChange={(changes) => setQueenDraftGraph((current) => current ? applyQueenNodeChangesToDraft(current, changes) : current)}
            onEdgesChange={(changes) => setQueenDraftGraph((current) => current ? applyQueenEdgeChangesToDraft(current, changes) : current)}
            onConnect={(edge) => setQueenDraftGraph((current) => current ? appendQueenDraftEdge(current, edge) : current)}
            onValidationError={(error) => setLastError(`${error.code}: ${error.message}`)}
          /> : <div className="queen-react-flow" role="status">{queenCopy("No committed graph read back for this task. Queued is not generated; refresh persisted status. No demonstration fallback.")}</div>}
          {visibleQueenGraph ? (
            <div className="queen-dag">
              <div className="queen-dag-meta">
                <span>taskId: {visibleQueenGraph.taskId}</span>
                <span>risk: {visibleQueenGraph.riskLevel}</span>
                <span>start: {visibleQueenGraph.startPolicy}</span>
                <span>rescue: {visibleQueenGraph.rescuePolicy.mode}</span>
                <span>{queenCopy(demoMode ? "agents: Auto-filled (local demo only)" : "agents: persisted plan only; execution not verified")}</span>
                {queenDraftGraph ? (
                  <>
                    <button type="button" className="button button-primary" disabled={!demoMode || queenBusy !== null} onClick={saveQueenWorkflowEdit}>{queenCopy("Save local demo changes")}</button>
                    <button type="button" className="button button-ghost" disabled={queenBusy !== null} onClick={() => { setQueenDraftGraph(null); setQueenNodePositions({}); }}>Cancel editing</button>
                  </>
                ) : (
                  <button type="button" className="button button-ghost" disabled={!queenGraphEditable} onClick={beginQueenWorkflowEdit}>{queenCopy("Edit local demo")}</button>
                )}
              </div>
              <div className="queen-node-list">
                {visibleQueenGraph.nodes.map((node) => {
                  const selectedAgentId = demoMode ? queenRanks[node.nodeId]?.autoSelectedAgentId : node.assignedAgentId;
                  const nodeStatus = demoMode ? "Demonstration only" : "No execution evidence";
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
                      <small>status: {queenCopy(nodeStatus)}</small>
                      {queenRanks[node.nodeId]?.matchingAudit ? (
                        <div className="runtime-boundary" aria-label={`Matching audit for ${node.nodeId}`}>
                          <span>Matching audit / {queenRanks[node.nodeId]!.matchingAudit!.policyVersion}</span>
                          <small>selected: {queenRanks[node.nodeId]!.matchingAudit!.selectedIds.join(", ")}</small>
                          <small>reasons: {queenRanks[node.nodeId]!.matchingAudit!.selectionReasons.join(", ")}</small>
                          <small>seed: {summarizeSeedHash(queenRanks[node.nodeId]!.matchingAudit!.seedHash)}</small>
                          <small>eligible {queenRanks[node.nodeId]!.matchingAudit!.eligibleCount} / history {queenRanks[node.nodeId]!.matchingAudit!.historyCount} / cold {queenRanks[node.nodeId]!.matchingAudit!.coldStartCount}</small>
                        </div>
                      ) : <small>{queenCopy("matching audit: unavailable")}</small>}
                      <select
                        aria-label={`Select agent for ${node.nodeId}`}
                        disabled
                        value={selectedAgentId ?? ""}
                      >
                        {!selectedAgentId ? <option value="">Auto-fill pending</option> : null}
                        {(queenRanks[node.nodeId]?.candidates ?? []).map((candidate) => (
                          <option key={candidate.agentId} value={candidate.agentId}>{candidate.displayName}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </Panel>

        <div className="playground-layout local-agents-workspace">
          <Panel className="agent-rail">
            <div className="panel-heading"><h2>Agents</h2><Badge tone="neutral">V1 C-PLANE</Badge></div>
            <label className="agent-directory-search">
              <span>{zh ? "搜索 Agent 目录" : "Search agent directory"}</span>
              <input type="search" value={agentSearch} onChange={(event) => setAgentSearch(event.target.value)} placeholder={zh ? "名称、模型或提供方" : "Name, model or provider"} />
            </label>
            <p className="agent-directory-selection">{zh ? "当前选择：" : "Selected: "}{selectedAgent.name}</p>
            <div className="agent-directory-scroll" tabIndex={0} role="region" aria-label={zh ? "Agent 目录" : "Agent directory"}>
              {agentGroups.map((group) => group.agents.length ? <section className="agent-directory-group" key={group.id}>
                <button type="button" className="agent-directory-toggle" aria-expanded={Boolean(agentSearch.trim()) || Boolean(openAgentGroups[group.id])} aria-controls={`agent-group-${group.id}`} onClick={() => setOpenAgentGroups((current) => ({ ...current, [group.id]: !current[group.id] }))}>
                  <span>{group.label}</span><span>{group.agents.length} {agentSearch.trim() || openAgentGroups[group.id] ? "−" : "+"}</span>
                </button>
                <div id={`agent-group-${group.id}`} className="agent-option-list" hidden={!agentSearch.trim() && !openAgentGroups[group.id]}>
              {group.agents.map((agent) => {
                const live = healthById.get(agent.id);
                const status = live?.status ?? "offline";
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className={`agent-option ${selectedId === agent.id ? "active" : ""}`}
                    aria-pressed={selectedAgent.id === agent.id}
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
              </section> : null)}
              {!agentGroups.some((group) => group.agents.length) ? <p role="status">{zh ? "没有匹配的 Agent" : "No matching agents"}</p> : null}
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

export function canEditQueenDraft(status: string, busy: string | null): boolean {
  return busy === null && (status === "idle" || status === "ready");
}

function queenDraftEdgeId(edge: QueenTaskGraphResult["edges"][number]): string {
  return `${edge.from}-${edge.to}-${edge.condition ?? "always"}`;
}

export function applyQueenNodeChangesToDraft(
  graph: QueenTaskGraphResult,
  changes: NodeChange[],
): QueenTaskGraphResult {
  const removedNodeIds = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
  if (removedNodeIds.size === 0) return graph;
  return {
    ...graph,
    nodes: graph.nodes
      .filter((node) => !removedNodeIds.has(node.nodeId))
      .map((node) => {
        const nextNode = {
          ...node,
          dependencies: node.dependencies.filter((dependency) => !removedNodeIds.has(dependency)),
        };
        if (nextNode.judgesNodeId && removedNodeIds.has(nextNode.judgesNodeId)) delete nextNode.judgesNodeId;
        if (nextNode.repairsNodeId && removedNodeIds.has(nextNode.repairsNodeId)) delete nextNode.repairsNodeId;
        return nextNode;
      }),
    edges: graph.edges.filter((edge) => !removedNodeIds.has(edge.from) && !removedNodeIds.has(edge.to)),
  };
}

export function applyQueenEdgeChangesToDraft(
  graph: QueenTaskGraphResult,
  changes: EdgeChange[],
): QueenTaskGraphResult {
  const removedEdgeIds = new Set(changes.filter((change) => change.type === "remove").map((change) => change.id));
  if (removedEdgeIds.size === 0) return graph;
  const removedEdges = graph.edges.filter((edge) => removedEdgeIds.has(queenDraftEdgeId(edge)));
  return {
    ...graph,
    edges: graph.edges.filter((edge) => !removedEdgeIds.has(queenDraftEdgeId(edge))),
    nodes: graph.nodes.map((node) => ({
      ...node,
      dependencies: node.dependencies.filter((dependency) => !removedEdges.some((edge) => edge.from === dependency && edge.to === node.nodeId)),
    })),
  };
}

export function appendQueenDraftEdge(graph: QueenTaskGraphResult, edge: GraphEdge): QueenTaskGraphResult {
  if (graph.edges.some((candidate) => candidate.from === edge.from && candidate.to === edge.to)) return graph;
  const condition = edge.condition === "always" || edge.condition === "approved" || edge.condition === "needs_revision" || edge.condition === "rejected"
    ? edge.condition
    : undefined;
  const nextEdge: QueenTaskGraphResult["edges"][number] = condition
    ? { from: edge.from, to: edge.to, condition }
    : { from: edge.from, to: edge.to };
  return {
    ...graph,
    edges: [...graph.edges, nextEdge],
    nodes: graph.nodes.map((node) => node.nodeId === edge.to && !node.dependencies.includes(edge.from)
      ? { ...node, dependencies: [...node.dependencies, edge.from] }
      : node),
  };
}

export function preserveQueenDraftAfterSaveFailure(
  graph: QueenTaskGraphResult,
  error: unknown,
): { graph: QueenTaskGraphResult; reason: string } {
  return {
    graph,
    reason: error instanceof Error ? error.message : "Workflow amendment failed",
  };
}

function summarizeSeedHash(seedHash: string): string {
  return seedHash.length > 12 ? `${seedHash.slice(0, 12)}…` : seedHash;
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
