import { validate as isUuid } from "uuid";

import { getOrderRuntime } from "../../../../../application/order-runtime";
import { RiskPricingServiceError, type RiskPricingService } from "../../../../../application/risk-pricing-service";
import { getAuthService } from "../../../../../auth/runtime";
import { AuthError, readSessionCookie } from "../../../../../auth/session";
import { resolveRequestId } from "../../../../../lib/request-context";

type RouteContext = { params: Promise<{ taskId: string }> };
interface SessionAuthenticator { authenticateSession(token: string): Promise<{ walletAddress: string }>; }

const headers = (requestId: string) => ({ "cache-control": "no-store", "x-request-id": requestId });

export function createRiskContextReadHandler(input: {
  auth: SessionAuthenticator;
  service: Pick<RiskPricingService, "readRiskContext">;
}) {
  return async function GET(request: Request, taskId: string): Promise<Response> {
    const requestId = resolveRequestId(request.headers);
    try {
      const token = readSessionCookie(request.headers);
      if (!token) throw new AuthError("AUTH_SESSION_INVALID");
      const session = await input.auth.authenticateSession(token);
      if (!isUuid(taskId)) throw new RiskPricingServiceError("RISK_TASK_ID_INVALID", 400);
      const context = await input.service.readRiskContext({ taskId, actorWallet: session.walletAddress });
      return Response.json({ ...context, requestId }, { status: 200, headers: headers(requestId) });
    } catch (error) {
      const authError = error instanceof AuthError ? error : null;
      const serviceError = error instanceof RiskPricingServiceError ? error : null;
      const code = authError?.code ?? serviceError?.code ?? "RISK_CONTEXT_UNAVAILABLE";
      return Response.json({ error: code, requestId }, {
        status: authError?.status ?? serviceError?.status ?? 503,
        headers: headers(requestId),
      });
    }
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { taskId } = await context.params;
  const requestId = resolveRequestId(request.headers);
  try {
    return await createRiskContextReadHandler({
      auth: getAuthService(), service: getOrderRuntime().riskPricing,
    })(request, taskId);
  } catch {
    return Response.json({ error: "RISK_CONTEXT_UNAVAILABLE", requestId }, {
      status: 503, headers: headers(requestId),
    });
  }
}
