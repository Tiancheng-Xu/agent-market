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
  const [message, setMessage] = useState("No externally verified V3 dispute is loaded.");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<null | { intent: TransactionIntentV1; txHash: string }>(null);
  const declared = conflictStatus === "declared";

  async function resolveTask() {
    if (!declared) { setMessage("Complete the platform conflict review before final arbitration."); return; }
    if (!walletAddress) { setMessage("Connect the configured platform arbiter wallet first."); return; }
    if (!/^[0-9a-fA-F-]{36}$/u.test(resourceId)) { setMessage("Enter a valid task resource UUID."); return; }
    if (!window.confirm("Sepolia V3 final arbitration: this resolution is immutable after confirmation and may transfer test YD or forfeit Agent stake. Only the configured platform arbiter wallet is authorized. Continue?")) return;
    setBusy(true);
    try {
      await authenticateWalletSession(walletAddress);
      const intent = await createTransactionIntent(resourceId, "resolveWorkflowTask", { agentsWin: agentWins });
      const txHash = await sendTransactionIntent(intent, walletAddress);
      setPending({ intent, txHash });
      setMessage("Final resolution submitted. No ruling is claimed until RPC receipt and TaskResolved event verification.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "PLATFORM_ARBITRATION_FAILED");
    } finally {
      setBusy(false);
    }
  }

  async function recheckResolution() {
    if (!pending) return;
    setBusy(true);
    try {
      const checked = await verifyTransactionIntent(pending.intent.intentId, pending.txHash);
      if (checked.verification.status === "confirmed") {
        setMessage("TaskResolved receipt and event verified. The V3 Workflow Escrow result is now externally verified.");
        setPending(null);
      } else setMessage("Resolution verification status: " + checked.verification.status + ". No ruling has been claimed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "CHAIN_VERIFY_FAILED");
    } finally {
      setBusy(false);
    }
  }

  return <Localized><><PageHeader eyebrow="PLATFORM FINAL ARBITRATION" title="One accountable final ruling" description="V3 uses one configured platform arbiter wallet. The browser cannot grant the role, and only a verified TaskResolved receipt advances the case." /><div className="committee-grid"><Panel className="seat-card"><Badge tone={declared ? "cyan" : "amber"}>{declared ? "REVIEW RECORDED" : "ACTION REQUIRED"}</Badge><h2>Conflict and evidence review</h2><p role="status" aria-live="polite">{declared ? "Platform review recorded locally. No resolution or blockchain transaction was submitted." : "Review the case evidence, relationships, and deterministic Gates before enabling final arbitration."}</p><button type="button" className="button button-primary" disabled={declared} onClick={() => setConflictStatus("declared")}>{declared ? "Review complete" : "Complete review"}</button></Panel><Panel className="seat-card"><Badge tone="amber">SOLE ROLE GATE</Badge><h2>Resolve the V3 task</h2><label>Task resource ID<input value={resourceId} onChange={(event) => setResourceId(event.target.value)} placeholder="UUID from the verified V3 task" /></label><label>Outcome<select value={agentWins ? "agent" : "publisher"} onChange={(event) => setAgentWins(event.target.value === "agent")}><option value="agent">Agents win</option><option value="publisher">Publisher wins</option></select></label><button type="button" className="button button-warning" disabled={busy || !declared || !walletAddress} onClick={() => void resolveTask()}>Resolve on Sepolia</button><button type="button" className="button button-ghost" disabled={busy || !pending} onClick={() => void recheckResolution()}>Recheck RPC receipt</button><small>The server requires the configured platform arbiter wallet and the V3 Workflow Escrow address.</small></Panel><Panel className="seat-card"><Badge tone="cyan">V3 RULE</Badge><h2>Single final arbiter</h2><p>The final ruling is not a model vote or majority poll. Legacy V2 committee voting remains historical and cannot resolve a V3 task.</p><div className="inline-state" role="status" aria-live="polite">{message}</div></Panel></div></></Localized>;
}

export function OpsPage() {
  return <Localized><><PageHeader eyebrow="READ-ONLY AI OPS" title="Observe first. Suggest second." description="This surface may explain incidents, but cannot deploy, scale, transfer funds, vote, or change production resources." /><div className="ops-grid"><Panel><div className="panel-heading"><h2>Runtime readiness</h2><Badge tone="amber">LOCAL ONLY</Badge></div>{[["Transaction Engine", "Local build pending full gate"], ["Go matcher", "Local tests available"], ["CTR trainer", "Local tests available"], ["AWS workload", "Not deployed"], ["Cloudflare", "Not deployed"]].map(([name, state]) => <div className="health-row" key={name}><strong>{name}</strong><span>{state}</span></div>)}</Panel><Panel><div className="panel-heading"><h2>Model lifecycle</h2><Badge tone="neutral">NO ACTIVE MODEL</Badge></div><div className="model-stage"><span>training samples</span><span>candidate</span><span>manual approval</span><span>active</span></div><p className="muted">A local logistic-regression protocol exists. ECS execution and model readback remain external work.</p></Panel><Panel className="span-two"><h2>AI Ops recommendation contract</h2><div className="recommendation"><div><span>Observed symptom</span><strong>No live telemetry</strong></div><div><span>Evidence</span><strong>AWS and Cloudflare are not connected to this page</strong></div><div><span>Recommended action</span><strong>Complete read-only inventory before deployment</strong></div><div><span>Uncertainty</span><strong>High until external readback exists</strong></div></div></Panel></div></></Localized>;
}
