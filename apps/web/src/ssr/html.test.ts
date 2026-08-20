import { describe, expect, it } from "vitest";

import { buildCsrFallbackDocument, composeSsrDocument } from "./html";

const template =
  '<!doctype html><html><body><div id="root"></div><script src="/assets/app.js"></script></body></html>';

async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("Agent Market SSR document", () => {
  it("streams route markup into the exact client root", async () => {
    const app = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<h1>Evidence Center</h1>"));
        controller.close();
      },
    });

    const document = await read(composeSsrDocument(template, app, {
      mode: "ssr",
      pathname: "/evidence",
      version: "v1",
    }));

    expect(document).toContain(
      '<div id="root" data-render-mode="ssr"><h1>Evidence Center</h1></div>',
    );
    expect(document).toContain('id="__AGENT_MARKET_RENDER_STATE__"');
  });

  it("returns an empty non-hydrating root for server failure", () => {
    const document = buildCsrFallbackDocument(template, {
      mode: "csr-fallback",
      pathname: "/tasks",
      version: "v1",
    });

    expect(document).toContain(
      '<div id="root" data-render-mode="csr-fallback"></div>',
    );
    expect(document).not.toContain('data-render-mode="ssr"');
  });

  it("rejects templates without one exact root marker", () => {
    expect(() => buildCsrFallbackDocument("<html></html>", {
      mode: "csr-fallback",
      pathname: "/",
      version: "v1",
    })).toThrowError("SSR_ROOT_MARKER_INVALID");
  });
});
