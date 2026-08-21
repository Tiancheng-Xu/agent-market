import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Badge, DemoNotice, PageHeader, Panel } from "../components/Ui";
import { Localized } from "../i18n/LanguageProvider";
import { calculateLinearYield, SECONDS_PER_YEAR } from "../lib/domain";

export function WorkspacePage() {
  const { id } = useParams(); const [state, setState] = useState<"working" | "submitted">("working");
  return <Localized><><PageHeader eyebrow={`WORKSPACE / ${id ?? "TASK"}`} title="Task execution room" description="Messages, submissions, acceptance, and transaction verification stay attached to one request ID." actions={<Badge tone={state === "working" ? "cyan" : "amber"}>{state.toUpperCase()}</Badge>} /><DemoNotice /><div className="workspace-grid"><Panel><div className="timeline compact"><span className="done">Matched</span><span className="active">Working</span><span className={state === "submitted" ? "active" : ""}>Review</span><span>Settled</span></div><h2>Submission checklist</h2><label className="dropzone"><input type="file" /><strong>Attach a deliverable</strong><span>Local preview only. Upload backend is not connected.</span></label><textarea rows={6} placeholder="Add a concise handoff note" /><button className="button button-primary" onClick={() => setState("submitted")}>Submit work for review</button></Panel><Panel className="trace-panel"><h2>Request trace</h2><dl><div><dt>Request ID</dt><dd>Generated when backend accepts command</dd></div><div><dt>Escrow transaction</dt><dd>Awaiting external receipt</dd></div><div><dt>Settlement</dt><dd>Not submitted</dd></div></dl><Link className="text-link" to="/evidence">Open Evidence model</Link></Panel></div></></Localized>;
}

export function DisputePage() {
  const { id } = useParams(); const [votes, setVotes] = useState(1);
  return <Localized><><PageHeader eyebrow={`DISPUTE / ${id ?? "CASE"}`} title="Committee ruling" description="Exactly three valid seats are assigned. Two aligned votes form a ruling; conflicts trigger replacement." actions={<Badge tone="amber">VOTING</Badge>} /><DemoNotice /><div className="committee-grid">{[1, 2, 3].map((seat) => <Panel key={seat} className="seat-card"><span>SEAT 0{seat}</span><h2>{seat === 3 ? "Replacement ready" : `Arbitrator ${seat}`}</h2><Badge tone={seat <= votes ? "cyan" : "neutral"}>{seat <= votes ? "VOTED" : "PENDING"}</Badge><button className="button button-ghost" onClick={() => setVotes(Math.min(3, votes + 1))}>Record demo vote</button></Panel>)}</div><Panel className="ruling-bar"><div><span>Current threshold</span><strong>{votes} / 2 votes</strong></div><div className="vote-meter"><span style={{ width: `${Math.min(100, votes * 50)}%` }} /></div><p>No contract action is executed from this demo state.</p></Panel></></Localized>;
}

export function StakingPage() {
  const [principal, setPrincipal] = useState(5_000); const annual = useMemo(() => calculateLinearYield(principal, SECONDS_PER_YEAR), [principal]);
  return <Localized><><PageHeader eyebrow="YD STAKING" title="Six percent. Linear. Test-only." description="Yield is floor-rounded per second and funded by a separate Sepolia test pool. It is not a real return." actions={<Badge tone="amber">SIMULATED YIELD</Badge>} /><div className="staking-layout"><Panel className="yield-visual"><span className="eyebrow">LINEAR MODEL</span><strong>{principal.toLocaleString()} YD</strong><div className="yield-line"><span /></div><dl><div><dt>1 year</dt><dd>+{annual.toLocaleString()} YD</dd></div><div><dt>5 years</dt><dd>+{(annual * 5).toLocaleString()} YD</dd></div><div><dt>Formula</dt><dd>principal x 6% x time</dd></div></dl></Panel><Panel className="stake-control"><h2>Position calculator</h2><label>Principal<input type="range" min="100" max="25000" step="100" value={principal} onChange={(event) => setPrincipal(Number(event.target.value))} /></label><div className="amount-readout">{principal.toLocaleString()} <span>YD</span></div><button className="button button-primary" disabled>Stake after contract verification</button><small>No wallet transaction is available until a deployed contract is externally verified.</small></Panel></div></></Localized>;
}
