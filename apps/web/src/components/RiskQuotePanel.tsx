import type { RiskAssessment } from "@agent-market/shared-contracts";

import {
  createQuoteConfirmationIntent,
  presentRiskQuote,
  type QuoteConfirmationIntent,
  type RiskPricingLocale,
  type RiskQuoteViewModel,
} from "../riskPricingPresentation";
import { Badge, Panel } from "./Ui";
import "./risk-pricing.css";

type RiskQuotePanelProps = {
  quote: RiskQuoteViewModel;
  assessment: RiskAssessment;
  locale: RiskPricingLocale;
  now?: string;
  onConfirmIntent?: (intent: QuoteConfirmationIntent) => void;
};

const copy = {
  en: {
    eyebrow: "RISK PRICING / AUDITABLE QUOTE",
    title: "Symmetric performance deposit",
    preliminary: "PRELIMINARY",
    manual_review: "MANUAL REVIEW REQUIRED",
    expired: "EXPIRED",
    ready: "READY",
    budget: "P · task budget",
    deposit: "A · one-side deposit",
    fee: "B · service fee",
    publisherTotal: "Publisher total · P+A+B",
    agentDeposit: "Agent Team deposit · A",
    riskFactors: "Eight deterministic risk factors",
    reasons: "Reason codes",
    allocations: "Agent Team allocation",
    expires: "Expires",
    policy: "Policy",
    phase: "Phase",
    yield: "Yield boundary",
    yieldNote: "Illustrative compounding only; no real return is claimed.",
    confirm: "Confirm quote intent",
    blocked: "Quote cannot be confirmed in this state",
    noAllocations: "Agent allocation is produced only for the final quote.",
    quoteMetadata: "Quote metadata",
  },
  "zh-CN": {
    eyebrow: "风险定价 / 可审计报价",
    title: "双方对称履约保证金",
    preliminary: "初步报价",
    manual_review: "需要人工审批",
    expired: "已过期",
    ready: "可确认",
    budget: "P · 任务预算",
    deposit: "A · 单方保证金",
    fee: "B · 服务费",
    publisherTotal: "发布方总额 · P+A+B",
    agentDeposit: "Agent Team 保证金 · A",
    riskFactors: "八项确定性风险因子",
    reasons: "原因码",
    allocations: "Agent Team 分配",
    expires: "过期时间",
    policy: "策略版本",
    phase: "报价阶段",
    yield: "收益边界",
    yieldNote: "仅展示复利模拟，不宣称任何真实收益。",
    confirm: "发出报价确认意图",
    blocked: "当前状态不可确认报价",
    noAllocations: "仅最终报价生成 Agent 分配。",
    quoteMetadata: "报价元数据",
  },
} as const;

const statusTone = {
  preliminary: "neutral",
  manual_review: "amber",
  expired: "rose",
  ready: "cyan",
} as const;

export function RiskQuotePanel({
  quote,
  assessment,
  locale,
  now,
  onConfirmIntent,
}: RiskQuotePanelProps) {
  const view = presentRiskQuote(quote, assessment, locale, now);
  const text = copy[locale];

  return (
    <Panel className="risk-quote-panel">
      <header className="risk-panel-heading">
        <div>
          <span className="eyebrow">{text.eyebrow}</span>
          <h2>{text.title}</h2>
        </div>
        <div className="risk-statuses">
          <Badge tone="indigo">{view.riskTier} · {view.riskScore}/100</Badge>
          <Badge tone={statusTone[view.status]}>{text[view.status]}</Badge>
        </div>
      </header>

      <div className="risk-quote-meta" aria-label={text.quoteMetadata}>
        <span><small>{text.phase}</small><strong>{view.phase}</strong></span>
        <span><small>{text.policy}</small><strong>{view.policyVersion}</strong></span>
        <span><small>{text.expires}</small><strong>{new Date(view.expiresAt).toLocaleString(locale)}</strong></span>
      </div>

      <div className="risk-money-grid">
        <div><span>{text.budget}</span><strong>{view.money.P}</strong></div>
        <div><span>{text.deposit} · {view.depositRate}</span><strong>{view.money.A}</strong></div>
        <div><span>{text.fee} · {view.serviceFeeRate}</span><strong>{view.money.B}</strong></div>
        <div className="risk-money-total"><span>{text.publisherTotal}</span><strong>{view.money.publisherTotal}</strong></div>
        <div><span>{text.agentDeposit}</span><strong>{view.money.agentTeamDeposit}</strong></div>
      </div>

      <section className="risk-factor-section">
        <h3>{text.riskFactors}</h3>
        <div className="risk-factor-grid">
          {view.factors.map((factor) => (
            <div className="risk-factor" key={factor.key}>
              <span>{factor.label}</span>
              <strong>{factor.score}</strong>
              <i aria-hidden="true"><b style={{ width: `${factor.score}%` }} /></i>
            </div>
          ))}
        </div>
      </section>

      <div className="risk-detail-grid">
        <section>
          <h3>{text.reasons}</h3>
          <div className="risk-reason-list">
            {view.reasonCodes.map((code) => <code key={code}>{code}</code>)}
          </div>
        </section>
        <section>
          <h3>{text.allocations}</h3>
          {view.agentAllocations.length > 0 ? (
            <dl className="risk-allocation-list">
              {view.agentAllocations.map((allocation) => (
                <div key={allocation.agentId}>
                  <dt>{allocation.agentId}</dt>
                  <dd>{allocation.amount}</dd>
                </div>
              ))}
            </dl>
          ) : <p>{text.noAllocations}</p>}
        </section>
      </div>

      <div className="risk-yield-boundary">
        <div><small>{text.yield}</small><Badge tone="amber">{view.yieldMode}</Badge></div>
        <p>{text.yieldNote}</p>
      </div>

      <footer className="risk-confirm-row">
        <button
          className="button button-primary"
          disabled={!view.confirmable || !onConfirmIntent}
          onClick={() => onConfirmIntent?.(createQuoteConfirmationIntent(quote))}
          type="button"
        >
          {view.confirmable ? text.confirm : text.blocked}
        </button>
        <code>{view.quoteId}</code>
      </footer>
    </Panel>
  );
}
