import { resolveRequestId } from "../../../../lib/request-context";
import { WalletAddressSchema } from "@agent-market/shared-contracts";
import { formatChallengeMessage } from "../../../../auth/challenge";
import { getAuthOrigin, getAuthService } from "../../../../auth/runtime";
import type { WalletAuthService } from "../../../../auth/session";

function jsonError(error: string, requestId: string, status: number): Response {
  return Response.json({ error, requestId }, {
    status,
    headers: { "cache-control": "no-store", "x-request-id": requestId },
  });
}

export function createChallengeHandler(service: WalletAuthService, authOrigin: URL) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = resolveRequestId(request.headers);
    const requestUrl = new URL(request.url);
    const forwardedHost = request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
    if (
      request.headers.get("origin") !== authOrigin.origin
      || requestUrl.origin !== authOrigin.origin
      || (forwardedHost !== undefined && forwardedHost !== authOrigin.host)
    ) return jsonError("AUTH_ORIGIN_MISMATCH", requestId, 403);
    let address: string;
    try {
      const body = await request.json() as { address?: unknown };
      address = WalletAddressSchema.parse(body.address);
    } catch {
      return jsonError("AUTH_CHALLENGE_INVALID", requestId, 400);
    }
    try {
      const challenge = await service.issueChallenge(address, {
        requestId,
        domain: authOrigin.hostname,
        uri: authOrigin.origin,
      });
      return Response.json({ challenge, message: formatChallengeMessage(challenge), requestId }, {
        status: 201,
        headers: { "cache-control": "no-store", "x-request-id": requestId },
      });
    } catch {
      return jsonError("AUTH_STORE_UNAVAILABLE", requestId, 503);
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  try {
    return await createChallengeHandler(getAuthService(), getAuthOrigin())(request);
  } catch {
    return jsonError("AUTH_STORE_UNAVAILABLE", requestId, 503);
  }
}
