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
  it("translates dynamic Agent catalog copy without translating model identifiers", () => {
    expect(translateVisibleText("zh-CN", "Provider")).toBe("提供方");
    expect(translateVisibleText("zh-CN", "Verified ops")).toBe("已验证操作");
    expect(translateVisibleText("zh-CN", "PENDING-SMOKE")).toBe("待 SMOKE 验证");
    expect(translateVisibleText("zh-CN", "Canonical owner-trained runtime. Served only through the signed local runtime boundary.")).toContain("签名保护的本地 Runtime");
    expect(translateVisibleText("zh-CN", "personal-ai-agent-runtime:v4.1")).toBe("personal-ai-agent-runtime:v4.1");
  });
});
