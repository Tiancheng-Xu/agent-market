import "./full-chain.css";

const chain = [
  { name: "Browser Web Vitals", detail: "TTFB, FCP, LCP, CLS and INP envelope", status: "LOCAL VERIFIED" },
  { name: "Cloudflare Edge Worker", detail: "Same-origin proxy, SSR and request boundary", status: "LOCAL VERIFIED" },
  { name: "API Gateway", detail: "Public HTTP ingestion boundary", status: "NOT DEPLOYED" },
  { name: "Ingestion Lambda", detail: "Schema validation and request continuity", status: "NOT DEPLOYED" },
  { name: "SNS", detail: "Performance event fan-out", status: "NOT DEPLOYED" },
  { name: "SQS / DLQ", detail: "Bounded retry and poison-message isolation", status: "NOT DEPLOYED" },
  { name: "ECS Fargate", detail: "Short-lived aggregation task", status: "NOT DEPLOYED" },
  { name: "PostgreSQL / pgvector", detail: "Metric sample and evidence persistence", status: "SCHEMA PENDING" },
  { name: "Evidence public readback", detail: "Production metrics, logs and screenshots", status: "PENDING READBACK" },
  { name: "AWS reversible pause", detail: "Disable consumer trigger and prove ECS running=0", status: "PENDING READBACK" },
] as const;

export function FullChainEvidence() {
  return (
    <section className="full-chain" aria-labelledby="full-chain-title">
      <div className="full-chain__heading">
        <div>
          <p className="full-chain__eyebrow">END-TO-END DELIVERY EVIDENCE</p>
          <h2 id="full-chain-title">One request, every boundary</h2>
        </div>
        <code>correlation: request_id</code>
      </div>

      <p className="full-chain__intro">
        A production performance sample is accepted only when the same request_id
        can be traced from the browser through Edge, AWS messaging, compute,
        persistence, public Evidence readback, and the final reversible pause.
      </p>

      <figure className="full-chain__diagram">
        <img
          src="/architecture/full-delivery-chain.svg"
          alt="Agent Market browser to Cloudflare, AWS, PostgreSQL, Evidence and pause sequence"
          loading="lazy"
        />
        <figcaption>
          Architecture intent. External hops remain unverified until production
          identifiers, screenshots and readback are captured.
        </figcaption>
      </figure>

      <ol className="full-chain__steps">
        {chain.map((step, index) => (
          <li key={step.name} data-chain-step={index + 1}>
            <span className="full-chain__index">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <h3>{step.name}</h3>
              <p>{step.detail}</p>
            </div>
            <strong data-status={step.status}>{step.status}</strong>
          </li>
        ))}
      </ol>
    </section>
  );
}
