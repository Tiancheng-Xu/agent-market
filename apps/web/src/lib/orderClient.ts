import { OrderSnapshotSchema, type OrderSnapshot } from "@agent-market/shared-contracts";
import { assertWalletSessionAuthenticated, walletSessionRevision } from "./walletSession";

export type BrowserOrderCommand =
  | { type: "mark_funding_pending"; quoteId: string; taskFingerprint: string }
  | { type: "accept_assignment" }
  | { type: "submit_artifact"; artifact: OrderSnapshot["artifacts"][number] }
  | { type: "accept_delivery" }
  | { type: "open_dispute"; reasonCode: string };

async function parseResponse(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "ORDER_API_UNAVAILABLE");
  return payload;
}

async function authenticatedOrderRequest(path: string, init: RequestInit) {
  assertWalletSessionAuthenticated();
  const revision = walletSessionRevision();
  const assertCurrent = () => {
    if (revision !== walletSessionRevision()) throw new Error("AUTH_WALLET_CHANGED");
    assertWalletSessionAuthenticated();
  };
  try {
    const response = await fetch(path, init);
    assertCurrent();
    return await parseResponse(response);
  } finally {
    assertCurrent();
  }
}

export async function readOrder(orderId: string): Promise<OrderSnapshot> {
  const payload = await authenticatedOrderRequest(`/api/orders/${encodeURIComponent(orderId)}`, {
    credentials: "include", headers: { accept: "application/json" },
  });
  return OrderSnapshotSchema.parse(payload.order);
}

export async function executeOrderCommand(orderId: string, command: BrowserOrderCommand): Promise<OrderSnapshot> {
  const payload = await authenticatedOrderRequest(`/api/orders/${encodeURIComponent(orderId)}/commands`, {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(command),
  });
  return OrderSnapshotSchema.parse(payload.snapshot);
}
