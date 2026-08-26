import { useState } from "react";
import type { TransactionIntentV1 } from "@agent-market/shared-contracts";

import { Badge, DemoNotice, PageHeader, Panel, Stat } from "../components/Ui";
import { Localized } from "../i18n/LanguageProvider";
import { authenticateWalletSession, createTransactionIntent, sendTransactionIntent, verifyTransactionIntent } from "../lib/chainClient";

export function DashboardPage() {
  return <Localized><><PageHeader eyebrow="MULTI-ROLE DASHBOARD" title="One view across work and settlement" description="Fixture cards demonstrate the publisher, agent, and committee perspectives without claiming deployed activity." /><DemoNotice /><div className="stats-grid"><Stat label="Draft tasks" value="2" note="Local fixture" /><Stat label="Active agents" value="1" note="Local fixture" tone="cyan" /><Stat label="Verified transactions" value="0" note="External evidence required" tone="amber" /></div><div className="two-column"><Panel><h2>My work</h2><div className="activity-list"><div><Badge tone="cyan">WORKING</Badge><strong>Normalize product feedback</strong><span>Submission due in 24 hours</span></div><div><Badge tone="neutral">DRAFT</Badge><strong>Research market brief</strong><span>Escrow not submitted</span></div></div></Panel><Panel><h2>Request trace lookup</h2><input placeholder="Paste a request ID" /><button className="button button-ghost">Lookup unavailable offline</button><p className="muted">Production lookup will correlate API, event, match, training, and transaction records.</p></Panel></div></></Localized>;
}

export function CommitteePage({ initialConflictStatus = "pending", walletAddress = null }: { initialConflictStatus?: "pending" | "declared"; walletAddress?: string | null } = {}) {
  const [conflictStatus, setConflictStatus] = useState(initialConflictStatus);
  const [resourceId, setResourceId] = useState("");
  const [agentWins, setAgentWins] = useState(true);
  const [message, setMessage] = useState("No externally verified case is loaded.");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<null | { intent: TransactionIntentV1; txHash: string }>(null);
  const declared = conflictStatus === "declared";

  async function castVote() {
    if (!declared) { setMessage("Declare conflicts before voting."); return; }
    if (!walletAddress) { setMessage("Connect the committee wallet first."); return; }
    if (!/^[0-9a-fA-F-]{36}$/u.test(resourceId)) { setMessage("Enter a valid task resource UUID."); return; }
    if (!window.confirm("Sepolia test vote: this is immutable after confirmation and may spend test gas. Committee membership and task state are checked by the server. Continue?")) return;
    setBusy(true);
    try {
      await authenticateWalletSession(walletAddress);
      const intent = await createTransactionIntent(resourceId, "castVote", { agentWins });
      const txHash = await sendTransactionIntent(intent, walletAddress);
      setPending({ intent, txHash });
      setMessage("Vote submitted. No ruling is claimed until RPC receipt and VoteCast event verification.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "COMMITTEE_VOTE_FAILED");
    } finally {
      setBusy(false);
    }
  }

  async function recheckVote() {
    if (!pending) return;
    setBusy(true);
    try {
      const checked = await verifyTransactionIntent(pending.intent.intentId, pending.txHash);
      if (checked.verification.status === "confirmed") {
        setMessage("VoteCast receipt and event verified. The contract determines whether the 2-of-3 ruling threshold is reached.");
        setPending(null);
      } else setMessage("Vote verification status: " + checked.verification.status + ". No ruling has been claimed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "CHAIN_VERIFY_FAILED");
    } finally {
      setBusy(false);
    }
  }

  return <Localized><><PageHeader eyebrow="ARBITRATION COMMITTEE" title="Conflict-aware case queue" description="Three valid seats, immutable votes, and a two-vote ruling threshold are enforced by the settlement boundary." /><DemoNotice /><div className="committee-grid"><Panel className="seat-card"><Badge tone={declared ? "cyan" : "amber"}>{declared ? "DECLARATION RECORDED" : "ACTION REQUIRED"}</Badge><h2>Conflict declaration</h2><p role="status" aria-live="polite">{declared ? "Conflict declaration recorded locally. No vote or blockchain transaction was submitted." : "Review relationships before opening the evidence packet."}</p><button type="button" className="button button-primary" disabled={declared} onClick={() => setConflictStatus("declared")}>{declared ? "No conflict declared" : "Declare no conflict"}</button></Panel><Panel className="seat-card"><Badge tone="amber">ROLE GATED</Badge><h2>Cast an immutable vote</h2><label>Task resource ID<input value={resourceId} onChange={(event) => setResourceId(event.target.value)} placeholder="UUID from the verified task" /></label><label>Outcome<select value={agentWins ? "agent" : "publisher"} onChange={(event) => setAgentWins(event.target.value === "agent")}><option value="agent">Agent wins</option><option value="publisher">Publisher wins</option></select></label><button type="button" className="button button-warning" disabled={busy || !declared || !walletAddress} onClick={() => void castVote()}>Cast Sepolia vote</button><button type="button" className="button button-ghost" disabled={busy || !pending} onClick={() => void recheckVote()}>Recheck RPC receipt</button><small>Committee membership is checked server-side; the browser cannot grant this role.</small></Panel><Panel className="seat-card"><Badge tone="cyan">RULE</Badge><h2>2 of 3</h2><p>A ruling forms only when the contract reaches two valid aligned votes.</p><div className="inline-state" role="status" aria-live="polite">{message}</div></Panel></div></></Localized>;
}

export function OpsPage() {
  return <Localized><><PageHeader eyebrow="READ-ONLY AI OPS" title="Observe first. Suggest second." description="This surface may explain incidents, but cannot deploy, scale, transfer funds, vote, or change production resources." /><div className="ops-grid"><Panel><div className="panel-heading"><h2>Runtime readiness</h2><Badge tone="amber">LOCAL ONLY</Badge></div>{[["Transaction Engine", "Local build pending full gate"], ["Go matcher", "Local tests available"], ["CTR trainer", "Local tests available"], ["AWS workload", "Not deployed"], ["Cloudflare", "Not deployed"]].map(([name, state]) => <div className="health-row" key={name}><strong>{name}</strong><span>{state}</span></div>)}</Panel><Panel><div className="panel-heading"><h2>Model lifecycle</h2><Badge tone="neutral">NO ACTIVE MODEL</Badge></div><div className="model-stage"><span>training samples</span><span>candidate</span><span>manual approval</span><span>active</span></div><p className="muted">A local logistic-regression protocol exists. ECS execution and model readback remain external work.</p></Panel><Panel className="span-two"><h2>AI Ops recommendation contract</h2><div className="recommendation"><div><span>Observed symptom</span><strong>No live telemetry</strong></div><div><span>Evidence</span><strong>AWS and Cloudflare are not connected to this page</strong></div><div><span>Recommended action</span><strong>Complete read-only inventory before deployment</strong></div><div><span>Uncertainty</span><strong>High until external readback exists</strong></div></div></Panel></div></></Localized>;
}
