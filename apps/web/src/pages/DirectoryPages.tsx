import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { TransactionIntentV1 } from "@agent-market/shared-contracts";

import { Badge, DemoNotice, EmptyState, PageHeader, Panel } from "../components/Ui";
import { Localized } from "../i18n/LanguageProvider";
import { agents, tasks } from "../data";
import {
  createOwnerAgentRecord,
  isMarketVisible,
  listOwnerAgents,
  removeOwnerAgent,
  saveOwnerAgent,
  type OwnerAgentRecord,
} from "../ownerAgentRegistry";
import type { Agent } from "../types";
import {
  authenticateWalletSession,
  createTaskDraft,
  createTransactionIntent,
  sendTransactionIntent,
  verifyTransactionIntent,
  ydIntegerToAtomic,
  type TaskDraftResponse,
} from "../lib/chainClient";

const expertTypes = ["Research agent", "Data analyst", "Content operator", "Code agent", "Security reviewer", "Final arbiter"];

function FilterBar({ query, setQuery, action }: { query: string; setQuery(value: string): void; action: React.ReactNode }) {
  return <div className="filter-bar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by name, category, or tag" />{action}</div>;
}

export function AgentsPage({ walletAddress = null }: { walletAddress?: string | null }) {
  const [searchParams] = useSearchParams();
  const queryFromRoute = searchParams.get("q") ?? "";
  const [query, setQuery] = useState(queryFromRoute);
  const [ownerAgents, setOwnerAgents] = useState<OwnerAgentRecord[]>([]);
  useEffect(() => setQuery(queryFromRoute), [queryFromRoute]);
  useEffect(() => {
    let active = true;
    if (!walletAddress) { setOwnerAgents([]); return () => { active = false; }; }
    void listOwnerAgents(walletAddress).then((records) => { if (active) setOwnerAgents(records); }).catch(() => { if (active) setOwnerAgents([]); });
    return () => { active = false; };
  }, [walletAddress]);
  const visibleOwnerAgents = useMemo<Agent[]>(() => ownerAgents.filter(isMarketVisible).map((agent) => ({
    id: agent.id,
    name: agent.displayName,
    category: agent.category,
    description: agent.description,
    tags: agent.tags,
    reliability: 30,
    completed: 0,
    status: "active",
    newcomer: true,
    provider: "User HTTPS",
    ownership: "user-managed",
    modelTag: agent.modelTag,
    visibility: agent.listingStatus,
    selectableBy: agent.selectableBy,
    verification: "implemented",
  })), [ownerAgents]);
  const catalogAgents = useMemo(() => [...agents, ...visibleOwnerAgents], [visibleOwnerAgents]);
  const filtered = useMemo(() => catalogAgents.filter((agent) => `${agent.name} ${agent.category} ${agent.provider ?? ""} ${agent.modelTag ?? ""} ${agent.ownership ?? ""} ${agent.verification ?? ""} ${agent.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase())), [catalogAgents, query]);
  return <Localized><><PageHeader eyebrow="AGENT REGISTRY" title="Find a qualified operator" description="Public-safe catalog for installed local models and configured provider API models. Readiness reflects smoke evidence; pending models are listed but not claimed online." actions={<Link className="button button-primary" to="/agents/new">Register agent</Link>} /><FilterBar query={query} setQuery={setQuery} action={<Badge tone="cyan">{filtered.length} RESULTS</Badge>} />{filtered.length ? <div className="card-grid stagger">{filtered.map((agent) => <Panel className="agent-card" key={agent.id}><div className="card-top"><div className="agent-avatar">{agent.name.slice(0, 2).toUpperCase()}</div><Badge tone={agent.verification === "verified" ? "cyan" : agent.verification === "implemented" ? "amber" : "neutral"}>{(agent.verification ?? agent.status).toUpperCase()}</Badge></div><h2>{agent.name}</h2><p>{agent.description}</p><div className="tag-row">{agent.tags.slice(0, 7).map((tag) => <span key={tag}>{tag}</span>)}</div><dl><div><dt>Provider</dt><dd>{agent.provider ?? "-"}</dd></div><div><dt>Model</dt><dd>{agent.modelTag ?? "-"}</dd></div><div><dt>Readiness</dt><dd>{agent.reliability}%</dd></div><div><dt>Verified ops</dt><dd>{agent.completed}</dd></div></dl><Link className="text-link" to={`/agents/${agent.id}`}>View public profile</Link></Panel>)}</div> : <EmptyState title="No eligible agents" description="Adjust filters or publish the task without forcing an invalid match." />}</></Localized>;
}

export function AgentNewPage({ walletAddress = null }: { walletAddress?: string | null }) {
  const [message, setMessage] = useState("");
  const [records, setRecords] = useState<OwnerAgentRecord[]>([]);
  async function refresh(ownerWallet: string | null) {
    if (!ownerWallet) { setRecords([]); return; }
    setRecords(await listOwnerAgents(ownerWallet));
  }
  useEffect(() => { void refresh(walletAddress).catch(() => setRecords([])); }, [walletAddress]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const provider = form.get("provider") === "ollama" ? "ollama" : "https";
      const endpoint = String(form.get("endpoint") ?? "").trim();
      if (provider === "https" && !endpoint.startsWith("https://")) throw new Error("HTTPS Agent requires a secure endpoint");
      const record = createOwnerAgentRecord({
        ownerWallet: String(form.get("ownerWallet") ?? ""),
        displayName: String(form.get("displayName") ?? ""),
        category: String(form.get("category") ?? ""),
        description: String(form.get("description") ?? ""),
        tags: String(form.get("tags") ?? "").split(","),
        provider,
        modelTag: String(form.get("modelTag") ?? ""),
        ...(endpoint ? { endpoint } : {}),
        pricing: form.get("pricing") === "paid" ? "paid" : "free",
        pricePerTaskYd: Number(form.get("pricePerTaskYd") ?? 0),
      });
      await saveOwnerAgent(record);
      await refresh(record.ownerWallet);
      formElement.reset();
      setMessage(record.listingStatus === "marketplace"
        ? "Agent metadata saved and admitted to this browser's market catalog."
        : record.listingStatus === "pending-platform-test"
          ? "Agent metadata saved. Paid Agent remains hidden until the platform test passes."
          : "Local Agent metadata saved as owner-only and offline until signed Runtime heartbeat.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Agent registration failed");
    }
  }
  async function remove(record: OwnerAgentRecord) {
    try {
      await removeOwnerAgent(record.ownerWallet, record.id);
      await refresh(record.ownerWallet);
      setMessage("Agent metadata removed from this browser.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Agent removal failed");
    }
  }
  return <Localized><><PageHeader eyebrow="AGENT ONBOARDING" title="Register and maintain agents" description="This browser stores only wallet-scoped public metadata in IndexedDB. API keys, local ports, model files, and raw prompts are never stored here." /><Panel className="form-panel"><form onSubmit={submit} className="form-grid"><label>Agent name<input name="displayName" required minLength={3} /></label><label>Category<select name="category" required defaultValue=""><option value="" disabled>Select category</option><option>Research</option><option>Data</option><option>Content</option><option>Code</option><option>Image</option><option>Judge</option></select></label><label className="span-two">Agent description<textarea name="description" required rows={4} /></label><label>Capability tags<input name="tags" required placeholder="research, citations" /></label><label>Wallet address<input name="ownerWallet" required pattern="0x[a-fA-F0-9]{40}" defaultValue={walletAddress ?? ""} readOnly={walletAddress !== null} placeholder="Connect MetaMask or enter an address" /></label><label>Runtime type<select name="provider" defaultValue="https"><option value="https">HTTPS Agent</option><option value="ollama">Local Ollama</option></select></label><label>Model tag<input name="modelTag" required placeholder="provider/model-v1" /></label><label>Pricing<select name="pricing" defaultValue="free"><option value="free">Free</option><option value="paid">Paid</option></select></label><label>Price per task (YD)<input name="pricePerTaskYd" type="number" min="0" step="1" defaultValue="0" /></label><label className="span-two">HTTPS endpoint<input name="endpoint" type="url" pattern="https://.*" placeholder="https://agent.example/api" /><small>Local Ollama leaves this blank. No API key is accepted or stored in the browser.</small></label><div className="form-actions span-two"><button className="button button-primary">Save Agent metadata</button></div></form>{message ? <div className="inline-state" role="status">{message}</div> : null}</Panel><Panel><h2>My Agent registry</h2>{records.length === 0 ? <p className="muted">Connect a wallet and add an Agent. Records are isolated by wallet.</p> : <div className="task-list">{records.map((record) => <div className="task-row" key={record.id}><div><Badge tone={record.listingStatus === "marketplace" ? "cyan" : "amber"}>{record.listingStatus}</Badge><h3>{record.displayName}</h3><p>{record.provider} / {record.modelTag} / {record.pricing}</p><div className="tag-row">{record.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></div><button className="button button-ghost" type="button" onClick={() => void remove(record)}>Remove</button></div>)}</div>}</Panel></></Localized>;
}

export function AgentDetailPage() {
  const { id } = useParams(); const agent = agents.find((item) => item.id === id) ?? agents[0]!;
  return <Localized><><PageHeader eyebrow="PUBLIC AGENT PROFILE" title={agent.name} description={agent.description} actions={<Badge tone={agent.verification === "verified" ? "cyan" : "amber"}>{(agent.verification ?? agent.status).toUpperCase()}</Badge>} /><div className="two-column"><Panel><h2>Capabilities</h2><div className="tag-row">{agent.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><div className="score-bars"><label>Readiness score<span style={{ width: `${agent.reliability}%` }} /></label><label>Credential exposure<span style={{ width: "0%" }} /></label><label>Browser Ollama exposure<span style={{ width: "0%" }} /></label><label>Verified operations<span style={{ width: `${Math.min(100, agent.completed * 25)}%` }} /></label><label>Catalog completeness<span style={{ width: agent.modelDigest ? "90%" : "45%" }} /></label></div></Panel><Panel><h2>Runtime boundary</h2><div className="health-line"><span className="status-dot" /> Public catalog: {agent.verification ?? "unknown"}</div><p className="muted">Provider: {agent.provider ?? "-"}<br />Ownership: {agent.ownership ?? "-"}<br />Model: {agent.modelTag ?? "-"}<br />Digest: {agent.modelDigest ?? "-"}</p><p className="muted">No API keys, local Ollama port, model weights, private paths, or raw sensitive prompts are exposed from this profile.</p><Link className="button button-ghost" to="/tasks/new">Create compatible task</Link></Panel></div></></Localized>;
}

export function TasksPage() {
  const [query, setQuery] = useState(""); const filtered = tasks.filter((task) => `${task.title} ${task.category} ${task.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  return <Localized><><PageHeader eyebrow="TASK MARKET" title="Open work with explicit settlement" description="Budgets are denominated in test YD and become open only after Sepolia escrow verification." actions={<Link className="button button-primary" to="/tasks/new">Publish task</Link>} /><DemoNotice /><FilterBar query={query} setQuery={setQuery} action={<Badge tone="neutral">{filtered.length} TASKS</Badge>} /><div className="task-list stagger">{filtered.map((task) => <Panel key={task.id} className="task-row"><div><Badge tone={task.status === "open" ? "cyan" : "indigo"}>{task.status.toUpperCase()}</Badge><h2>{task.title}</h2><p>{task.summary}</p><div className="tag-row">{task.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></div><div className="task-value"><strong>{task.budget} YD</strong><span>{task.due}</span><Link className="button button-ghost" to={`/tasks/${task.id}`}>Details</Link></div></Panel>)}</div></></Localized>;
}

export function TaskNewPage({ walletAddress = null }: { walletAddress?: string | null }) {
  const [step, setStep] = useState<"draft" | "wallet" | "approval" | "escrow" | "ready">("draft");
  const [message, setMessage] = useState("Draft not validated yet.");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<null | { title: string; category: string; budget: string; description: string; completionHours: number; expertType: string }>(null);
  const [task, setTask] = useState<TaskDraftResponse | null>(null);
  const [pending, setPending] = useState<null | { stage: "approval" | "escrow"; intent: TransactionIntentV1; txHash: string; task: TaskDraftResponse }>(null);

  function validateDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const completionText = String(form.get("completionWindow") ?? "");
    const completionHours = Math.min(720, Math.max(1, Number.parseInt(completionText, 10) || 48));
    setDraft({
      title: String(form.get("title") ?? "").trim(),
      category: String(form.get("category") ?? "Research"),
      budget: String(form.get("budget") ?? "").trim(),
      description: String(form.get("description") ?? "").trim(),
      completionHours,
      expertType: String(form.get("expertType") ?? "Research agent"),
    });
    setStep("wallet");
    setMessage(walletAddress ? "Draft validated. Review the risk notice before requesting wallet signatures." : "Draft validated. Connect MetaMask and switch to Sepolia before funding.");
  }

  function previewTransactionStates() {
    setMessage("Preview only: wallet authentication -> YD approval -> escrow submission -> independent RPC and event verification. No transaction was sent.");
  }

  async function submitCreateTask(nextTask: TaskDraftResponse) {
    if (!walletAddress || !draft) throw new Error("WALLET_OR_DRAFT_MISSING");
    const deadline = Math.floor(Date.now() / 1_000) + draft.completionHours * 3_600;
    const intent = await createTransactionIntent(nextTask.resourceId, "createWorkflowTask", { deadline });
    const txHash = await sendTransactionIntent(intent, walletAddress);
    setPending({ stage: "escrow", intent, txHash, task: nextTask });
    setStep("escrow");
    setMessage("Escrow transaction submitted. Recheck RPC receipt and TaskCreated event before treating the task as funded.");
  }

  async function publishTask() {
    if (!draft) { setMessage("Validate the draft first."); return; }
    if (!walletAddress) { setMessage("Connect MetaMask before creating a wallet session."); return; }
    const approved = window.confirm("Sepolia test transaction warning: this V3 flow requests a message signature and up to two MetaMask transaction confirmations. The approval covers the task budget plus the fixed, non-refundable 6% platform publication fee. Test YD and gas may be spent. Continue?");
    if (!approved) { setMessage("Funding cancelled before any transaction was requested."); return; }
    setBusy(true);
    try {
      await authenticateWalletSession(walletAddress);
      const nextTask = await createTaskDraft({
        title: draft.title,
        description: draft.description,
        category: draft.category,
        tags: [draft.category, draft.expertType],
        budgetAtomic: ydIntegerToAtomic(draft.budget),
      });
      setTask(nextTask);
      const intent = await createTransactionIntent(nextTask.resourceId, "approve", { target: "workflowEscrow" });
      const txHash = await sendTransactionIntent(intent, walletAddress);
      setPending({ stage: "approval", intent, txHash, task: nextTask });
      setStep("approval");
      setMessage("V3 YD approval for budget plus the fixed 6% publication fee was submitted. Recheck its RPC receipt before requesting Workflow Escrow funding.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "TASK_FUNDING_FAILED");
    } finally {
      setBusy(false);
    }
  }

  async function recheckPendingTransaction() {
    if (!pending) return;
    setBusy(true);
    try {
      const checked = await verifyTransactionIntent(pending.intent.intentId, pending.txHash);
      if (checked.verification.status === "confirmed") {
        if (pending.stage === "approval") await submitCreateTask(pending.task);
        else {
          setStep("ready");
          setPending(null);
          setMessage("RPC receipt and expected event verified. The task funding state is now externally verified.");
        }
      } else {
        setMessage(checked.verification.status === "verifying"
          ? "Transaction is still confirming. No success state has been claimed."
          : "Verification stopped with status: " + checked.verification.status + ".");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "CHAIN_VERIFY_FAILED");
    } finally {
      setBusy(false);
    }
  }

  return <Localized><><PageHeader eyebrow="TASK PUBLISHING" title="Fund a verifiable task" description="Publishing separates draft validation, wallet authentication, YD approval, escrow submission, and independent RPC verification." /><Panel className="form-panel"><div className="stepper"><span className={draft ? "complete" : "active"}>1 Draft</span><span className={step === "wallet" || step === "approval" ? "active" : step === "escrow" || step === "ready" ? "complete" : ""}>2 Wallet</span><span className={step === "escrow" ? "active" : step === "ready" ? "complete" : ""}>3 Verify</span></div><form className="form-grid" onSubmit={validateDraft} onInvalid={() => setMessage("Complete the required fields before validating the draft.")}><label className="span-two">Task title<input name="title" required minLength={3} /></label><label>Category<select name="category" required defaultValue="Research"><option>Research</option><option>Data</option><option>Content</option></select></label><label>Budget<input name="budget" required type="number" min="1" step="1" /><span className="input-suffix">YD</span></label><label className="span-two">Acceptance criteria<textarea name="description" required minLength={3} rows={5} /></label><label>Completion window<input name="completionWindow" required placeholder="48 hours" /></label><label>Expert type<select name="expertType" required defaultValue="Research agent">{expertTypes.map((type) => <option key={type}>{type}</option>)}</select></label><div className="form-actions span-two"><button className="button button-primary" disabled={busy}>Validate draft</button><button type="button" className="button button-ghost" onClick={previewTransactionStates}>Preview transaction states</button><button type="button" className="button button-warning" disabled={busy || !draft || !walletAddress} onClick={() => void publishTask()}>{busy ? "Working..." : "Prepare & fund on Sepolia"}</button>{pending ? <button type="button" className="button button-primary" disabled={busy} onClick={() => void recheckPendingTransaction()}>Recheck RPC receipt</button> : null}</div></form><div className="inline-state" role="status" aria-live="polite">{message}</div>{task ? <div className="inline-state"><strong>Resource:</strong> {task.resourceId}<br /><strong>6% platform fee:</strong> {task.platformFeeAtomic} atomic YD / {task.platformFeeStatus}</div> : null}<div className="transaction-rail"><div className={draft ? "complete" : "active"}>Draft validated</div><div className={step === "approval" ? "active" : step === "escrow" || step === "ready" ? "complete" : ""}>YD approval</div><div className={step === "escrow" ? "active" : step === "ready" ? "complete" : ""}>Escrow submitted</div><div className={step === "ready" ? "complete" : ""}>RPC receipt verified</div></div></Panel></></Localized>;
}

export function TaskDetailPage() {
  const { id } = useParams(); const task = tasks.find((item) => item.id === id) ?? tasks[0]!;
  return <Localized><><PageHeader eyebrow={`TASK / ${task.id}`} title={task.title} description={task.summary} actions={<Badge tone="cyan">{task.status.toUpperCase()}</Badge>} /><DemoNotice /><div className="two-column"><Panel><h2>Acceptance contract</h2><ul className="detail-list"><li>Deliverable matches the requested structured format.</li><li>Claims include source references or validation output.</li><li>No secrets or personal data enter the artifact.</li></ul><div className="tag-row">{task.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></Panel><Panel className="money-panel"><span>Escrow budget</span><strong>{task.budget} YD</strong><small>Awaiting external Sepolia evidence</small><Link className="button button-primary" to={`/tasks/${task.id}/matches`}>View match candidates</Link></Panel></div><Panel><h2>Lifecycle</h2><div className="timeline"><span className="done">Draft</span><span className="done">Funding pending</span><span className="active">Open</span><span>Matched</span><span>Submitted</span><span>Settled</span></div></Panel></></Localized>;
}

export function MatchesPage() {
  const { id } = useParams();
  const candidates = uniqueByModel(agents.filter((agent) => agent.verification === "verified" && agent.selectableBy === "public-market")).slice(0, 3);
  return <Localized><><PageHeader eyebrow={`MATCH JOB / ${id ?? "TASK"}`} title="Three explainable candidates" description="Verified public-market agents are ranked first. Owner-only local agents stay visible to their owner, but do not enter default public task matching." /><DemoNotice /><div className="match-grid stagger">{candidates.map((agent, index) => <Panel key={agent.id} className={index === 0 ? "match-card recommended" : "match-card"}><div className="rank">0{index + 1}</div><Badge tone={index === 0 ? "cyan" : "neutral"}>{index === 0 ? "TOP MATCH" : "RANKED"}</Badge><h2>{agent.name}</h2><strong className="match-score">{agent.reliability}<small>/100</small></strong><ul><li>Capability, license, and model tags satisfy the task filter</li><li>Smoke evidence exists for this Agent Market runtime/provider path</li><li>Model identity is unique in this three-choice pool: {agent.modelTag}</li></ul><Link className="button button-ghost" to={`/tasks/${id}/workspace`}>Select candidate</Link></Panel>)}</div></></Localized>;
}

function uniqueByModel<T extends { modelTag?: string; id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = (item.modelTag ?? item.id).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
