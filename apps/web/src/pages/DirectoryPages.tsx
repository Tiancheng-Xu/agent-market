import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { Badge, DemoNotice, EmptyState, PageHeader, Panel } from "../components/Ui";
import { Localized } from "../i18n/LanguageProvider";
import { agents, tasks } from "../data";
import { listOwnerAgents, saveOwnerAgent, type OwnerAgentRecord } from "../ownerAgentStore";

const expertTypes = ["Research agent", "Data analyst", "Content operator", "Code agent", "Security reviewer", "Final arbiter"];
export type TaskPublishingState = { step: "draft" | "wallet" | "ready"; message: string };
export type TaskPublishingAction = "invalid" | "validated" | "preview";
export const initialTaskPublishingState: TaskPublishingState = { step: "draft", message: "Draft not validated yet." };

export function reduceTaskPublishingState(_state: TaskPublishingState, action: TaskPublishingAction): TaskPublishingState {
  if (action === "invalid") return { step: "draft", message: "Complete the required fields before validating the draft." };
  if (action === "validated") return { step: "wallet", message: "Draft validated locally. Next: connect MetaMask, approve YD, then submit escrow." };
  return { step: "ready", message: "Preview only: approve YD -> submit escrow -> wait for RPC receipt. No wallet transaction was sent." };
}

function FilterBar({ query, setQuery, action }: { query: string; setQuery(value: string): void; action: React.ReactNode }) {
  return <Localized><div className="filter-bar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by name, category, or tag" />{action}</div></Localized>;
}

export function AgentsPage({ ownerWallet = null }: { ownerWallet?: string | null }) {
  const [searchParams] = useSearchParams();
  const queryFromRoute = searchParams.get("q") ?? "";
  const [query, setQuery] = useState(queryFromRoute);
  useEffect(() => setQuery(queryFromRoute), [queryFromRoute]);
  const [ownerAgents, setOwnerAgents] = useState<OwnerAgentRecord[]>([]);
  useEffect(() => { void listOwnerAgents(ownerWallet).then(setOwnerAgents).catch(() => setOwnerAgents([])); }, [ownerWallet]);
  const catalog = useMemo(() => [...ownerAgents, ...agents], [ownerAgents]);
  const filtered = useMemo(() => catalog.filter((agent) => `${agent.name} ${agent.category} ${agent.provider ?? ""} ${agent.modelTag ?? ""} ${agent.ownership ?? ""} ${agent.verification ?? ""} ${agent.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase())), [catalog, query]);
  return <Localized><><PageHeader eyebrow="AGENT REGISTRY" title="Find a qualified operator" description="Public-safe catalog plus owner-only metadata stored on this device. A local registration is not online until the signed Runtime reports matching health." actions={<Link className="button button-primary" to="/agents/new">Register agent</Link>} /><FilterBar query={query} setQuery={setQuery} action={<Badge tone="cyan">{filtered.length} RESULTS</Badge>} />{filtered.length ? <div className="card-grid stagger">{filtered.map((agent) => <Panel className="agent-card" key={agent.id}><div className="card-top"><div className="agent-avatar">{agent.name.slice(0, 2).toUpperCase()}</div><Badge tone={agent.verification === "verified" ? "cyan" : agent.verification === "implemented" ? "amber" : "neutral"}>{(agent.verification ?? agent.status).toUpperCase()}</Badge></div><h2>{agent.name}</h2><p>{agent.description}</p><div className="tag-row">{agent.tags.slice(0, 7).map((tag) => <span key={tag}>{tag}</span>)}</div><dl><div><dt>Provider</dt><dd>{agent.provider ?? "-"}</dd></div><div><dt>Model</dt><dd>{agent.modelTag ?? "-"}</dd></div><div><dt>Readiness</dt><dd>{agent.reliability}%</dd></div><div><dt>Verified ops</dt><dd>{agent.completed}</dd></div></dl><Link className="text-link" to={agent.verification === "registered-local" ? "/agents/local" : `/agents/${agent.id}`}>{agent.verification === "registered-local" ? "Open owner runtime" : "View public profile"}</Link></Panel>)}</div> : <EmptyState title="No eligible agents" description="Adjust filters or publish the task without forcing an invalid match." />}</></Localized>;
}

export function AgentNewPage({ ownerWallet = null }: { ownerWallet?: string | null }) {
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ownerWallet) { setMessage("Connect MetaMask first. The connected wallet scopes which browser profile can see this registration."); return; }
    const form = new FormData(event.currentTarget);
    const modelTag = String(form.get("modelTag") ?? "").trim();
    const tags = String(form.get("tags") ?? "").split(",").map((item) => item.trim()).filter(Boolean).slice(0, 12);
    const record: OwnerAgentRecord = {
      id: `owner-${modelTag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${crypto.randomUUID().slice(0, 8)}`,
      name: String(form.get("name") ?? "").trim(), category: String(form.get("category") ?? "Local served"),
      description: String(form.get("description") ?? "").trim(), tags, reliability: 0, completed: 0,
      status: "suspended", newcomer: true, provider: "Ollama on owner runtime",
      ownership: String(form.get("ownership") ?? "third-party/local-served"), modelTag,
      modelDigest: String(form.get("modelDigest") ?? "").trim() || "pending-runtime-verification",
      visibility: "private", selectableBy: "owner-only", verification: "registered-local",
      source: "Owner browser registration; runtime verification pending", license: String(form.get("license") ?? "pending metadata").trim(),
      ownerWallet: ownerWallet.toLowerCase(), createdAt: new Date().toISOString(),
    };
    try { await saveOwnerAgent(record); event.currentTarget.reset(); setMessage("Saved private metadata in this browser. It remains offline until your signed local Runtime reports the same model tag/digest."); }
    catch { setMessage("This browser could not open private Agent storage. Nothing was saved."); }
  }
  return <Localized><><PageHeader eyebrow="OWNER AGENT ONBOARDING" title="Register a local agent" description="Only non-sensitive metadata is stored in this browser and scoped to the connected wallet. API keys, Ollama URLs, model weights, prompts, and local paths are never stored here." /><Panel className="form-panel"><form onSubmit={(event) => void submit(event)} className="form-grid"><label>Agent name<input name="name" required minLength={3} /></label><label>Category<select name="category" required defaultValue="Local served"><option>Local owner-trained</option><option>Local served</option></select></label><label className="span-two">Agent description<textarea name="description" required rows={4} /></label><label>Capability tags<input name="tags" required placeholder="research, citations" /></label><label>Ownership<select name="ownership" defaultValue="third-party/local-served"><option value="owner-trained">Owner-trained</option><option value="third-party/local-served">Third-party / local-served</option></select></label><label>Ollama model tag<input name="modelTag" required placeholder="qwen3:30b-instruct" /></label><label>Model digest<input name="modelDigest" placeholder="Verified later by local Runtime" /></label><label className="span-two">License / source terms<input name="license" required placeholder="Apache-2.0, provider terms, or pending metadata" /></label><div className="form-actions span-two"><button className="button button-primary" disabled={!ownerWallet}>{ownerWallet ? "Save owner-only metadata" : "Connect MetaMask first"}</button></div></form>{message ? <div className="inline-state" role="status">{message}</div> : null}</Panel></></Localized>;
}

export function AgentDetailPage() {
  const { id } = useParams(); const agent = agents.find((item) => item.id === id) ?? agents[0]!;
  return <Localized><><PageHeader eyebrow="PUBLIC AGENT PROFILE" title={agent.name} description={agent.description} actions={<Badge tone={agent.verification === "verified" ? "cyan" : "amber"}>{(agent.verification ?? agent.status).toUpperCase()}</Badge>} /><div className="two-column"><Panel><h2>Capabilities</h2><div className="tag-row">{agent.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><div className="score-bars"><label>Readiness score<span style={{ width: `${agent.reliability}%` }} /></label><label>Credential exposure<span style={{ width: "0%" }} /></label><label>Browser Ollama exposure<span style={{ width: "0%" }} /></label><label>Verified operations<span style={{ width: `${Math.min(100, agent.completed * 25)}%` }} /></label><label>Catalog completeness<span style={{ width: agent.modelDigest ? "90%" : "45%" }} /></label></div></Panel><Panel><h2>Runtime boundary</h2><div className="health-line"><span className="status-dot" /> Public catalog: {agent.verification ?? "unknown"}</div><p className="muted">Provider: {agent.provider ?? "-"}<br />Ownership: {agent.ownership ?? "-"}<br />Model: {agent.modelTag ?? "-"}<br />Digest: {agent.modelDigest ?? "-"}</p><p className="muted">No API keys, local Ollama port, model weights, private paths, or raw sensitive prompts are exposed from this profile.</p><Link className="button button-ghost" to="/tasks/new">Create compatible task</Link></Panel></div></></Localized>;
}

export function TasksPage() {
  const [query, setQuery] = useState(""); const filtered = tasks.filter((task) => `${task.title} ${task.category} ${task.tags.join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  return <Localized><><PageHeader eyebrow="TASK MARKET" title="Open work with explicit settlement" description="Budgets are denominated in test YD and become open only after Sepolia escrow verification." actions={<Link className="button button-primary" to="/tasks/new">Publish task</Link>} /><DemoNotice /><FilterBar query={query} setQuery={setQuery} action={<Badge tone="neutral">{filtered.length} TASKS</Badge>} /><div className="task-list stagger">{filtered.map((task) => <Panel key={task.id} className="task-row"><div><Badge tone={task.status === "open" ? "cyan" : "indigo"}>{task.status.toUpperCase()}</Badge><h2>{task.title}</h2><p>{task.summary}</p><div className="tag-row">{task.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></div><div className="task-value"><strong>{task.budget} YD</strong><span>{task.due}</span><Link className="button button-ghost" to={`/tasks/${task.id}`}>Details</Link></div></Panel>)}</div></></Localized>;
}

export function TaskNewPage() {
  const [publishing, setPublishing] = useState<TaskPublishingState>(initialTaskPublishingState);
  const { step, message } = publishing;
  function validateDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPublishing((state) => reduceTaskPublishingState(state, "validated"));
  }
  function previewTransactionStates() {
    setPublishing((state) => reduceTaskPublishingState(state, "preview"));
  }
  return <Localized><><PageHeader eyebrow="TASK PUBLISHING" title="Fund a verifiable task" description="Publishing separates draft validation, YD approval, escrow submission, and independent RPC verification." /><Panel className="form-panel"><div className="stepper"><span className="active">1 Draft</span><span className={step !== "draft" ? "active" : ""}>2 Wallet</span><span className={step === "ready" ? "active" : ""}>3 Verify</span></div><form className="form-grid" onSubmit={validateDraft} onInvalid={() => setPublishing((state) => reduceTaskPublishingState(state, "invalid"))}><label className="span-two">Task title<input required /></label><label>Category<select required defaultValue="Research"><option>Research</option><option>Data</option><option>Content</option></select></label><label>Budget<input required type="number" min="1" step="1" /><span className="input-suffix">YD</span></label><label className="span-two">Acceptance criteria<textarea required rows={5} /></label><label>Completion window<input required placeholder="48 hours" /></label><label>Expert type<select required defaultValue="Research agent">{expertTypes.map((type) => <option key={type}>{type}</option>)}</select></label><div className="form-actions span-two"><button className="button button-primary">Validate draft</button><button type="button" className="button button-ghost" onClick={previewTransactionStates}>Preview transaction states</button></div></form><div className="inline-state" role="status" aria-live="polite">{message}</div><div className="transaction-rail"><div className={step !== "draft" ? "complete" : "active"}>Draft validated</div><div className={step === "wallet" ? "active" : step === "ready" ? "complete" : ""}>Await YD approval</div><div className={step === "ready" ? "active" : ""}>Escrow submitted</div><div className={step === "ready" ? "active" : ""}>RPC receipt verified</div></div></Panel></></Localized>;
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
