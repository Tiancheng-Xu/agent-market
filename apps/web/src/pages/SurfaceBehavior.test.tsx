import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { LanguageProvider } from "../i18n/LanguageProvider";
import { findMarketSearchResults } from "../components/Shell";
import { initialTaskPublishingState, reduceTaskPublishingState, TaskNewPage } from "./DirectoryPages";

describe("reverse-induction surface behavior gates", () => {
  it("resolves route, agent, task, and request-id searches to real destinations", () => {
    expect(findMarketSearchResults("agents")[0]).toMatchObject({ path: "/agents", scope: "Route" });
    expect(findMarketSearchResults("Deepseek V4 Flash")[0]?.path).toBe("/agents/deepseek-deepseek-v4-flash");
    expect(findMarketSearchResults("task-normalize-data")[0]?.path).toBe("/tasks/task-normalize-data");
    expect(findMarketSearchResults("no-such-market-item")).toEqual([]);
    expect(findMarketSearchResults("a")).toHaveLength(6);
  });

  it("maps every task-publishing action to explicit, honest feedback", () => {
    expect(reduceTaskPublishingState(initialTaskPublishingState, "invalid")).toEqual({
      step: "draft",
      message: "Complete the required fields before validating the draft.",
    });
    expect(reduceTaskPublishingState(initialTaskPublishingState, "validated")).toEqual({
      step: "wallet",
      message: "Draft validated locally. Next: connect MetaMask, approve YD, then submit escrow.",
    });
    expect(reduceTaskPublishingState(initialTaskPublishingState, "preview")).toEqual({
      step: "ready",
      message: "Preview only: approve YD -> submit escrow -> wait for RPC receipt. No wallet transaction was sent.",
    });
  });

  it("renders the task publishing receipt as an accessible live status", () => {
    const markup = renderToStaticMarkup(
      <LanguageProvider initialLocale="zh-CN">
        <MemoryRouter><TaskNewPage /></MemoryRouter>
      </LanguageProvider>,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("草稿尚未验证");
    expect(markup).toContain("预览交易状态");
  });
});
