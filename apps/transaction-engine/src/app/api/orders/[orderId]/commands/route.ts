import { OrderCommandSchema, type OrderCommand } from "@agent-market/shared-contracts";

import { getOrderRuntime } from "../../../../../application/order-runtime";
import type { OrderService } from "../../../../../application/order-service";
import { getAuthOrigin, getAuthService } from "../../../../../auth/runtime";
import { AuthError, readSessionCookie } from "../../../../../auth/session";
import { resolveRequestId } from "../../../../../lib/request-context";

const PublicCommandKeys: Readonly<Record<string, readonly string[]>> = {
  mark_funding_pending: ["type", "quoteId", "taskFingerprint"],
  accept_assignment: ["type"],
  submit_artifact: ["type", "artifact"],
  accept_delivery: ["type"],
  open_dispute: ["type", "reasonCode"],
};

type RouteContext = { params: Promise<{ orderId: string }> };

interface SessionAuthenticator {
  authenticateSession(token: string): Promise<{ walletAddress: string }>;
}

function parsePublicCommand(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ORDER_COMMAND_INVALID");
  const body = value as Record<string, unknown>;
  const type = typeof body.type === "string" ? body.type : "";
  const allowedKeys = PublicCommandKeys[type];
  if (!allowedKeys || Object.keys(body).some((key) => !allowedKeys.includes(key))) {
    throw new Error("ORDER_COMMAND_INVALID");
  }
  if (
    type === "mark_funding_pending"
    && (typeof body.quoteId !== "string" || typeof body.taskFingerprint !== "string")
  ) {
    throw new Error("ORDER_COMMAND_INVALID");
  }
  return body;
}

const statusFor = (code: string): number => {
  if (code === "ORDER_NOT_FOUND") return 404;
  if (code.includes("FORBIDDEN")) return 403;
  if (code === "ORDER_TRANSITION_INVALID" || code.endsWith("CONFLICT")) return 409;
  if (code.startsWith("ORDER_") || code === "IDEMPOTENCY_KEY_INVALID") return 400;
  return 503;
};

export function createOrderCommandHandler(input: {
  auth: SessionAuthenticator;
  service: Pick<OrderService, "execute">;
  authOrigin: URL;
}) {
  return async function POST(request: Request, rawOrderId: string): Promise<Response> {
    const requestId = resolveRequestId(request.headers);
    try {
      if (request.headers.get("origin") !== input.authOrigin.origin) throw new AuthError("AUTH_ORIGIN_MISMATCH", 403);
      const token = readSessionCookie(request.headers);
      if (!token) throw new AuthError("AUTH_SESSION_INVALID");
      const session = await input.auth.authenticateSession(token);
      const parsedId = OrderCommandSchema.options[0].shape.requestId.safeParse(rawOrderId);
      if (!parsedId.success) throw new Error("ORDER_ID_INVALID");
      const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
      if (idempotencyKey.length < 8 || idempotencyKey.length > 160) throw new Error("IDEMPOTENCY_KEY_INVALID");
      const body = parsePublicCommand(await request.json());
      const command = OrderCommandSchema.parse({
        ...body,
        requestId,
        idempotencyKey,
        actorWallet: session.walletAddress,
        occurredAt: new Date().toISOString(),
      }) as OrderCommand;
      const result = await input.service.execute(parsedId.data, command);
      return Response.json({ ...result, requestId }, {
        status: 200,
        headers: { "cache-control": "no-store", "x-request-id": requestId },
      });
    } catch (error) {
      const authError = error instanceof AuthError ? error : null;
      const validationError = error instanceof Error && error.name === "ZodError";
      const code = authError?.code
        ?? (validationError ? "ORDER_COMMAND_INVALID" : error instanceof Error ? error.message : "ORDER_COMMAND_UNAVAILABLE");
      return Response.json({ error: code, requestId }, {
        status: authError?.status ?? statusFor(code),
        headers: { "cache-control": "no-store", "x-request-id": requestId },
      });
    }
  };
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { orderId } = await context.params;
  return createOrderCommandHandler({
    auth: getAuthService(),
    service: getOrderRuntime().service,
    authOrigin: getAuthOrigin(),
  })(request, orderId);
}
