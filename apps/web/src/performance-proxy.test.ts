import { describe, expect, it } from "vitest";

import { createPagesHandler, type PagesEnvironment } from "./pages-worker";

describe("performance edge proxy", () => {
  it("forwards same-origin performance events to the configured AWS origin", async () => {
    const forwarded: Request[] = [];
    const handler = createPagesHandler({
      async upstreamFetch(input, init) {
        forwarded.push(input instanceof Request ? input : new Request(input, init));
        return Response.json({ accepted: true }, { status: 202 });
      },
      logger: { info() {}, error() {} },
    });
    const environment: PagesEnvironment = {
      API_ORIGIN: "https://api.example.test/base/",
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
});
