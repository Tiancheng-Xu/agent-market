import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../i18n/LanguageProvider";
import { Shell } from "./Shell";

const disconnectedWallet = {
  address: null,
  chainId: null,
  status: "disconnected" as const,
  error: null,
};

describe("Shell visual gates", () => {
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
});
