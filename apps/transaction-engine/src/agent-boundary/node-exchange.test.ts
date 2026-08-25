import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createNodeExchangeHandler, signNodeExchange } from "./node-exchange";

const secret = "test-node-exchange-secret";
const now = () => new Date("2026-08-23T12:00:00.000Z");

function body(content = "node result") {
  return JSON.stringify({
    requestId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    taskId: "task-1",
    nodeId: "execute-1",
    agentId: "personal-code-agent",
    direction: "egress",
    payload: {
      kind: "node-output",
      contentType: "text/plain",
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    },
  });
}

function request(payload: string, nonce = "nonce-1") {
  const timestamp = now().toISOString();
  return new Request("https://aws.agent-market.test/api/agent/node-exchange", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-timestamp": timestamp,
      "x-agent-nonce": nonce,
      "x-agent-signature": signNodeExchange(payload, timestamp, nonce, secret),
    },
    body: payload,
  });
}

describe("AWS node exchange boundary", () => {
  it("accepts and forwards only a signed task-node envelope without echoing content", async () => {
    const forward = vi.fn(async () => undefined);
    const handler = createNodeExchangeHandler({ sharedSecret: secret, forward, now });
    const response = await handler(request(body()));
    const result = await response.json();
    expect(response.status).toBe(202);
    expect(forward).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("node result");
  });

  it("rejects replay, arbitrary fields, hash mismatches, and sensitive content", async () => {
    const handler = createNodeExchangeHandler({ sharedSecret: secret, forward: async () => undefined, now });
    const valid = body();
    expect((await handler(request(valid, "replay"))).status).toBe(202);
    expect((await handler(request(valid, "replay"))).status).toBe(409);
    expect((await handler(request(JSON.stringify({ ...JSON.parse(valid), fullDag: {} }), "extra"))).status).toBe(400);
    expect((await handler(request(body("sk-secret-value-123456"), "secret"))).status).toBe(400);
  });
});
