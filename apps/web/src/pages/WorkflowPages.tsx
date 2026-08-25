import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Badge, DemoNotice, PageHeader, Panel } from "../components/Ui";
import { Localized } from "../i18n/LanguageProvider";
import { calculateLinearYield, SECONDS_PER_YEAR } from "../lib/domain";
import { filterOfficeDesks, visibleDeskForWallet, type OfficeTaskDesk, type OfficeTaskStatus } from "../officeModel";

export function WorkspacePage({ walletAddress = null }: { walletAddress?: string | null }) {
  const { id } = useParams();
  const [filter, setFilter] = useState<"all" | OfficeTaskStatus>("all");
  const [selectedTaskId, setSelectedTaskId] = useState(id ?? "task-office-build");
  const ownerWallet = walletAddress ?? "0x1111111111111111111111111111111111111111";
  const desks = useMemo<OfficeTaskDesk[]>(() => [
    {
      taskId: "task-office-build",
      ownerWallet,
      ownerLabel: "My workspace",
      title: "Build the Agent Market workflow",
      category: "Code",
      tags: ["langgraph", "graphql", "gates"],
      status: "in_progress",
      agents: [
        { agentId: "personal-code-agent", displayName: "Code Agent", role: "executor", score: 30 },
        { agentId: "qwen-qwen-plus", displayName: "Qwen Plus", role: "judge", score: 90 },
        { agentId: "zhipu-glm-5-3", displayName: "GLM 5.3", role: "arbiter", score: 90 },
      ],
      nodeInput: "Private task node input stays inside the authorized AWS execution envelope.",
      nodeOutput: "Latest private node output is available to the owner only.",
      downloadableResult: "Agent Market task result\nstatus=in_progress\nworkflow=LangGraph\n",
    },
    {
      taskId: "task-visual-review",
      ownerWallet: "0x2222222222222222222222222222222222222222",
      ownerLabel: "Studio 02",
      title: "Review visual assets",
      category: "Image",
      tags: ["image", "visual-qa"],
      status: "in_progress",
      agents: [
        { agentId: "personal-image-agent", displayName: "Image Agent", role: "creator", score: 30 },
        { agentId: "deepseek-deepseek-v4-flash", displayName: "DeepSeek", role: "reviewer", score: 92 },
      ],
      nodeInput: "private",
      nodeOutput: "private",
    },
    {
      taskId: "task-research-closed",
      ownerWallet: "0x3333333333333333333333333333333333333333",
      ownerLabel: "Lab 03",
      title: "Research market architecture",
      category: "Research",
      tags: ["research", "citations"],
      status: "completed",
      agents: [{ agentId: "kimi-kimi-k2-7-code", displayName: "Kimi", role: "researcher", score: 91 }],
    },
  ], [ownerWallet]);
  const filtered = filterOfficeDesks(desks, filter);
  const selectedDesk = visibleDeskForWallet(desks.find((desk) => desk.taskId === selectedTaskId) ?? desks[0]!, walletAddress ?? ownerWallet);
  const downloadHref = selectedDesk.downloadableResult === undefined
    ? undefined
    : `data:text/plain;charset=utf-8,${encodeURIComponent(selectedDesk.downloadableResult)}`;

  return <Localized><><PageHeader eyebrow="VIRTUAL OFFICE / WEB PROTOTYPE" title="One task, one desk" description="Only in-progress and completed projects appear here. The Web interaction prototype is implemented; Cocos has not started and remains planned." actions={<Badge tone="cyan">{filtered.length} DESKS</Badge>} /><DemoNotice /><div className="office-tabs" role="tablist" aria-label="Task desk status">{(["all", "in_progress", "completed"] as const).map((status) => <button type="button" role="tab" aria-selected={filter === status} className={filter === status ? "active" : ""} onClick={() => setFilter(status)} key={status}>{status.replace("_", " ")}</button>)}</div><div className="office-layout"><section className="office-scene" aria-label="Virtual task office">{filtered.map((desk) => <button type="button" className={`office-desk ${desk.status} ${selectedTaskId === desk.taskId ? "selected" : ""}`} onClick={() => setSelectedTaskId(desk.taskId)} key={desk.taskId}><span className="desk-owner">{desk.ownerLabel}</span><strong>{desk.title}</strong><small>{desk.category} / {desk.status.replace("_", " ")}</small><span className="office-agent-row">{desk.agents.map((agent) => <span className="office-agent-sprite" title={`${agent.displayName} / ${agent.role}`} key={agent.agentId}><i>{agent.displayName.slice(0, 2).toUpperCase()}</i><b>{agent.role}</b></span>)}</span><span className="desk-visit">{desk.ownerWallet.toLowerCase() === ownerWallet.toLowerCase() ? "My desk" : "Visit desk"}</span></button>)}</section><Panel className="office-inspector"><Badge tone={selectedDesk.access === "owner" ? "cyan" : "neutral"}>{selectedDesk.access}</Badge><h2>{selectedDesk.title}</h2><p>{selectedDesk.ownerLabel} / {selectedDesk.category}</p><div className="tag-row">{selectedDesk.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>{selectedDesk.access === "owner" ? <><h3>Authorized node boundary</h3><p className="muted">{selectedDesk.nodeInput}</p><p className="muted">{selectedDesk.nodeOutput}</p>{downloadHref ? <a className="button button-primary" href={downloadHref} download={`${selectedDesk.taskId}-result.txt`}>Download my result</a> : null}</> : <><h3>Visitor mode</h3><p className="muted">Only public desk status, tags, roles, and presence animations are visible. Node input/output and result downloads are removed before rendering.</p></>}<Link className="text-link" to={`/tasks/${selectedDesk.taskId}`}>Open public task profile</Link></Panel></div></></Localized>;
}

export function DisputePage() {
  const { id } = useParams(); const [votes, setVotes] = useState(1);
  return <Localized><><PageHeader eyebrow={`DISPUTE / ${id ?? "CASE"}`} title="Committee ruling" description="Exactly three valid seats are assigned. Two aligned votes form a ruling; conflicts trigger replacement." actions={<Badge tone="amber">VOTING</Badge>} /><DemoNotice /><div className="committee-grid">{[1, 2, 3].map((seat) => <Panel key={seat} className="seat-card"><span>SEAT 0{seat}</span><h2>{seat === 3 ? "Replacement ready" : `Arbitrator ${seat}`}</h2><Badge tone={seat <= votes ? "cyan" : "neutral"}>{seat <= votes ? "VOTED" : "PENDING"}</Badge><button className="button button-ghost" onClick={() => setVotes(Math.min(3, votes + 1))}>Record demo vote</button></Panel>)}</div><Panel className="ruling-bar"><div><span>Current threshold</span><strong>{votes} / 2 votes</strong></div><div className="vote-meter"><span style={{ width: `${Math.min(100, votes * 50)}%` }} /></div><p>No contract action is executed from this demo state.</p></Panel></></Localized>;
}

export function StakingPage() {
  const [principal, setPrincipal] = useState(5_000); const annual = useMemo(() => calculateLinearYield(principal, SECONDS_PER_YEAR), [principal]);
  return <Localized><><PageHeader eyebrow="YD STAKING" title="Six percent. Linear. Test-only." description="Yield is floor-rounded per second and funded by a separate Sepolia test pool. It is not a real return." actions={<Badge tone="amber">SIMULATED YIELD</Badge>} /><div className="staking-layout"><Panel className="yield-visual"><span className="eyebrow">LINEAR MODEL</span><strong>{principal.toLocaleString()} YD</strong><div className="yield-line"><span /></div><dl><div><dt>1 year</dt><dd>+{annual.toLocaleString()} YD</dd></div><div><dt>5 years</dt><dd>+{(annual * 5).toLocaleString()} YD</dd></div><div><dt>Formula</dt><dd>principal x 6% x time</dd></div></dl></Panel><Panel className="stake-control"><h2>Position calculator</h2><label>Principal<input type="range" min="100" max="25000" step="100" value={principal} onChange={(event) => setPrincipal(Number(event.target.value))} /></label><div className="amount-readout">{principal.toLocaleString()} <span>YD</span></div><button className="button button-primary" disabled>Stake after contract verification</button><small>No wallet transaction is available until a deployed contract is externally verified.</small></Panel></div></></Localized>;
}
