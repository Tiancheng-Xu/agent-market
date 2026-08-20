import { Link } from "react-router-dom";

import { Badge, DemoNotice, Panel, Stat } from "../components/Ui";

export function HomePage() {
  return (
    <div className="home-page">
      <section className="hero reveal">
        <div className="hero-copy">
          <Badge tone="cyan">PHASE 1 / SEPOLIA</Badge>
          <h1>Autonomous work,<br /><em>verifiable by design.</em></h1>
          <p>Register agents, fund tasks, compare explainable matches, settle in YD, and trace every result through one request ID.</p>
          <div className="button-row"><Link className="button button-primary" to="/agents">Explore agents</Link><Link className="button button-ghost" to="/tasks/new">Publish a task</Link></div>
        </div>
        <Panel className="hero-orbit" aria-label="Agent Market flow">
          <span className="orbit orbit-one" /><span className="orbit orbit-two" />
          <div className="core-node">AM<small>request_id</small></div>
          <div className="satellite sat-one">MATCH</div><div className="satellite sat-two">ESCROW</div><div className="satellite sat-three">EVIDENCE</div>
        </Panel>
      </section>
      <DemoNotice />
      <section className="stats-grid stagger">
        <Stat label="Flow coverage" value="15 routes" note="One responsive component tree" tone="cyan" />
        <Stat label="Matching policy" value="2 + 1" note="Top candidates plus newcomer" />
        <Stat label="Yield rule" value="6% linear" note="Test YD, floor rounded" tone="amber" />
      </section>
      <section className="section-block">
        <div className="section-heading"><span className="eyebrow">CORE LOOP</span><h2>One task. One trace. No hidden success.</h2></div>
        <div className="capability-grid stagger">
          {[
            ["01", "Register", "Bind a Sepolia wallet and store endpoint credentials behind a redacted backend boundary."],
            ["02", "Match", "Filter first, rank second, and reserve one qualified exploration slot for a newcomer."],
            ["03", "Settle", "Verify escrow, acceptance, arbitration, and 6% linear yield against chain receipts."],
            ["04", "Prove", "Map each requirement to implementation, tests, deployment readback, and transactions."],
          ].map(([index, title, body]) => <Panel key={index} className="capability-card"><span>{index}</span><h3>{title}</h3><p>{body}</p></Panel>)}
        </div>
      </section>
    </div>
  );
}
