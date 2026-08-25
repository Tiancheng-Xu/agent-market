import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider, LOCALE_STORAGE_KEY, localizeAssetPath, normalizeLocale, readStoredLocale, useLanguage, writeDocumentLocale, writeStoredLocale } from "./LanguageProvider";
import { translateVisibleText } from "./translations";

function Probe() { const { locale, t } = useLanguage(); return <span>{locale}:{t("Market")}</span>; }
describe("bilingual interface", () => {
  it("uses English for SSR and the first client render", () => { expect(renderToStaticMarkup(<LanguageProvider><Probe /></LanguageProvider>)).toContain("en:Market"); });
  it("falls back safely for unsupported or inaccessible preferences", () => { expect(normalizeLocale("fr")).toBe("en"); expect(readStoredLocale({ getItem: () => { throw new Error("blocked"); }, setItem() {} })).toBe("en"); });
  it("reads and writes the explicit Chinese preference", () => { const setItem = vi.fn(); const storage = { getItem: () => "zh-CN", setItem }; expect(readStoredLocale(storage)).toBe("zh-CN"); writeStoredLocale(storage, "zh-CN"); expect(setItem).toHaveBeenCalledWith(LOCALE_STORAGE_KEY, "zh-CN"); });
  it("synchronizes the document language for assistive technology", () => { const root = { lang: "en" }; writeDocumentLocale(root, "zh-CN"); expect(root.lang).toBe("zh-CN"); });
  it("switches only architecture SVGs to localized assets", () => { expect(localizeAssetPath("/architecture/system-context.svg", "zh-CN")).toBe("/architecture/system-context.zh-CN.svg"); expect(localizeAssetPath("/architecture/system-context.zh-CN.svg", "zh-CN")).toBe("/architecture/system-context.zh-CN.svg"); expect(localizeAssetPath("/evidence/aws.png", "zh-CN")).toBe("/evidence/aws.png"); expect(localizeAssetPath("/architecture/system-context.svg", "en")).toBe("/architecture/system-context.svg"); });
  it("translates exact and count-bearing copy", () => { expect(translateVisibleText("zh-CN", "Market")).toBe("市场"); expect(translateVisibleText("zh-CN", "3 RESULTS")).toBe("3 条结果"); });
  it.each([
    ["LIVE AGENT PLAYGROUND", "真实 Agent 试验台"],
    ["Talk to real agents", "与真实 Agent 对话"],
    ["Queen-led GraphQL workflow", "Queen 主导的 GraphQL 工作流"],
    ["Generate workflow plan", "生成工作流方案"],
    ["Start workflow", "启动工作流"],
    ["No task graph proposed yet.", "尚未生成任务图。"],
    ["Sequential orchestration", "顺序编排"],
    ["Select next agent", "选择下一个 Agent"],
    ["Run orchestration", "运行编排"],
    ["LIVE AGENT RUNTIME", "真实 Agent Runtime"],
    ["Local and provider agents share one signed gateway", "本地与 Provider Agent 共用一个签名网关"],
    ["Architecture arbitration", "架构仲裁"],
    ["Risk and rescue policy", "风险与补救策略"],
    ["PERFORMANCE DEGRADATION", "性能降级"],
    ["Keep the app usable without faking success", "保持页面可用，但不伪造成功"],
    ["Agent Market performance degradation architecture", "Agent Market 性能降级架构图"],
    ["Step 2", "步骤 2"],
    ["risk: ", "风险："],
    ["agents: Auto-filled", "Agent：自动填充"],
    ["manualRequired", "需要人工确认"],
    ["execute", "执行"],
    ["Edit workflow", "编辑工作流"],
    ["Save workflow changes", "保存工作流修改"],
    ["Cancel editing", "取消编辑"],
    ["Edit execute-1 title", "编辑 execute-1 标题"],
    ["Select agent for execute-1", "为 execute-1 选择 Agent"],
  ])("translates critical agent workflow copy: %s", (source, expected) => {
    expect(translateVisibleText("zh-CN", source)).toBe(expected);
  });
});
