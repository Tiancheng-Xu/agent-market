import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../i18n/LanguageProvider";
import { restoreRouteScroll, Shell } from "./Shell";

const disconnectedWallet = {
  address: null,
  chainId: null,
  status: "disconnected" as const,
  error: null,
  message: null,
};

describe("Shell visual gates", () => {
  it("restores the route viewport without overriding anchor navigation", () => {
    const scrollTo = vi.fn();

    expect(restoreRouteScroll("", scrollTo)).toBe(true);
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", left: 0, top: 0 });

    scrollTo.mockClear();
    expect(restoreRouteScroll("#evidence", scrollTo)).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("renders navigation and mixed localized children without missing-key warnings", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const markup = renderToStaticMarkup(
        <MemoryRouter>
          <LanguageProvider>
            <Shell
              wallet={disconnectedWallet}
              isSepolia={false}
              onConnect={() => undefined}
              onSwitch={() => undefined}
            >
              <p>Content</p>
            </Shell>
          </LanguageProvider>
        </MemoryRouter>,
      );

      expect(markup).toContain('aria-label="Primary navigation"');
      expect(markup).toContain('aria-label="Mobile navigation"');
      expect(markup).toContain('aria-label="More navigation"');
      expect(markup).toContain('aria-expanded="false"');
      expect(markup).toContain('href="/office"');
      expect(markup).toContain('href="/committee"');
      expect(markup).toContain('href="/evidence"');
      expect(consoleError.mock.calls.flat().join(" ")).not.toContain('unique "key"');
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps language controls touch-safe and the 375px header contained", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(css).toContain(".language-toggle button{min-width:44px;min-height:44px");
    expect(css).toContain(".wallet-actions{min-width:0;max-width:100%}");
    expect(css).toContain(".language-toggle{display:flex;flex:0 0 auto;min-height:44px");
    expect(css).toContain("@media (max-width:420px){.topbar{padding-inline:10px}");
    expect(css).not.toContain(".language-toggle button{min-width:42px}");
  });
  it("lets content panels size themselves instead of stretching to the tallest peer", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(css).toContain(".panel{align-self:start}");
    expect(css).toContain(".match-grid{align-items:start}");
    expect(css).toContain(".match-card ul{min-height:0}");
  });

  it("applies the shared design tokens and responsive shell contracts", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

    expect(css).toContain("--space-1:4px");
    expect(css).toContain("--radius-panel:14px");
    expect(css).toContain("--text-body:clamp(15px,1.2vw,16px)");
    expect(css).toContain("--shadow-level-2:0 18px 48px rgba(0,0,0,.32)");
    expect(css).toContain("--motion-standard:220ms");
    expect(css).toContain(":where(a,button,input,select,textarea,[tabindex]):focus-visible");
    expect(css).toContain(".route-fallback,.skeleton");
    expect(css).toContain(".stats-grid,.card-grid,.capability-grid,.match-grid,.committee-grid,.evidence-summary{align-items:start}");
    expect(css).toContain("html,body,#root,.site-shell,.app-column,main{max-width:100%;overflow-x:clip}");
    expect(css).toContain("overflow-wrap:anywhere");
  });
});
