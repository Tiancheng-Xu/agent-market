import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PortfolioNavigation } from "./PortfolioNavigation";

describe("PortfolioNavigation", () => {
  it("uses the canonical Portfolio Home, Project Home, and Evidence hrefs in order", () => {
    const markup = renderToStaticMarkup(<PortfolioNavigation pathname="/" />);

    expect(markup).toContain('href="https://baby2b.online/dashboard/"');
    expect(markup).toContain('href="https://agent-market.baby2b.online/"');
    expect(markup).toContain('href="https://agent-market.baby2b.online/evidence"');
    expect(markup.indexOf("Portfolio Home")).toBeLessThan(markup.indexOf("Project Home"));
    expect(markup.indexOf("Project Home")).toBeLessThan(markup.indexOf("Evidence"));
    expect(markup).toContain('href="https://agent-market.baby2b.online/" aria-current="page"');
  });

  it("marks Evidence as the current page on an Evidence deep link", () => {
    const markup = renderToStaticMarkup(<PortfolioNavigation pathname="/evidence" />);

    expect(markup).toContain('href="https://agent-market.baby2b.online/evidence" aria-current="page"');
    expect(markup).not.toContain('href="https://agent-market.baby2b.online/" aria-current="page"');
  });
});
