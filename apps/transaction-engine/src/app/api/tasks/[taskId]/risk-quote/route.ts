import { RiskQuoteRequestSchema } from "@agent-market/shared-contracts";
import { validate as isUuid } from "uuid";

import { getOrderRuntime } from "../../../../../application/order-runtime";
import { RiskPricingServiceError, type RiskPricingService } from "../../../../../application/risk-pricing-service";
import { getAuthOrigin, getAuthService } from "../../../../../auth/runtime";
import { AuthError, readSessionCookie } from "../../../../../auth/session";
import { resolveRequestId } from "../../../../../lib/request-context";

type RouteContext = { params: Promise<{ taskId: string }> };
interface SessionAuthenticator { authenticateSession(token: string): Promise<{ walletAddress: string }>; }

const headers = (requestId: string) => ({ "cache-control": "no-store", "x-request-id": requestId });

export function createRiskQuoteHandler(input: {
  auth: SessionAuthenticator;
  service: Pick<RiskPricingService, "issueQuote">;
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
      let body: unknown;
      try { body = await request.json(); } catch { throw new RiskPricingServiceError("RISK_QUOTE_REQUEST_INVALID", 400); }
      const parsed = RiskQuoteRequestSchema.safeParse(body);
      if (!parsed.success) throw new RiskPricingServiceError("RISK_QUOTE_REQUEST_INVALID", 400);
      const record = await input.service.issueQuote({
        taskId,
        expectedTaskFingerprint: parsed.data.taskFingerprint,
        actorWallet: session.walletAddress,
      });
      return Response.json({ quoteId: record.id, quoteHash: record.basisFingerprint, quote: record.quote, version: record.version, requestId }, {
        status: 201, headers: headers(requestId),
      });
    } catch (error) {
      const authError = error instanceof AuthError ? error : null;
      const serviceError = error instanceof RiskPricingServiceError ? error : null;
      const code = authError?.code ?? serviceError?.code ?? "RISK_QUOTE_UNAVAILABLE";
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
    return await createRiskQuoteHandler({
      auth: getAuthService(), service: getOrderRuntime().riskPricing, authOrigin: getAuthOrigin(),
    })(request, taskId);
  } catch {
    return Response.json({ error: "RISK_QUOTE_UNAVAILABLE", requestId }, {
      status: 503, headers: headers(requestId),
    });
  }
}

export function createRiskQuoteReadHandler(input: {
  auth: SessionAuthenticator;
  service: Pick<RiskPricingService, 'readCurrentQuote'>;
}) {
  return async function GET(request: Request, taskId: string): Promise<Response> {
    const requestId = resolveRequestId(request.headers);
    try {
      const token = readSessionCookie(request.headers);
      if (!token) throw new AuthError('AUTH_SESSION_INVALID');
      const session = await input.auth.authenticateSession(token);
      if (!isUuid(taskId)) throw new RiskPricingServiceError('RISK_TASK_ID_INVALID', 400);
      const result = await input.service.readCurrentQuote({ taskId, actorWallet: session.walletAddress });
      return Response.json({ ...result, requestId }, { headers: headers(requestId) });
    } catch (error) {
      const known = error instanceof AuthError || error instanceof RiskPricingServiceError ? error : null;
      return Response.json({ error: known?.code ?? 'RISK_QUOTE_UNAVAILABLE', requestId }, {
        status: known?.status ?? 503, headers: headers(requestId),
      });
    }
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { taskId } = await context.params;
  const requestId = resolveRequestId(request.headers);
  try {
    return await createRiskQuoteReadHandler({ auth: getAuthService(), service: getOrderRuntime().riskPricing })(request, taskId);
  } catch {
    return Response.json({ error: 'RISK_QUOTE_UNAVAILABLE', requestId }, { status: 503, headers: headers(requestId) });
  }
}
