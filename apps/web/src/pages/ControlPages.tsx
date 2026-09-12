import { useEffect, useState } from "react";
import type { TransactionIntentV1 } from "@agent-market/shared-contracts";

import { Badge, DemoNotice, PageHeader, Panel, Stat } from "../components/Ui";
import { Localized, useLanguage } from "../i18n/LanguageProvider";
import { GovernancePanel } from "../governance/GovernancePanel";
import {
  authenticateWalletSession, completeArbitrationReview, createTransactionIntent,
  readArbitrationReview, sendTransactionIntent, verifyTransactionIntent,
  type ArbitrationReviewRecord,
} from "../lib/chainClient";

export function DashboardPage() {
  return <Localized><><PageHeader eyebrow="MULTI-ROLE DASHBOARD" title="One view across work and settlement" description="Fixture cards demonstrate the publisher, agent, and committee perspectives without claiming deployed activity." /><DemoNotice /><div className="stats-grid dashboard-stats"><Stat label="Draft tasks" value="2" note="Local fixture" /><Stat label="Active agents" value="1" note="Local fixture" tone="cyan" /><Stat label="Verified transactions" value="0" note="External evidence required" tone="amber" /></div><div className="two-column dashboard-workspace"><Panel><h2>My work</h2><div className="activity-list"><div><Badge tone="cyan">WORKING</Badge><strong>Normalize product feedback</strong><span>Submission due in 24 hours</span></div><div><Badge tone="neutral">DRAFT</Badge><strong>Research market brief</strong><span>Escrow not submitted</span></div></div></Panel><Panel className="trace-panel"><h2>Request trace lookup</h2><input placeholder="Paste a request ID" /><button className="button button-ghost" disabled>Lookup unavailable offline</button><p className="muted">Production lookup will correlate API, event, match, training, and transaction records.</p></Panel></div></></Localized>;
}

export function reviewMatchesSelection(review: ArbitrationReviewRecord | null, resourceId: string, agentsWin: boolean, walletAddress: string | null, now = Date.now()): boolean {
  return review !== null && walletAddress !== null
    && review.resourceId === resourceId.trim().toLowerCase()
    && review.agentsWin === agentsWin
    && review.args.agentsWin === agentsWin
    && review.reviewerWallet === walletAddress.toLowerCase()
    && Date.parse(review.expiresAt) > now;
}

export function arbitrationErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && ["AUTH_REAUTH_REQUIRED", "AUTH_WALLET_CHANGED", "CHAIN_ID_MISMATCH"].includes(error.message)) {
    return "Wallet session does not match the connected account. Reauthenticate before loading the platform review.";
  }
  return fallback;
}

export function CommitteePage({ walletAddress = null }: { walletAddress?: string | null } = {}) {
  const [resourceId, setResourceId] = useState("");
  const [agentWins, setAgentWins] = useState(true);
  const [message, setMessage] = useState("No persisted review loaded.");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<null | { intent: TransactionIntentV1; txHash: string }>(null);
  const [review, setReview] = useState<ArbitrationReviewRecord | null>(null);
  const validResourceId = /^[0-9a-fA-F-]{36}$/u.test(resourceId);
  const declared = reviewMatchesSelection(review, resourceId, agentWins, walletAddress);

  useEffect(() => {
    setReview(null);
    setPending(null);
    if (!validResourceId || !walletAddress) return;
    let active = true;
    void readArbitrationReview(resourceId, walletAddress).then((loaded) => {
      if (!active) return;
      setReview(loaded);
      setMessage(loaded ? "Persisted platform review loaded from the server." : "No persisted review loaded.");
    }).catch((error) => {
      if (!active) return;
      setReview(null);
      setMessage(arbitrationErrorMessage(error, "Unable to load the platform review. Reauthenticate and try again."));
    });
    return () => { active = false; };
  }, [agentWins, resourceId, validResourceId, walletAddress]);

  async function completeReview() {
    if (!walletAddress) { setMessage("Connect the configured platform arbiter wallet first."); return; }
    if (!validResourceId) { setMessage("Enter a valid task resource UUID."); return; }
    setBusy(true);
    setReview(null);
    try {
      await authenticateWalletSession(walletAddress);
      const persisted = await completeArbitrationReview(resourceId, agentWins);
      setReview(persisted);
      setMessage("Platform review persisted by the server. No blockchain transaction was submitted.");
    } catch (error) {
      setReview(null);
      setMessage(arbitrationErrorMessage(error, "Unable to persist the platform review. No blockchain transaction was submitted."));
    } finally {
      setBusy(false);
    }
  }

  async function resolveTask() {
    if (!declared) { setMessage("Complete the platform conflict review before final arbitration."); return; }
    if (!walletAddress) { setMessage("Connect the configured platform arbiter wallet first."); return; }
    if (!validResourceId) { setMessage("Enter a valid task resource UUID."); return; }
    if (!window.confirm("Sepolia V3 final arbitration: this resolution is immutable after confirmation and may transfer test YD or forfeit Agent stake. Only the configured platform arbiter wallet is authorized. Continue?")) return;
    setBusy(true);
    try {
      await authenticateWalletSession(walletAddress);
      const intent = await createTransactionIntent(resourceId, "resolveWorkflowTask", { agentsWin: agentWins });
      const txHash = await sendTransactionIntent(intent, walletAddress);
      setPending({ intent, txHash });
      setMessage("Final resolution submitted. No ruling is claimed until RPC receipt and TaskResolved event verification.");
    } catch (error) {
      setMessage(arbitrationErrorMessage(error, "Unable to prepare final arbitration. No blockchain transaction was submitted."));
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
      } else setMessage("Resolution remains unconfirmed. No ruling has been claimed.");
    } catch (error) {
      setMessage(arbitrationErrorMessage(error, "Unable to verify the resolution. No ruling has been claimed."));
    } finally {
      setBusy(false);
    }
  }

  return <Localized><><PageHeader eyebrow="PLATFORM FINAL ARBITRATION" title="One accountable final ruling" description="V3 uses one configured platform arbiter wallet. The browser cannot grant the role, and only a verified TaskResolved receipt advances the case." /><div className="committee-grid committee-resolution-grid"><Panel className="seat-card review-card"><Badge tone={declared ? "cyan" : "amber"}>{declared ? "REVIEW RECORDED" : "ACTION REQUIRED"}</Badge><h2>Conflict and evidence review</h2><p role="status" aria-live="polite">{declared ? "Persisted platform review matches the current resource revision, wallet, and outcome." : "No persisted review loaded. Review the case evidence before enabling final arbitration."}</p><button type="button" className="button button-primary" disabled={busy || declared || !walletAddress || !validResourceId} onClick={() => void completeReview()}>{declared ? "Review complete" : "Complete review"}</button></Panel><Panel className="seat-card arbiter-action-card"><Badge tone="amber">SOLE ROLE GATE</Badge><h2>Resolve the V3 task</h2><div className="arbiter-form"><label>Task resource ID<input value={resourceId} onChange={(event) => setResourceId(event.target.value)} placeholder="UUID from the verified V3 task" /></label><label>Outcome<select value={agentWins ? "agent" : "publisher"} onChange={(event) => setAgentWins(event.target.value === "agent")}><option value="agent">Agents win</option><option value="publisher">Publisher wins</option></select></label></div><div className="button-row"><button type="button" className="button button-warning" disabled={busy || !declared || !walletAddress} onClick={() => void resolveTask()}>Resolve on Sepolia</button><button type="button" className="button button-ghost" disabled={busy || !pending} onClick={() => void recheckResolution()}>Recheck RPC receipt</button></div><small>The server requires the configured platform arbiter wallet and the V3 Workflow Escrow address.</small></Panel><Panel className="seat-card rule-card"><Badge tone="cyan">V3 RULE</Badge><h2>Single final arbiter</h2><p>The final ruling is not a model vote or majority poll. Legacy V2 committee voting remains historical and cannot resolve a V3 task.</p><div className="inline-state" role="status" aria-live="polite">{message}</div></Panel></div></></Localized>;
}

export function OpsPage({ walletAddress = null }: { walletAddress?: string | null } = {}) {
  const { locale } = useLanguage();
  const copy = (en: string, zh: string) => locale === "zh-CN" ? zh : en;
  return <>
    <PageHeader eyebrow="OPERATIONS / GOVERNANCE"
      title={copy("Observe first. Review before acting.", "先观察，再复核操作。")}
      description={copy("Telemetry is read-only. Governance requests require server-authorized roles and do not deploy infrastructure or transfer funds.", "监控区域只读；治理请求由服务端校验角色，不部署基础设施，也不执行资金转移。")}/>
    <div className="ops-grid">
      <Panel><div className="panel-heading"><h2>{copy("Runtime visibility", "Runtime 状态可见性")}</h2><Badge tone="amber">{copy("NOT QUERIED", "尚未查询")}</Badge></div>
        {["Transaction Engine", "Go matcher", "CTR trainer", "AWS", "Cloudflare"].map(name => <div className="health-row" key={name}><strong>{name}</strong><span>{copy("No live readback on this page", "本页未读取实时状态")}</span></div>)}
        <p className="muted">{copy("Missing telemetry does not mean a service is undeployed or offline. Dated delivery records remain on Evidence.", "未接监控不代表服务未部署或离线。带日期的交付记录请查看 Evidence。")}</p>
      </Panel>
      <Panel><div className="panel-heading"><h2>{copy("Model lifecycle", "模型生命周期")}</h2><Badge tone="neutral">{copy("STATUS UNVERIFIED", "当前状态未核验")}</Badge></div>
        <div className="model-stage">{[["training samples", "训练样本"], ["candidate", "候选模型"], ["manual approval", "人工审批"], ["active", "启用"]].map(([en, zh]) => <span key={en}>{copy(en!, zh!)}</span>)}</div>
        <p className="muted">{copy("These are lifecycle stages, not proof of a running training job or an approved production model.", "这里展示生命周期阶段，不代表正在训练或已有通过审批的生产模型。")}</p>
      </Panel>
    </div>
    <GovernancePanel walletAddress={walletAddress}/>
  </>;
}
