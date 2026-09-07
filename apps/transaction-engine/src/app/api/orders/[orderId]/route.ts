import { OrderSnapshotSchema } from "@agent-market/shared-contracts";

import { getOrderRuntime } from "../../../../application/order-runtime";
import type { OrderStore } from "../../../../application/order-service";
import { getAuthService } from "../../../../auth/runtime";
import { AuthError, readSessionCookie } from "../../../../auth/session";
import { resolveRequestId } from "../../../../lib/request-context";

type RouteContext = { params: Promise<{ orderId: string }> };

interface SessionAuthenticator {
  authenticateSession(token: string): Promise<{ walletAddress: string }>;
}

const statusFor = (code: string): number => {
  if (code === "ORDER_NOT_FOUND") return 404;
  if (code === "ORDER_ACCESS_FORBIDDEN") return 403;
  if (code === "ORDER_ID_INVALID") return 400;
  return 503;
};

export function createOrderReadHandler(auth: SessionAuthenticator, store: OrderStore) {
  return async function GET(request: Request, rawOrderId: string): Promise<Response> {
    const requestId = resolveRequestId(request.headers);
    try {
      const token = readSessionCookie(request.headers);
      if (!token) throw new AuthError("AUTH_SESSION_INVALID");
      const session = await auth.authenticateSession(token);
      const parsedId = OrderSnapshotSchema.shape.id.safeParse(rawOrderId);
      if (!parsedId.success) throw new Error("ORDER_ID_INVALID");
      const order = await store.find(parsedId.data);
      if (!order) throw new Error("ORDER_NOT_FOUND");
      const wallet = session.walletAddress.toLowerCase();
      if (wallet !== order.publisherWallet.toLowerCase() && wallet !== order.agentWallet?.toLowerCase()) {
        throw new Error("ORDER_ACCESS_FORBIDDEN");
      }
      return Response.json({ order, requestId }, {
        status: 200,
        headers: { "cache-control": "no-store", "x-request-id": requestId },
      });
    } catch (error) {
      const authError = error instanceof AuthError ? error : null;
      const code = authError?.code ?? (error instanceof Error ? error.message : "ORDER_READ_UNAVAILABLE");
      return Response.json({ error: code, requestId }, {
        status: authError?.status ?? statusFor(code),
        headers: { "cache-control": "no-store", "x-request-id": requestId },
      });
    }
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { orderId } = await context.params;
  return createOrderReadHandler(getAuthService(), getOrderRuntime().store)(request, orderId);
}
