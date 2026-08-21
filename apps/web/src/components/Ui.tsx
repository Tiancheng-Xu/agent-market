import type { PropsWithChildren, ReactNode } from "react";

import { Localized } from "../i18n/LanguageProvider";

export function Badge({ children, tone = "neutral" }: PropsWithChildren<{ tone?: "cyan" | "amber" | "rose" | "neutral" | "indigo" }>) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Panel({ children, className = "" }: PropsWithChildren<{ className?: string }>) {
  return <section className={`panel ${className}`}>{children}</section>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return (
    <header className="page-header reveal">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="header-actions">{actions}</div> : null}
    </header>
  );
}

export function Stat({ label, value, note, tone = "plain" }: { label: string; value: string; note: string; tone?: "plain" | "cyan" | "amber" }) {
  return (
    <Panel className={`stat-card stat-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </Panel>
  );
}

export function DemoNotice() {
  return <Localized><div className="demo-notice"><Badge tone="amber">DEMO FIXTURE</Badge><span>Values on this page demonstrate UI states and are not deployment or transaction evidence.</span></div></Localized>;
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return <Panel className="empty-state"><span className="empty-mark">0</span><h2>{title}</h2><p>{description}</p></Panel>;
}
