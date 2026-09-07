import type { ReputationSnapshot } from "@agent-market/shared-contracts";

import {
  presentReputationV2,
  type RiskPricingLocale,
} from "../riskPricingPresentation";
import { Badge, Panel } from "./Ui";
import "./risk-pricing.css";

type ReputationV2PanelProps = {
  snapshot: ReputationSnapshot;
  locale: RiskPricingLocale;
};

const copy = {
  en: {
    eyebrow: "REPUTATION V2 / PRIVACY-SAFE SNAPSHOT",
    title: "Evidence-weighted reputation",
    samples: "samples",
    confidence: "confidence",
    policy: (window: number, events: number, halfLife: number) =>
      `${window}-day window · latest ${events} events · ${halfLife}-day half-life`,
    updated: "Updated",
    privacy: "Only aggregated reputation fields are shown; source identities and events stay private.",
  },
  "zh-CN": {
    eyebrow: "信誉 V2 / 隐私安全快照",
    title: "基于证据加权的信誉",
    samples: "样本",
    confidence: "置信度",
    policy: (window: number, events: number, halfLife: number) =>
      `${window} 天窗口 · 最近 ${events} 个事件 · ${halfLife} 天半衰期`,
    updated: "更新时间",
    privacy: "仅展示聚合信誉字段；来源身份与评价事件保持私有。",
  },
} as const;

export function ReputationV2Panel({ snapshot, locale }: ReputationV2PanelProps) {
  const view = presentReputationV2(snapshot, locale);
  const text = copy[locale];
  const confidenceTone = view.confidence === "high" ? "cyan" : view.confidence === "medium" ? "amber" : "neutral";

  return (
    <Panel className="reputation-v2-panel">
      <header className="risk-panel-heading">
        <div>
          <span className="eyebrow">{text.eyebrow}</span>
          <h2>{text.title}</h2>
        </div>
        <Badge tone={confidenceTone}>{view.confidence.toUpperCase()}</Badge>
      </header>

      <div className="reputation-score-row">
        <strong>{view.score}</strong>
        <span>/ 100</span>
        <div>
          <b>n={view.sampleCount}</b>
          <small>{text.samples} · {text.confidence} {view.confidencePercent}</small>
        </div>
      </div>

      <div className="reputation-dimensions">
        {view.dimensions.map((dimension) => (
          <div key={dimension.key}>
            <span>{dimension.label}</span>
            <strong>{dimension.score.toFixed(1)}</strong>
            <i aria-hidden="true"><b style={{ width: `${dimension.score}%` }} /></i>
          </div>
        ))}
      </div>

      <div className="reputation-policy">
        <span>{text.policy(view.windowDays, view.maxEvents, view.halfLifeDays)}</span>
        <span>{text.updated}: {new Date(view.calculatedAt).toLocaleString(locale)}</span>
        <code>{view.formulaVersion}</code>
      </div>
      <p className="reputation-privacy-note">{text.privacy}</p>
    </Panel>
  );
}
