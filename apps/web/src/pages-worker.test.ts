import { describe, expect, it } from "vitest";

import { createPagesHandler, type PagesEnvironment } from "./pages-worker";

const template =
  '<!doctype html><html><body><div id="root"></div><script src="/assets/app.js"></script></body></html>';

function environment(): PagesEnvironment {
  return {
    ASSETS: {
      async fetch(request) {
        return new URL(request.url).pathname === "/index.html"
          ? new Response(template)
          : new Response("asset-not-found", { status: 404 });
      },
    },
  };
}

function stream(markup: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(markup));
      controller.close();
    },
  });
}

describe("Cloudflare Pages edge renderer", () => {
  it("renders known routes and preserves a real 404 status", async () => {
    const handler = createPagesHandler({
      version: "test",
      async render(pathname) {
        return stream(`<h1>${pathname}</h1>`);
      },
      logger: { info() {}, error() {} },
    });

    const evidence = await handler.fetch(
      new Request("https://agent-market.test/evidence", {
        headers: { accept: "text/html" },
      }),
      environment(),
    );
    const missing = await handler.fetch(
      new Request("https://agent-market.test/missing", {
        headers: { accept: "text/html" },
      }),
      environment(),
    );

    expect(evidence.status).toBe(200);
    expect(evidence.headers.get("x-agent-market-render-mode")).toBe("ssr");
    expect(await evidence.text()).toContain('data-render-mode="ssr"');
    expect(missing.status).toBe(404);
  });

  it("falls back to CSR when edge rendering fails", async () => {
    const handler = createPagesHandler({
      version: "test",
      async render() {
        throw new Error("render failed");
      },
      logger: { info() {}, error() {} },
    });

    const response = await handler.fetch(
      new Request("https://agent-market.test/tasks", {
        headers: { accept: "text/html" },
      }),
      environment(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-agent-market-render-mode"))
      .toBe("csr-fallback");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain('data-render-mode="csr-fallback"');
  });
});
