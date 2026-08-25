import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { AgentNodeExchangeSchema, type AgentNodeExchange } from "@agent-market/shared-contracts";

const MAX_BODY_BYTES = 131_072;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SENSITIVE_CONTENT = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,}|\bAKIA[0-9A-Z]{16}\b|\/Users\/[^\s"']+)/u;

export type NodeExchangeForwarder = (exchange: AgentNodeExchange) => Promise<void>;

export function signNodeExchange(body: string, timestamp: string, nonce: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}\n${nonce}\n${body}`).digest("hex");
}

export function createNodeExchangeHandler(options: {
  sharedSecret: string;
  forward: NodeExchangeForwarder;
  now?: () => Date;
}) {
  const seenNonces = new Map<string, number>();
  return async function POST(request: Request): Promise<Response> {
    const now = (options.now ?? (() => new Date()))();
    const body = await request.text();
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return error(413, "NODE_EXCHANGE_TOO_LARGE");
    const timestamp = request.headers.get("x-agent-timestamp") ?? "";
    const nonce = request.headers.get("x-agent-nonce") ?? "";
    const signature = request.headers.get("x-agent-signature") ?? "";
    const timestampMs = Date.parse(timestamp);
    if (!nonce || !Number.isFinite(timestampMs) || Math.abs(now.getTime() - timestampMs) > MAX_CLOCK_SKEW_MS) {
      return error(401, "NODE_EXCHANGE_SIGNATURE_EXPIRED");
    }
    for (const [storedNonce, expiresAt] of seenNonces) if (expiresAt <= now.getTime()) seenNonces.delete(storedNonce);
    if (seenNonces.has(nonce)) return error(409, "NODE_EXCHANGE_REPLAYED");
    const expected = signNodeExchange(body, timestamp, nonce, options.sharedSecret);
    if (!safeEqual(signature, expected)) return error(401, "NODE_EXCHANGE_SIGNATURE_INVALID");

    let exchange: AgentNodeExchange;
    try {
      exchange = AgentNodeExchangeSchema.parse(JSON.parse(body));
    } catch {
      return error(400, "NODE_EXCHANGE_SCHEMA_INVALID");
    }
    const digest = createHash("sha256").update(exchange.payload.content).digest("hex");
    if (digest !== exchange.payload.sha256) return error(400, "NODE_EXCHANGE_HASH_MISMATCH");
    if (SENSITIVE_CONTENT.test(exchange.payload.content)) return error(400, "NODE_EXCHANGE_SENSITIVE_CONTENT");

    seenNonces.set(nonce, now.getTime() + MAX_CLOCK_SKEW_MS);
    await options.forward(exchange);
    return Response.json({
      status: "accepted",
      requestId: exchange.requestId,
      runId: exchange.runId,
      taskId: exchange.taskId,
      nodeId: exchange.nodeId,
      direction: exchange.direction,
      payloadSha256: exchange.payload.sha256,
    }, { status: 202, headers: { "cache-control": "no-store" } });
  };
}

function safeEqual(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function error(status: number, code: string): Response {
  return Response.json({ status: "rejected", error: code }, { status, headers: { "cache-control": "no-store" } });
}
