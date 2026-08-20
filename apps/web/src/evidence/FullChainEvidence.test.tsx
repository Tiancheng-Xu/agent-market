import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FullChainEvidence } from "./FullChainEvidence";

describe("full delivery chain evidence", () => {
  it("renders every system hop and the final AWS pause gate", () => {
    const markup = renderToStaticMarkup(<FullChainEvidence />);

    expect(markup.match(/data-chain-step=/g)).toHaveLength(10);
    expect(markup).toContain("Browser Web Vitals");
    expect(markup).toContain("Cloudflare Edge Worker");
    expect(markup).toContain("API Gateway");
    expect(markup).toContain("SQS / DLQ");
    expect(markup).toContain("ECS Fargate");
    expect(markup).toContain("PostgreSQL / pgvector");
    expect(markup).toContain("request_id");
    expect(markup).toContain("ECS running=0");
    expect(markup).toContain("/architecture/full-delivery-chain.svg");
  });
});
