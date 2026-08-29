import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { FullChainEvidence } from "./FullChainEvidence";
import { ServerApp } from "../ssr/ServerApp";

describe("full delivery chain evidence", () => {
  it("renders the complete delivery boundary with scoped external closure", () => {
    const markup = renderToStaticMarkup(<FullChainEvidence />);

    expect(markup.match(/data-chain-step=/g)?.length).toBeGreaterThanOrEqual(12);
    expect(markup).toContain("SSR / hydration / CSR fallback");
    expect(markup).toContain("challenge-sign-verify");
    expect(markup).toContain("server-derived unsigned intent");
    expect(markup).toContain("API Gateway");
    expect(markup).toContain("SQS / DLQ");
    expect(markup).toContain("ECS Fargate");
    expect(markup).toContain("Go matcher + pgvector");
    expect(markup).toContain("grouped OOF/CV");
    expect(markup).toContain("safe JSON artifact");
    expect(markup).toContain("independent RPC receipt + state readback");
    expect(markup).toContain("replay / ops / pause");
    expect(markup).not.toContain("pending-external");
    expect(markup.match(/verified-production/g)?.length).toBeGreaterThanOrEqual(9);
    expect(markup).toContain("/architecture/full-delivery-chain.svg");
    expect(markup).toContain('width="1600"');
    expect(markup).toContain('height="900"');
    expect(markup).toContain('decoding="async"');
  });

  it("mounts only the V3 business architecture on the interactive Evidence route", () => {
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    const page = readFileSync(new URL("../pages/EvidencePage.tsx", import.meta.url), "utf8");
    expect(main).not.toContain("FullChainEvidence");
    expect(page).not.toContain("FullChainEvidence");
    expect(page.match(/file: "agent-market-v3-workflow"/g)).toHaveLength(1);
  });

  it("uses the canonical trailing-slash Evidence URL in SSR navigation", () => {
    const serverApp = readFileSync(new URL("../ssr/ServerApp.tsx", import.meta.url), "utf8");
    expect(serverApp).toContain('href="/evidence/"');
    const markup = renderToStaticMarkup(<ServerApp pathname="/evidence/" />);
    expect(markup).toContain('href="/office"');
    expect(markup).toContain('data-evidence-boundary="current"');
    expect(markup).toContain("Cloudflare Web, the AWS V2 performance runtime, and Sepolia V3");
    expect(markup).toContain('class="full-chain"');
  });

  it("keeps traceability columns readable inside a contained horizontal scroller", () => {
    const page = readFileSync(new URL("../pages/EvidencePage.tsx", import.meta.url), "utf8");
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(page).toContain('className="evidence-trace-scroll"');
    expect(css).toContain(".evidence-trace{min-width:0;max-width:100%}");
    expect(css).toContain(".evidence-trace-scroll{grid-column:1/-1;min-width:0;max-width:100%;overflow:visible");
    expect(css).toContain(".evidence-trace-scroll>dl{width:100%;min-width:0;grid-template-columns:repeat(2,minmax(0,1fr))");
    expect(css).not.toContain("min-width:1220px");
    expect(css).toContain(".evidence-trace-scroll dd{word-break:normal;overflow-wrap:break-word;hyphens:none}");
    expect(css).not.toContain(".evidence-trace-scroll dd{word-break:break-all");
    expect(page).not.toContain("Fresh AWS V2 Web Vitals writeback remains pending external readback");
    expect(page).not.toContain("Sepolia V3 still requires a fresh deployment identifier and readback");
  });
});
