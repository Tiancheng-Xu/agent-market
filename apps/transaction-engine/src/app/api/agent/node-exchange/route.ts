import { createNodeExchangeHandler } from "../../../../agent-boundary/node-exchange";

const sharedSecret = process.env.AGENT_NODE_EXCHANGE_SHARED_SECRET ?? "";

export const POST = sharedSecret
  ? createNodeExchangeHandler({
      sharedSecret,
      async forward() {
        // AWS deployment injects the private queue/storage adapter. No payload
        // is persisted by the local route when the adapter is not configured.
      },
    })
  : async () => Response.json(
      { status: "offline", error: "NODE_EXCHANGE_NOT_CONFIGURED" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
