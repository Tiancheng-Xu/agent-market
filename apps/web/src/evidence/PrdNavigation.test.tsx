import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServerApp } from "../ssr/ServerApp";

describe("Evidence PRD navigation", () => {
  it("exposes the complete document link in server-rendered Evidence before hydration", () => {
    const markup = renderToStaticMarkup(<ServerApp pathname="/evidence/" />);
    expect(markup).toContain('href="/evidence/prd.html"');
    expect(markup).toContain('查看完整项目 PRD');
  });
});
