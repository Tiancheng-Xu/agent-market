import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Badge, PageHeader, Panel } from "../components/Ui";
import { agents } from "../data";
import { Localized } from "../i18n/LanguageProvider";
import { listOwnerAgents } from "../ownerAgentRegistry";
import {
  deriveOwnerAgentLifecycle,
  persistOwnerAgentLifecycle,
  type LifecycleOwnerAgent,
} from "../ownerAgentLifecycle";

type ManagedAgentsPageProps = { walletAddress: string | null };

const actionsFor = (status: string) => {
  if (status === "draft") return ["submit"] as const;
  if (status === "reviewing") return ["publish"] as const;
  if (status === "published") return ["pause", "revise", "retire"] as const;
  if (status === "paused") return ["resume", "revise", "retire"] as const;
  return [] as const;
};

export function ManagedAgentsPage({ walletAddress }: ManagedAgentsPageProps) {
  const [query, setQuery] = useState("");
  const [owned, setOwned] = useState<LifecycleOwnerAgent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    if (!walletAddress) {
      setOwned([]);
      return () => { current = false; };
    }
    void listOwnerAgents(walletAddress)
      .then((records) => { if (current) setOwned(records); })
      .catch(() => { if (current) setError("Owner registry unavailable"); });
    return () => { current = false; };
  }, [walletAddress]);

  const publicAgents = useMemo(() => agents.filter((agent) => {
    const term = query.trim().toLowerCase();
    return term.length === 0 || [agent.name, agent.description, ...agent.tags]
      .some((value) => value.toLowerCase().includes(term));
  }), [query]);

  const transition = async (record: LifecycleOwnerAgent, action: "submit" | "publish" | "pause" | "resume" | "retire" | "revise") => {
    setBusy(record.id);
    setError(null);
    try {
      const updated = await persistOwnerAgentLifecycle(record, action);
      setOwned((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Lifecycle update failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Localized><div className="managed-agents-page">
      <PageHeader eyebrow="AGENT REGISTRY" title="Publish versions, preserve history" description="Lifecycle actions are explicit. Retired versions remain in the audit history, and only published public agents can enter task matching." actions={<Link className="button button-primary" to="/agents/new">Create agent</Link>} />
      {error ? <div className="runtime-offline-callout" role="alert"><strong>{error}</strong></div> : null}
      <section className="section-block">
        <div className="section-heading"><span className="eyebrow">OWNER CONTROL</span><h2>Your registered agents</h2></div>
        {!walletAddress ? <Panel><strong>Connect a wallet to manage agent versions.</strong></Panel> : null}
        {walletAddress && owned.length === 0 ? <Panel><strong>No owner agents registered yet.</strong><p>Create an HTTPS or owner-only local Agent. Registration creates an auditable lifecycle record.</p></Panel> : null}
        <div className="owner-agent-grid">
          {owned.map((record) => {
            const lifecycle = deriveOwnerAgentLifecycle(record);
            return <Panel key={record.id} className="owner-agent-card"><header><div><h3>{record.displayName}</h3><small>{record.provider} / {record.modelTag}</small></div><Badge tone={lifecycle.status === "published" ? "cyan" : lifecycle.status === "retired" ? "rose" : "amber"}>{lifecycle.status} / V{lifecycle.version}</Badge></header><p>{record.description}</p><div className="agent-history" aria-label="Agent version history">{lifecycle.history.map((event, index) => <span key={`${event.occurredAt}-${index}`}>{event.from ?? "created"} → {event.to}<small>{event.reasonCode}</small></span>)}</div><footer>{actionsFor(lifecycle.status).map((action) => <button className={action === "retire" ? "button button-ghost" : "button button-primary"} disabled={busy === record.id} key={action} onClick={() => void transition(record, action)} type="button">{action}</button>)}</footer></Panel>;
          })}
        </div>
      </section>
      <section className="section-block">
        <div className="section-heading"><span className="eyebrow">PUBLIC MARKET</span><h2>Search verified agents</h2></div>
        <label className="agent-market-search">Search<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, capability, or tag" /></label>
        <div className="public-agent-grid">{publicAgents.map((agent) => <Panel key={agent.id} className="public-agent-card"><header><div><h3>{agent.name}</h3><small>{agent.provider} / {agent.modelTag}</small></div><Badge tone={agent.verification === "verified" ? "cyan" : "neutral"}>{agent.verification ?? "catalog"}</Badge></header><p>{agent.description}</p><div className="tag-row">{agent.tags.slice(0, 5).map((tag) => <span key={tag}>{tag}</span>)}</div><footer><span>{agent.reliability}% reliability / {agent.completed} completed</span><Link className="button button-ghost" to={`/agents/${agent.id}`}>View details</Link></footer></Panel>)}</div>
      </section>
    </div></Localized>
  );
}
