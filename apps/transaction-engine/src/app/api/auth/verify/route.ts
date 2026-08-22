import { resolveRequestId } from "../../../../lib/request-context";
import { getAuthService } from "../../../../auth/runtime";
import { AuthError, serializeSessionCookie, type WalletAuthService } from "../../../../auth/session";

export function createVerifyHandler(service: WalletAuthService) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = resolveRequestId(request.headers);
    let message: string;
    let signature: string;
    try {
      const body = await request.json() as { message?: unknown; signature?: unknown };
      if (typeof body.message !== "string" || typeof body.signature !== "string") throw new AuthError("AUTH_VERIFY_INVALID", 400);
      message = body.message;
      signature = body.signature;
    } catch {
      return Response.json({ error: "AUTH_VERIFY_INVALID", requestId }, {
        status: 400,
        headers: { "cache-control": "no-store", "x-request-id": requestId },
      });
    }
    try {
      const verified = await service.verifyChallenge(message, signature);
      return Response.json({ session: verified.session, requestId }, {
        headers: {
          "cache-control": "no-store",
          "x-request-id": requestId,
          "set-cookie": serializeSessionCookie(verified.sessionToken),
        },
      });
    } catch (error) {
      const authError = error instanceof AuthError ? error : new AuthError("AUTH_STORE_UNAVAILABLE", 503);
      return Response.json({ error: authError.code, requestId }, {
        status: authError.status,
        headers: { "cache-control": "no-store", "x-request-id": requestId },
      });
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  try {
    return await createVerifyHandler(getAuthService())(request);
  } catch {
    return Response.json({ error: "AUTH_STORE_UNAVAILABLE", requestId }, {
      status: 503,
      headers: { "cache-control": "no-store", "x-request-id": requestId },
    });
  }
}
