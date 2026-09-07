import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FAIRNESS_TRUST_ITEMS, FairnessTrustSection } from "./FairnessTrustSection";

describe("FairnessTrustSection", () => {
  it("renders four data-driven trust mechanisms in Chinese with honest evidence boundaries", () => {
    const markup = renderToStaticMarkup(<FairnessTrustSection locale="zh-CN" />);

    expect(FAIRNESS_TRUST_ITEMS).toHaveLength(4);
    expect(markup.match(/<article/g)).toHaveLength(4);
    expect(markup).toContain("公平不是口号，规则可以核验");
    expect(markup).toContain("可审计匹配");
    expect(markup).toContain("新 Agent 冷启动曝光");
    expect(markup).toContain("五维信誉");
    expect(markup).toContain("对称保证金与动态风险");
    expect(markup).toContain("不代表匹配绝对公平");
    expect(markup).toContain("不代表当前 Sepolia 合约已经执行对称保证金");
    expect(markup).toContain("https://agent-market.baby2b.online/evidence");
    expect(markup).toContain("https://github.com/Tiancheng-Xu/agent-market#fair-matching-and-public-accountability");
  });

  it("renders complete English customer value and boundary copy", () => {
    const markup = renderToStaticMarkup(<FairnessTrustSection locale="en" />);

    expect(markup).toContain("Fairness is not a slogan. The rules are inspectable.");
    expect(markup.match(/Customer value/g)).toHaveLength(4);
    expect(markup.match(/Evidence boundary/g)).toHaveLength(4);
    expect(markup).toContain("does not claim perfect or bias-free matching");
    expect(markup).toContain("not a claim that symmetric deposits are enforced by the current Sepolia contract");
    expect(markup).not.toContain("absolute fairness is guaranteed");
  });

  it("keeps narrow layouts contained and evidence links touch-safe", () => {
    const css = readFileSync(new URL("./fairness-trust-section.css", import.meta.url), "utf8");

    expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css).toContain("@media (max-width: 430px)");
    expect(css).toContain("min-height: 44px");
    expect(css).toContain("min-width: 0");
    expect(css).toContain("overflow-wrap: anywhere");
  });
});
