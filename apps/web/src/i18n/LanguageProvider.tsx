import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useMemo, useState, type PropsWithChildren, type ReactElement, type ReactNode } from "react";
import { translate, translateVisibleText, type Locale, type TranslationKey } from "./translations";
import { supplementalZhTranslations } from "./supplementalTranslations";

export const LOCALE_STORAGE_KEY = "agent-market-locale";
export interface LocaleStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; }
interface LanguageValue { locale: Locale; setLocale(locale: Locale): void; t(key: TranslationKey): string; }
const LanguageContext = createContext<LanguageValue>({ locale: "en", setLocale() {}, t: (key) => key });

export function normalizeLocale(value: unknown): Locale { return value === "zh-CN" ? "zh-CN" : "en"; }
export function readStoredLocale(storage: LocaleStorage | undefined): Locale { try { return normalizeLocale(storage?.getItem(LOCALE_STORAGE_KEY)); } catch { return "en"; } }
export function writeStoredLocale(storage: LocaleStorage | undefined, locale: Locale): void { try { storage?.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Storage cannot block rendering. */ } }
export function writeDocumentLocale(root: { lang: string } | undefined, locale: Locale): void { if (root) root.lang = locale; }
export function localizeAssetPath(path: string, locale: Locale): string {
  return locale === "zh-CN" && path.startsWith("/architecture/") && path.endsWith(".svg") && !path.endsWith(".zh-CN.svg")
    ? path.replace(/\.svg$/, ".zh-CN.svg")
    : path;
}

export function LanguageProvider({ children, storage }: PropsWithChildren<{ storage?: LocaleStorage }>) {
  const [locale, setLocaleState] = useState<Locale>("en");
  const resolvedStorage = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
  useEffect(() => { setLocaleState(readStoredLocale(resolvedStorage)); }, [resolvedStorage]);
  useEffect(() => { writeDocumentLocale(typeof document === "undefined" ? undefined : document.documentElement, locale); }, [locale]);
  const setLocale = useCallback((next: Locale) => { setLocaleState(next); writeStoredLocale(resolvedStorage, next); }, [resolvedStorage]);
  const value = useMemo<LanguageValue>(() => ({ locale, setLocale, t: (key) => translate(locale, key) }), [locale, setLocale]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
export function useLanguage(): LanguageValue { return useContext(LanguageContext); }

const stringProps = new Set(["alt", "aria-label", "description", "eyebrow", "label", "note", "placeholder", "title"]);
export function translateLocalizedText(locale: Locale, text: string): string {
  if (locale === "zh-CN" && supplementalZhTranslations[text]) return supplementalZhTranslations[text];
  if (locale === "zh-CN") {
    const reliability = /^Reliability (\d+(?:\.\d+)?)% across (\d+) completed tasks$/.exec(text);
    if (reliability) return `可靠性 ${reliability[1]}%，累计完成 ${reliability[2]} 项任务`;
  }
  return translateVisibleText(locale, text);
}
function localizeNode(node: ReactNode, locale: Locale, path = "root"): ReactNode {
  if (typeof node === "string") return translateLocalizedText(locale, node);
  if (Array.isArray(node)) {
    return node.map((item, index) => {
      const localized = localizeNode(item, locale, `${path}.${index}`);
      return isValidElement(localized) && localized.key == null
        ? cloneElement(localized, { key: `localized-${path}-${index}` })
        : localized;
    });
  }
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Record<string, unknown>>;
  const nextProps: Record<string, unknown> = {};
  for (const prop of stringProps) { const value = element.props[prop]; if (typeof value === "string") nextProps[prop] = translateLocalizedText(locale, value); }
  if (typeof element.props.src === "string") nextProps.src = localizeAssetPath(element.props.src, locale);
  if ("children" in element.props) nextProps.children = localizeNode(element.props.children as ReactNode, locale, `${path}.children`);
  return cloneElement(element, nextProps);
}
export function Localized({ children }: PropsWithChildren) { const { locale } = useLanguage(); return <>{localizeNode(children, locale)}</>; }
