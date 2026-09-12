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

type ConfirmationBody = {
  quoteId: string;
  taskFingerprint: string;
  quoteHash: string;
} & ({ actorType: "publisher"; agentId?: never } | { actorType: "agent"; agentId: string });

function parseConfirmation(value: unknown): ConfirmationBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RiskPricingServiceError("RISK_QUOTE_CONFIRMATION_INVALID", 400);
  }
  const body = value as Record<string, unknown>;
  const actorType = body.actorType;
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : undefined;
  const expectedKeys = actorType === "publisher"
    ? ["actorType", "quoteHash", "quoteId", "taskFingerprint"]
    : ["actorType", "agentId", "quoteHash", "quoteId", "taskFingerprint"];
  const actualKeys = Object.keys(body).sort();
  if ((actorType !== "publisher" && actorType !== "agent")
    || actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || typeof body.quoteId !== "string" || !isUuid(body.quoteId)) {
    throw new RiskPricingServiceError("RISK_QUOTE_CONFIRMATION_INVALID", 400);
  }
  if (actorType === "agent" && (!agentId || agentId.length > 160)) {
    throw new RiskPricingServiceError("RISK_QUOTE_CONFIRMATION_INVALID", 400);
  }
  const fingerprint = TaskFingerprintSchema.safeParse(body.taskFingerprint);
  const quoteHash = TaskFingerprintSchema.safeParse(body.quoteHash);
  if (!fingerprint.success || !quoteHash.success) throw new RiskPricingServiceError("RISK_QUOTE_CONFIRMATION_INVALID", 400);
  return {
    quoteId: body.quoteId,
    taskFingerprint: fingerprint.data,
    quoteHash: quoteHash.data,
    actorType,
    ...(actorType === "agent" ? { agentId: agentId! } : {}),
  } as ConfirmationBody;
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
