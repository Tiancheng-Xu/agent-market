import { TaskFingerprintSchema } from "@agent-market/shared-contracts";
import { validate as isUuid } from "uuid";

import { getOrderRuntime } from "../../../../../../application/order-runtime";
import { RiskPricingServiceError, type RiskPricingService } from "../../../../../../application/risk-pricing-service";
import { getAuthOrigin, getAuthService } from "../../../../../../auth/runtime";
import { AuthError, readSessionCookie } from "../../../../../../auth/session";
import { resolveRequestId } from "../../../../../../lib/request-context";

type RouteContext = { params: Promise<{ taskId: string }> };
interface SessionAuthenticator { authenticateSession(token: string): Promise<{ walletAddress: string }>; }

const headers = (requestId: string) => ({ "cache-control": "no-store", "x-request-id": requestId });

function parseConfirmation(value: unknown): { quoteId: string; taskFingerprint: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RiskPricingServiceError("RISK_QUOTE_CONFIRMATION_INVALID", 400);
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 2 || !("quoteId" in body) || !("taskFingerprint" in body)
    || typeof body.quoteId !== "string" || !isUuid(body.quoteId)) {
    throw new RiskPricingServiceError("RISK_QUOTE_CONFIRMATION_INVALID", 400);
  }
  const fingerprint = TaskFingerprintSchema.safeParse(body.taskFingerprint);
  if (!fingerprint.success) throw new RiskPricingServiceError("RISK_QUOTE_CONFIRMATION_INVALID", 400);
  return { quoteId: body.quoteId, taskFingerprint: fingerprint.data };
}

export function createRiskQuoteConfirmationHandler(input: {
  auth: SessionAuthenticator;
  service: Pick<RiskPricingService, "confirmQuote">;
  authOrigin: URL;
}) {
  return async function POST(request: Request, taskId: string): Promise<Response> {
    const requestId = resolveRequestId(request.headers);
    try {
      if (request.headers.get("origin") !== input.authOrigin.origin) throw new AuthError("AUTH_ORIGIN_MISMATCH", 403);
      const token = readSessionCookie(request.headers);
      if (!token) throw new AuthError("AUTH_SESSION_INVALID");
      const session = await input.auth.authenticateSession(token);
      if (!isUuid(taskId)) throw new RiskPricingServiceError("RISK_TASK_ID_INVALID", 400);
      let rawBody: unknown;
      try { rawBody = await request.json(); } catch { throw new RiskPricingServiceError("RISK_QUOTE_CONFIRMATION_INVALID", 400); }
      const body = parseConfirmation(rawBody);
      const confirmation = await input.service.confirmQuote({ ...body, taskId, actorWallet: session.walletAddress });
      return Response.json({ confirmation, requestId }, { status: 200, headers: headers(requestId) });
    } catch (error) {
      const authError = error instanceof AuthError ? error : null;
      const serviceError = error instanceof RiskPricingServiceError ? error : null;
      const code = authError?.code ?? serviceError?.code ?? "RISK_QUOTE_CONFIRMATION_UNAVAILABLE";
      return Response.json({ error: code, requestId }, {
        status: authError?.status ?? serviceError?.status ?? 503,
        headers: headers(requestId),
      });
    }
  };
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { taskId } = await context.params;
  const requestId = resolveRequestId(request.headers);
  try {
    return await createRiskQuoteConfirmationHandler({
      auth: getAuthService(), service: getOrderRuntime().riskPricing, authOrigin: getAuthOrigin(),
    })(request, taskId);
  } catch {
    return Response.json({ error: "RISK_QUOTE_CONFIRMATION_UNAVAILABLE", requestId }, {
      status: 503, headers: headers(requestId),
    });
  }
}
