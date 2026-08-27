import { getAuthOrigin, getAuthService } from "../../../../auth/runtime";
import { AuthError, readSessionCookie, type WalletAuthService } from "../../../../auth/session";
import { type VaultPositionReader } from "../../../../chain/readers";
import { getTransactionRuntime } from "../../../../chain/runtime";
import { ChainResourceError, normalizeResourceId, type ChainResourceRepository } from "../../../../chain/resources";
import { resolveRequestId } from "../../../../lib/request-context";

interface PositionHandlerDependencies {
  auth: WalletAuthService;
  resources: ChainResourceRepository;
  reader: VaultPositionReader;
  authOrigin: URL;
}

export function createVaultPositionHandler({ auth, resources, reader, authOrigin }: PositionHandlerDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = resolveRequestId(request.headers);
    try {
      if (request.headers.get("origin") !== authOrigin.origin) throw new AuthError("AUTH_ORIGIN_MISMATCH", 403);
      const token = readSessionCookie(request.headers);
      if (!token) throw new AuthError("AUTH_SESSION_INVALID");
      const session = await auth.authenticateSession(token);
      const body = await request.json() as Record<string, unknown>;
      if (typeof body.resourceId !== "string" || Object.keys(body).some((key) => key !== "resourceId")) {
        throw new AuthError("CHAIN_POSITION_REQUEST_INVALID", 400);
      }
      const resourceId = normalizeResourceId(body.resourceId);
      await resources.requireAuthorized(resourceId, session.walletAddress, "stake");
      const position = await reader.readPosition(session.walletAddress);
      return Response.json({ position, requestId }, {
        status: 200,
        headers: { "cache-control": "no-store", "x-request-id": requestId },
      });
    } catch (error) {
      const authError = error instanceof AuthError ? error : null;
      const resourceError = error instanceof ChainResourceError ? error : null;
      const code = authError?.code ?? resourceError?.code ?? (error instanceof Error ? error.message : "CHAIN_POSITION_UNAVAILABLE");
      const status = authError?.status ?? resourceError?.status ?? 503;
      return Response.json({ error: code, requestId }, {
        status,
        headers: { "cache-control": "no-store", "x-request-id": requestId },
      });
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  try {
    const runtime = getTransactionRuntime();
    if (!runtime.vaultReadback) throw new Error("CHAIN_POSITION_UNAVAILABLE");
    return await createVaultPositionHandler({
      auth: getAuthService(), resources: runtime.resources, reader: runtime.vaultReadback, authOrigin: getAuthOrigin(),
    })(request);
  } catch {
    return Response.json({ error: "CHAIN_POSITION_UNAVAILABLE", requestId }, {
      status: 503, headers: { "cache-control": "no-store", "x-request-id": requestId },
    });
  }
}
