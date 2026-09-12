import type { WalletSessionV1 } from "@agent-market/shared-contracts";

import { getAuthOrigin, getAuthService } from "../../../../../../auth/runtime";
import { AuthError, readSessionCookie } from "../../../../../../auth/session";
import { ChainResourceError, type ChainResourceRepository } from "../../../../../../chain/resources";
import { getTransactionRuntime } from "../../../../../../chain/runtime";
import { resolveRequestId } from "../../../../../../lib/request-context";

interface ReviewAuth {
  authenticateSession(token: string): Promise<WalletSessionV1>;
  requireRecentAuth(session: WalletSessionV1): void;
}

export function createArbitrationReviewHandler(input: {
  auth: ReviewAuth;
  resources: ChainResourceRepository;
  authOrigin: URL;
  now?: () => Date;
}) {
  return async function handle(request: Request, resourceId: string): Promise<Response> {
    const requestId = resolveRequestId(request.headers);
    const headers = { "cache-control": "no-store", "x-request-id": requestId, vary: "Cookie, Origin" };
    try {
      if (request.method !== "GET" && request.method !== "POST") {
        return Response.json({ error: "METHOD_NOT_ALLOWED", requestId }, { status: 405, headers: { ...headers, allow: "GET, POST" } });
      }
      const origin = request.headers.get("origin");
      if ((request.method === "POST" && origin !== input.authOrigin.origin)
          || (origin !== null && origin !== input.authOrigin.origin)
          || request.headers.get("sec-fetch-site") === "cross-site") {
        throw new AuthError("AUTH_ORIGIN_MISMATCH", 403);
      }
      const token = readSessionCookie(request.headers);
      if (!token) throw new AuthError("AUTH_SESSION_INVALID");
      const session = await input.auth.authenticateSession(token);
      const now = input.now?.() ?? new Date();
      if (request.method === "GET") {
        const review = await input.resources.readArbitrationReview(resourceId, session.walletAddress, now);
        return Response.json({ review, requestId }, { headers });
      }
      input.auth.requireRecentAuth(session);
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        throw new AuthError("CHAIN_ARBITRATION_REVIEW_INVALID", 415);
      }
      const body = await request.json() as Record<string, unknown>;
      if (Object.keys(body).length !== 1 || typeof body.agentsWin !== "boolean") {
        throw new AuthError("CHAIN_ARBITRATION_REVIEW_INVALID", 400);
      }
      const review = await input.resources.recordArbitrationReview(resourceId, session.walletAddress, { agentsWin: body.agentsWin }, now);
      return Response.json({ review, requestId }, { status: 201, headers });
    } catch (error) {
      const known = error instanceof AuthError ? error
        : error instanceof ChainResourceError ? new AuthError(error.code, error.status) : null;
      return Response.json({ error: known?.code ?? "CHAIN_SERVICE_UNAVAILABLE", requestId }, {
        status: known?.status ?? 503, headers,
      });
    }
  };
}

export async function GET(request: Request, context: { params: Promise<{ resourceId: string }> }): Promise<Response> {
  const { resourceId } = await context.params;
  const runtime = getTransactionRuntime();
  return createArbitrationReviewHandler({ auth: getAuthService(), resources: runtime.resources, authOrigin: getAuthOrigin() })(request, resourceId);
}

export async function POST(request: Request, context: { params: Promise<{ resourceId: string }> }): Promise<Response> {
  const { resourceId } = await context.params;
  const runtime = getTransactionRuntime();
  return createArbitrationReviewHandler({ auth: getAuthService(), resources: runtime.resources, authOrigin: getAuthOrigin() })(request, resourceId);
}
