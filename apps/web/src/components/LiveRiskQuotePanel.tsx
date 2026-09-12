import { useLayoutEffect, useRef, useState } from "react";
import { useLanguage } from "../i18n/LanguageProvider";
import { confirmCurrentRiskQuote, createCurrentRiskQuote, loadCurrentRiskQuote, refreshCurrentRiskQuote } from "../lib/riskQuoteFlow";
import type { BrowserRiskQuote } from "../lib/riskPricingClient";
import type { QuoteConfirmationIntent } from "../riskPricingPresentation";
import { Panel } from "./Ui";
import "./LiveRiskQuotePanel.css";

const riskFactors = [
  ["任务复杂度", "Complexity", "步骤、协作与技术难度越高，交付的不确定性越大。", "More steps, coordination and technical difficulty increase delivery uncertainty."],
  ["验收歧义", "Acceptance ambiguity", "验收标准不明确，容易产生返工和争议。", "Unclear acceptance criteria increase rework and dispute risk."],
  ["外部依赖", "External dependency", "第三方接口、服务或数据可能延迟或不可用。", "Third-party APIs, services or data may be delayed or unavailable."],
  ["数据敏感性", "Data sensitivity", "涉及隐私或敏感数据时，需要更严格的访问与处理控制。", "Private or sensitive data requires stricter access and handling controls."],
  ["资金风险", "Financial risk", "涉及的资金和潜在损失越大，风险越高。", "Larger financial exposure and potential losses increase risk."],
  ["不可逆性", "Irreversibility", "难以撤销或恢复的操作，会放大失败后的影响。", "Actions that are difficult to undo amplify the impact of failures."],
  ["期限风险", "Deadline risk", "时间越紧、缓冲越少，超期风险越大。", "Tighter deadlines and less buffer increase the risk of late delivery."],
  ["Agent 不确定性", "Agent uncertainty", "能力匹配、交付历史与验证证据不足时，结果更难预测。", "Limited capability fit, delivery history or verification evidence makes outcomes less predictable."],
] as const;

// Each mounted task/wallet owns a session. Timers and late promises lose authority
// on expiry, replacement, or unmount; reset() alone cannot cancel a promise.
export function createRiskQuoteSession(notify: (context: QuoteConfirmationIntent | null) => void, onExpire: () => void) {
  let generation = 0;
  let active = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const invalidate = () => { generation += 1; notify(null); };
  return {
    activate() { active = true; invalidate(); },
    begin() { invalidate(); return generation; },
    isCurrent(token: number) { return active && token === generation; },
    publish(token: number, expiresAt: string, context: QuoteConfirmationIntent | null) {
      if (!active || token !== generation) return false;
      if (!(Date.parse(expiresAt) > Date.now())) return false;
      notify(context);
      return true;
    },
    watchExpiry(expiresAt?: string) {
      clearTimer();
      if (!expiresAt) return;
      const tick = () => {
        if (!active) return;
        const remaining = Date.parse(expiresAt) - Date.now();
        if (!(remaining > 0)) { invalidate(); onExpire(); return; }
        timer = setTimeout(tick, Math.min(remaining, 2_147_483_647));
      };
      tick();
    },
    dispose() { active = false; clearTimer(); invalidate(); },
  };
}

type Props = {
  taskId: string;
  walletAddress: string | null;
  canRequote?: boolean;
  onFundingReady: (context: QuoteConfirmationIntent | null) => void;
};

export function LiveRiskQuotePanel(props: Props) {
  return <RiskQuoteSessionPanel key={JSON.stringify([props.taskId, props.walletAddress])} {...props} />;
}

function RiskQuoteSessionPanel({ taskId, walletAddress, canRequote = false, onFundingReady }: Props) {
  const { locale } = useLanguage();
  const zh = locale === "zh-CN";
  const [record, setRecord] = useState<BrowserRiskQuote>();
  const [result, setResult] = useState<Awaited<ReturnType<typeof refreshCurrentRiskQuote>>>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [expired, setExpired] = useState(false);
  const [missing, setMissing] = useState(false);
  const notifyRef = useRef(onFundingReady);
  useLayoutEffect(() => { notifyRef.current = onFundingReady; }, [onFundingReady]);
  const [session] = useState(() => createRiskQuoteSession(
    (context) => notifyRef.current(context),
    () => { setExpired(true); setResult(undefined); setBusy(false); setConfirmed(false); },
  ));
  useLayoutEffect(() => {
    session.activate();
    return () => session.dispose();
  }, [session]);

  async function run(action: "load" | "create" | "confirm" | "refresh") {
    if (!walletAddress || busy) return;
    if (action === "create" && !canRequote) return;
    const token = session.begin();
    setBusy(true);
    setFailed(false);
    setResult(undefined);
    setConfirmed(false);
    if (action === "load" || action === "create") {
      session.watchExpiry();
      setRecord(undefined);
      setExpired(false);
      setMissing(false);
    }
    try {
      if (action === "load" || action === "create") {
        const next = await (action === "create" ? createCurrentRiskQuote : loadCurrentRiskQuote)(taskId);
        if (!session.isCurrent(token)) return;
        if (!next) { setMissing(true); return; }
        setRecord(next);
        session.watchExpiry(next.quote.expiresAt);
      } else {
        if (!record || !(Date.parse(record.quote.expiresAt) > Date.now())) {
          setExpired(true);
          return;
        }
        const next = await (action === "confirm" ? confirmCurrentRiskQuote : refreshCurrentRiskQuote)(taskId, record);
        if (!session.publish(token, record.quote.expiresAt, next.fundingContext)) return;
        setResult(next);
        setConfirmed(action === "confirm");
      }
    } catch {
      if (session.isCurrent(token)) setFailed(true);
    } finally {
      if (session.isCurrent(token)) setBusy(false);
    }
  }

  const current = record?.quote;
  const legacy = Boolean(current && (current.schemaVersion !== 2 || !current.assetId));
  const isExpired = expired || (current ? !(Date.parse(current.expiresAt) > Date.now()) : false);
  const amount = (value: string) => `${new Intl.NumberFormat(locale).format(BigInt(value))} atomic`;
  return (
    <Panel className="risk-quote-panel">
      <h2>{zh ? "任务风险报价" : "Task risk quote"}</h2>
      <p>{zh ? "按当前任务和分工读取服务端报价。任务变化后需要重新报价并确认。" : "Read the server quote for the current task and assignments. Task changes require a new quote and confirmation."}</p>
      <button className="button button-primary" type="button" disabled={!walletAddress || busy} onClick={() => void run("load")}>
        {zh ? "读取当前报价" : "Read current quote"}
      </button>
      {canRequote ? <button className="button button-ghost" type="button" disabled={!walletAddress || busy} onClick={() => void run("create")}>{zh ? "创建 / 更新报价" : "Create / replace quote"}</button> : null}
      <p>{zh ? "读取不会改变报价。只有发布方可主动重报价；更新后双方需要重新确认。" : "Reading does not change the quote. Only the publisher can explicitly replace it; both sides must confirm the new version."}</p>
      {!walletAddress ? <p>{zh ? "请连接参与方钱包并完成登录。" : "Connect and authenticate a participant wallet."}</p> : null}
      <details className="risk-factor-guide">
        <summary>{zh ? "八项风险因子说明" : "Eight risk factors explained"}</summary>
        <p>{zh ? "以下为因子含义。当前接口未提供分项分数，总分与金额以服务端报价为准。" : "These explain the factors. Individual scores are not provided by this endpoint; the server quote determines the total score and amounts."}</p>
        <dl>{riskFactors.map(([cn, en, cnDescription, enDescription]) => <div key={en}><dt>{zh ? cn : en}</dt><dd>{zh ? cnDescription : enDescription}</dd></div>)}</dl>
      </details>
      {current ? <>
        <p>{current.phase === "final" ? (zh ? "最终报价" : "Final quote") : (zh ? "初步报价" : "Preliminary quote")} · {current.riskTier} · {current.riskScore}/100</p>
        <dl>
          <dt>{zh ? "报价资产（链与合约）" : "Quote asset (chain and contract)"}</dt><dd style={{ overflowWrap: "anywhere" }}>{current.assetId ?? (zh ? "历史报价未绑定资产" : "Legacy quote without an asset binding")}</dd>
          <dt>{zh ? "任务预算" : "Task budget"}</dt><dd>{amount(current.P)}</dd>
          <dt>{zh ? "单方保证金" : "Deposit per side"}</dt><dd>{amount(current.A)}</dd>
          <dt>{zh ? "平台服务费" : "Platform fee"}</dt><dd>{amount(current.B)}</dd>
          <dt>{zh ? "发布方合计" : "Publisher total"}</dt><dd>{amount(current.publisherTotal)}</dd>
        </dl>
        <details><summary>{zh ? "报价版本与确认哈希" : "Quote version and confirmation hash"}</summary>
          <p>v{current.schemaVersion ?? 1} · {record.version}</p>
          <code style={{ overflowWrap: "anywhere" }}>{record.quoteHash}</code>
          <p>{zh ? "确认绑定此报价；资产标识不代表已完成链上资产验证或资金收付。" : "Confirmation binds this quote; asset identity is not proof of on-chain asset verification or payment."}</p>
        </details>
        <p>{zh ? "有效期至" : "Expires"} {new Date(current.expiresAt).toLocaleString(locale)}</p>
        <p>{zh ? "收益仅为模拟；报价确认不发送链上交易。" : "Yield is simulation-only; confirming a quote does not send a blockchain transaction."}</p>
        <div className="risk-quote-actions">
          <button className="button button-primary" type="button" disabled={!walletAddress || busy || isExpired || legacy || confirmed} onClick={() => void run("confirm")}>{zh ? "确认此报价" : "Confirm this quote"}</button>
          <button className="button button-ghost" type="button" disabled={!walletAddress || busy || isExpired || legacy} onClick={() => void run("refresh")}>{zh ? "刷新确认状态" : "Refresh confirmation status"}</button>
        </div>
      </> : null}
      <p role="status" aria-live="polite">
        {legacy ? (zh ? "历史报价仅供读取，需要发布方重新报价。" : "Legacy quote is read-only. The publisher must issue a new quote.")
          : missing ? (zh ? "尚无报价，请由发布方创建；读取不会自动创建报价。" : "No quote exists. Ask the publisher to create one; reading never creates a quote.")
          : isExpired ? (zh ? "报价已过期，请由发布方重新报价。" : "Quote expired. Ask the publisher to issue a new quote.")
          : busy ? (zh ? "正在读取服务端状态……" : "Reading server state…")
          : failed ? (zh ? "报价操作未完成，请检查登录与服务状态后重新获取报价。" : "Quote operation incomplete. Check authentication and service availability, then retrieve a fresh quote.")
          : result ? (result.fundingContext
            ? (zh ? "最终报价已确认，注资准备仍由服务端校验。" : "Final quote confirmed. Funding preparation remains server-validated.")
            : (zh ? "尚未满足最终注资条件，请等待所需确认或审批。" : "Final funding conditions remain incomplete; required confirmations or approval are pending.")) : null}
      </p>
    </Panel>
  );
}
