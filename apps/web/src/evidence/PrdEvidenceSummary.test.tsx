import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PrdEvidenceSummary } from "./PrdEvidenceSummary";
import { ServerApp } from "../ssr/ServerApp";

describe("Agent Market PRD evidence scope", () => {
  it("publishes the snapshot identity and scope without private source material", () => {
    for (const language of ["en", "zh"] as const) {
      const markup = renderToStaticMarkup(<PrdEvidenceSummary language={language} />);
      expect(markup).toContain("13281bf657f2b4aa8965eb5040bc024ad4eaf150e2f8484ede0239662cdcd73d");
      expect(markup).toContain("2026-10-12");
      expect(markup).toContain('data-prd-scope="historical-delivery"');
      expect(markup).toContain('data-prd-scope="local-unpublished"');
      expect(markup).toContain('data-prd-scope="design-target"');
      expect(markup).not.toMatch(/\/Users\/|file:\/\/|localhost|127\.0\.0\.1/);
      expect(markup).not.toContain("北京阿拉丁");
    }
  });

  it("keeps local enterprise and model observations distinct from deployment", () => {
    const markup = renderToStaticMarkup(<PrdEvidenceSummary language="en" />);
    expect(markup).toContain("synthetic identities");
    expect(markup).toContain("in-memory records");
    expect(markup).toContain("not PDF/OCR");
    expect(markup).toContain("missing usage remains unknown");
    expect(markup).toContain("unmerged and undeployed");
    expect(markup).toContain("not new test, model, chain, cloud, or production evidence");
  });

  it("includes the summary in the Evidence SSR response and client route only", () => {
    const evidence = renderToStaticMarkup(<ServerApp pathname="/evidence/" />);
    const home = renderToStaticMarkup(<ServerApp pathname="/" />);
    const clientPage = readFileSync(new URL("../pages/EvidencePage.tsx", import.meta.url), "utf8");
    expect(evidence).toContain('data-prd-summary="agent-market"');
    expect(evidence).toContain("13281bf657f2b4aa8965eb5040bc024ad4eaf150e2f8484ede0239662cdcd73d");
    expect(home).not.toContain('data-prd-summary="agent-market"');
    expect(clientPage).toContain("<PrdEvidenceSummary language={language} />");
  });
});
