import { describe, expect, it } from "vitest";
import { createPagesHandler, type PagesEnvironment } from "./pages-worker";

const environment: PagesEnvironment = {
  ASSETS: { fetch: async () => new Response("", { status: 404 }) },
  TRANSACTION_ENGINE_ORIGIN: "https://engine.example",
};
const url = "https://market.example/api/orders/00000000-0000-4000-8000-000000000001";

describe("business upstream failure boundary", () => {
  it.each([503, 530, 302])("sanitizes upstream status %i", async (status) => {
    const handler = createPagesHandler({ upstreamFetch: async () => new Response("private infrastructure detail", { status }) });
    const response = await handler.fetch(new Request(url), environment);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "TRANSACTION_ENGINE_UNAVAILABLE" });
  });
  it("does not retry a write with an unknown outcome", async () => {
    let calls = 0;
    const handler = createPagesHandler({ upstreamFetch: async () => { calls++; throw new Error("connection reset"); } });
    const response = await handler.fetch(new Request(`${url}/commands`, {
      method: "POST", headers: { origin: "https://market.example" }, body: "{}",
    }), environment);
    expect(calls).toBe(1);
    expect(response.status).toBe(503);
  });
  it("preserves query parameters and enforces a bounded upstream request", async () => {
    let received: Request | undefined;
    const handler = createPagesHandler({ upstreamFetch: async (input) => {
      received = input as Request;
      return Response.json({ status: "draft" });
    } });
    const response = await handler.fetch(new Request(`${url}?cursor=next`), environment);
    expect(received?.url).toBe("https://engine.example/api/orders/00000000-0000-4000-8000-000000000001?cursor=next");
    expect(received?.signal).toBeDefined();
    expect(response.status).toBe(200);
  });
});
