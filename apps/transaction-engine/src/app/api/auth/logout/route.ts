import { resolveRequestId } from "../../../../lib/request-context";
import { getAuthService } from "../../../../auth/runtime";
import { clearSessionCookie, readSessionCookie, type WalletAuthService } from "../../../../auth/session";

export function createLogoutHandler(service: WalletAuthService) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = resolveRequestId(request.headers);
    const token = readSessionCookie(request.headers);
    try {
      if (token) await service.revokeSession(token);
    } catch {
      return Response.json({ error: "AUTH_STORE_UNAVAILABLE", requestId }, {
        status: 503,
        headers: { "cache-control": "no-store", "x-request-id": requestId },
      });
    }
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store", "set-cookie": clearSessionCookie() },
    });
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  const token = readSessionCookie(request.headers);
  try {
    return await createLogoutHandler(getAuthService())(request);
  } catch {
    const headers: Record<string, string> = { "cache-control": "no-store", "x-request-id": requestId };
    if (!token) headers["set-cookie"] = clearSessionCookie();
    return Response.json({ error: "AUTH_STORE_UNAVAILABLE", requestId }, {
      status: 503,
      headers,
    });
  }
}
