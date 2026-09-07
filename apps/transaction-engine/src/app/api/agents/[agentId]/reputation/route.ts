import { computeReputationSnapshot } from "@agent-market/shared-contracts";
import { validate as isUuid } from "uuid";

import { getOrderRuntime } from "../../../../../application/order-runtime";
import type { ReputationStore } from "../../../../../application/reputation-service";
import { resolveRequestId } from "../../../../../lib/request-context";

type RouteContext = { params: Promise<{ agentId: string }> };
const headers = (requestId: string) => ({ "cache-control": "no-store", "x-request-id": requestId });

export function createReputationReadHandler(input: { store: ReputationStore; now?: () => Date }) {
  return async function GET(request: Request, agentId: string): Promise<Response> {
    const requestId = resolveRequestId(request.headers);
    try {
      if (!isUuid(agentId)) {
        return Response.json({ error: "REPUTATION_AGENT_ID_INVALID", requestId }, {
          status: 400, headers: headers(requestId),
        });
      }
      const reputation = computeReputationSnapshot(
        agentId,
        await input.store.listReviews(agentId),
        (input.now ?? (() => new Date()))().toISOString(),
      );
      return Response.json({ reputation, requestId }, { status: 200, headers: headers(requestId) });
    } catch {
      return Response.json({ error: "REPUTATION_UNAVAILABLE", requestId }, {
        status: 503, headers: headers(requestId),
      });
    }
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { agentId } = await context.params;
  const requestId = resolveRequestId(request.headers);
  try {
    const store = getOrderRuntime().reputationStore;
    if (!store) throw new Error("REPUTATION_STORE_UNAVAILABLE");
    return await createReputationReadHandler({ store })(request, agentId);
  } catch {
    return Response.json({ error: "REPUTATION_UNAVAILABLE", requestId }, {
      status: 503, headers: headers(requestId),
    });
  }
}
