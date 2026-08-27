import { describe, expect, it } from "vitest";

import { createPagesHandler, type PagesEnvironment } from "./pages-worker";

describe("performance edge proxy", () => {
  it("signs and forwards performance events to the configured AWS origin", async () => {
    const forwarded: Request[] = [];
    const handler = createPagesHandler({
      async upstreamFetch(input, init) {
        forwarded.push(input instanceof Request ? input : new Request(input, init));
        return Response.json({ accepted: true }, { status: 202 });
      },
      now: () => 1_787_800_000_000,
      logger: { info() {}, error() {} },
    });
    const environment: PagesEnvironment = {
      API_ORIGIN: "https://api.example.test/base/",
      PERFORMANCE_HMAC_SECRET: "0123456789abcdef0123456789abcdef",
      ASSETS: { async fetch() { return new Response("asset"); } },
    };
    const requestId = "7dc42790-a91c-4d62-9d5d-a08bb5211141";

    const response = await handler.fetch(new Request(
      "https://agent-market.test/api/performance",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
        },
        body: JSON.stringify({ requestId }),
      },
    ), environment);

    expect(response.status).toBe(202);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.url).toBe("https://api.example.test/base/performance");
    expect(forwarded[0]?.headers.get("x-request-id")).toBe(requestId);
    expect(forwarded[0]?.headers.get("x-agent-market-timestamp")).toBe("1787800000");
    expect(forwarded[0]?.headers.get("x-agent-market-signature")).toMatch(/^[0-9a-f]{64}$/u);
    expect(forwarded[0]?.headers.get("cookie")).toBeNull();
  });

  it("fails closed when the AWS origin is not configured", async () => {
    const handler = createPagesHandler({ logger: { info() {}, error() {} } });
    const environment: PagesEnvironment = {
      ASSETS: { async fetch() { return new Response("asset"); } },
    };

    const response = await handler.fetch(new Request(
      "https://agent-market.test/api/performance",
      { method: "POST" },
    ), environment);

    expect(response.status).toBe(503);
  });

  it("fails closed when the signing secret is not configured", async () => {
    const forwarded: Request[] = [];
    const handler = createPagesHandler({
      async upstreamFetch(input, init) {
        forwarded.push(input instanceof Request ? input : new Request(input, init));
        return new Response(null, { status: 202 });
      },
      logger: { info() {}, error() {} },
    });
    const response = await handler.fetch(new Request(
      "https://agent-market.test/api/performance",
      { method: "POST", body: "{}" },
    ), {
      API_ORIGIN: "https://api.example.test/",
      ASSETS: { async fetch() { return new Response("asset"); } },
    });

    expect(response.status).toBe(503);
    expect(forwarded).toHaveLength(0);
  });
});
