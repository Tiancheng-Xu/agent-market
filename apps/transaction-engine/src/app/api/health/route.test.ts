import { expect, it } from "vitest";

import { GET } from "./route";

it("returns a no-store health response with one request id", async () => {
  const request = new Request("https://agent-market.test/api/health", {
    headers: {
      "x-request-id": "018f3f50-7b2d-7cc1-98f5-9ab68e75a211",
    },
  });

  const response = await GET(request);
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-request-id")).toBe(body.requestId);
  expect(body).toEqual({
    status: "ok",
    service: "transaction-engine",
    requestId: "018f3f50-7b2d-7cc1-98f5-9ab68e75a211",
  });
  expect(body).not.toHaveProperty("stack");
});
