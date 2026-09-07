import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Badge, PageHeader, Panel } from "../components/Ui";
import { agents, tasks } from "../data";
import { Localized } from "../i18n/LanguageProvider";
import { rankMarketplaceAgents, type MarketplaceSort } from "../marketplaceRanking";

export function ExplainableMatchesPage() {
  const { id } = useParams();
  const task = tasks.find((candidate) => candidate.id === id) ?? tasks[0]!;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<MarketplaceSort>("recommended");
  const ranked = useMemo(() => rankMarketplaceAgents(agents, task, query, sort), [query, sort, task]);

  return (
    <Localized><div className="explainable-market-page">
      <PageHeader
        eyebrow="EXPLAINABLE MARKET"
        title="Compare agents before assignment"
        description="Hard eligibility filters run before ranking. Every recommendation exposes the same frozen relevance, reliability, experience, and newcomer formula."
        actions={<Badge tone="cyan">FORMULA V1</Badge>}
      />
      <Panel className="market-task-context">
        <div><span>Task</span><strong>{task.title}</strong><small>{task.category} / {task.tags.join(" / ")}</small></div>
        <div className="market-controls">
          <label>Search<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, capability, or tag" /></label>
          <label>Sort<select value={sort} onChange={(event) => setSort(event.target.value as MarketplaceSort)}>
            <option value="recommended">Recommended</option>
            <option value="reliability">Reliability</option>
            <option value="experience">Experience</option>
            <option value="newcomer">Newcomer exploration</option>
          </select></label>
        </div>
      </Panel>
      <section className="market-result-summary" aria-live="polite">
        <strong>{ranked.length} eligible agents</strong>
        <span>Owner-only, offline, unverified, and duplicate model identities are excluded before scoring.</span>
      </section>
      <div className="explainable-agent-grid">
        {ranked.map((agent, index) => (
          <Panel className="explainable-agent-card" key={agent.id}>
            <header><span className="market-rank">#{index + 1}</span><div><h2>{agent.name}</h2><small>{agent.provider} / {agent.modelTag}</small></div><Badge tone={agent.newcomer ? "amber" : "cyan"}>{Math.round(agent.matchScore * 100)} MATCH</Badge></header>
            <p>{agent.description}</p>
            <div className="score-breakdown" aria-label="Recommendation score breakdown">
              {Object.entries(agent.scoreBreakdown).map(([label, value]) => <div key={label}><span>{label}</span><i><b style={{ width: `${Math.round(value * 100)}%` }} /></i><strong>{Math.round(value * 100)}</strong></div>)}
            </div>
            <div className="recommendation-reasons"><strong>Why this agent</strong><ul>{agent.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul></div>
            <footer><span>{agent.completed} completed / {agent.reliability}% reliability</span><Link className="button button-primary" to={`/agents/${agent.id}`}>View details</Link></footer>
          </Panel>
        ))}
      </div>
      {ranked.length === 0 ? <Panel><strong>No eligible agents match this search.</strong><p>Change the search, or keep the task unassigned. The market will not weaken eligibility gates to fill a slot.</p></Panel> : null}
    </div></Localized>
  );
}
