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
});
