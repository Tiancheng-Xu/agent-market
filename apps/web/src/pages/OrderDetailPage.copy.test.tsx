import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { OrderDetailPage } from "./OrderDetailPage";
import { createOrderQueryClient, orderQueryKeys } from "./orderQueryClient";

const language = vi.hoisted(() => ({ locale: "en" }));
vi.mock("../i18n/LanguageProvider", async (original) => ({
  ...await original<typeof import("../i18n/LanguageProvider")>(),
  useLanguage: () => language,
}));

describe("order-specific short labels", () => {
  it.each(["zh-CN", "en"])("renders explicit %s labels and the exact matches link", (locale) => {
    language.locale = locale;
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/tasks/task-research-brief"]}>
        <Routes><Route path="/tasks/:id" element={
          <QueryClientProvider client={createOrderQueryClient()}><OrderDetailPage /></QueryClientProvider>
        } /></Routes>
      </MemoryRouter>,
    );
    const zh = ["验收约定", "先验证证据，再结算", "查看可解释匹配", "报价元数据", "订单生命周期", "角色权限操作", "满足条件后获得评价资格", "项交付物", "可评价", "精确 Agent ID", "打开办公室工位"];
    const en = ["ACCEPTANCE CONTRACT", "Evidence before settlement", "View explainable matches", "artifacts", "review eligible", "exact Agent ID"];
    for (const text of locale === "zh-CN" ? zh : en) expect(html).toContain(text);
    for (const text of locale === "zh-CN" ? en : zh) expect(html).not.toContain(text);
    expect(html).toContain('href="/tasks/task-research-brief/matches"');
    expect(html).toContain('class="order-reputation"');
    expect(html).toContain("SIMULATION_ONLY");
  });

  it("translates participant role controls without leaking the English template", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const publisherWallet = "0x1111111111111111111111111111111111111111";
    const client = createOrderQueryClient();
    client.setQueryData(orderQueryKeys.order(id), {
      id, publisherWallet, agentId: null, agentWallet: null, title: "角色文案", budgetAtomic: "100",
      status: "open", version: 1, artifacts: [], reviewEligible: false, manualReview: null,
      updatedAt: "2026-09-12T12:00:00.000Z",
    });
    language.locale = "zh-CN";
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/tasks/${id}`]}><Routes><Route path="/tasks/:id" element={
        <QueryClientProvider client={client}><OrderDetailPage walletAddress={publisherWallet} /></QueryClientProvider>
      } /></Routes></MemoryRouter>,
    );
    expect(html).toContain("发布方操作");
    expect(html).not.toContain("publisher controls");
  });
});
