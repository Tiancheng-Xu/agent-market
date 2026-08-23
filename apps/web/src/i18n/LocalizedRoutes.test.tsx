import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { EvidencePage } from "../pages/EvidencePage";
import { HomePage } from "../pages/HomePage";
import { LocalAgentsPage } from "../pages/LocalAgentsPage";
import { OpsPage } from "../pages/ControlPages";
import { TasksPage } from "../pages/DirectoryPages";
import { LanguageProvider } from "./LanguageProvider";

function renderChinese(page: React.ReactNode): string {
  return renderToStaticMarkup(
    <LanguageProvider initialLocale="zh-CN">
      <MemoryRouter>{page}</MemoryRouter>
    </LanguageProvider>,
  );
}

describe("Chinese route copy", () => {
  it("localizes Home dynamic card descriptions", () => {
    const html = renderChinese(<HomePage />);
    expect(html).toContain("绑定 Sepolia 钱包");
    expect(html).not.toContain("Bind a Sepolia wallet");
  });

  it("localizes Task fixtures, duration, count, and filter placeholder", () => {
    const html = renderChinese(<TasksPage />);
    expect(html).toContain("构建一份有来源依据的 AI 市场简报");
    expect(html).toContain("24 小时");
    expect(html).toContain('placeholder="按名称、分类或标签筛选"');
    expect(html).toContain("3 个任务");
    expect(html).not.toContain("Build a source-backed AI market brief");
  });

  it("localizes Ops dynamic readiness states", () => {
    const html = renderChinese(<OpsPage />);
    expect(html).toContain("本地构建，等待完整 Gate");
    expect(html).toContain("本地测试可用");
    expect(html).not.toContain("Local build pending full gate");
  });

  it("localizes Evidence mixed text nodes and image alternatives", () => {
    const html = renderChinese(<EvidencePage />);
    expect(html).toContain("真实任务唯一编排入口");
    expect(html).toContain("已通过 Provider API Adapter 返回预期 Smoke 文本");
    expect(html).toContain('alt="真实 Agent 架构仲裁选择混合方案 C"');
    expect(html).not.toContain("is the only orchestration entry for real tasks");
  });

  it("localizes the Local Agent workflow controls and runtime guidance", () => {
    const html = renderChinese(<LocalAgentsPage />);
    expect(html).toContain("生成工作流计划");
    expect(html).toContain("启动工作流");
    expect(html).toContain("尚未生成任务图。");
    expect(html).toContain("真实回答要求 Cloudflare Edge 网关和本地 Runtime 在线");
    expect(html).not.toContain("Generate workflow plan");
    expect(html).not.toContain("Live answers require the Cloudflare edge gateway");
  });
});
