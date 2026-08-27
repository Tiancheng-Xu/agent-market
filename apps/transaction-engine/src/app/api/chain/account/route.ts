import { getAuthOrigin, getAuthService } from "../../../../auth/runtime";
import { AuthError, readSessionCookie, type WalletAuthService } from "../../../../auth/session";
import { deriveAccountResourceId } from "../../../../chain/policy";
import { getTransactionRuntime } from "../../../../chain/runtime";
import { ChainResourceError, type ChainResourceRepository } from "../../../../chain/resources";
import { resolveRequestId } from "../../../../lib/request-context";

interface AccountHandlerDependencies {
  auth: WalletAuthService;
  resources: ChainResourceRepository;
  authOrigin: URL;
}

export function createChainAccountHandler({ auth, resources, authOrigin }: AccountHandlerDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = resolveRequestId(request.headers);
    try {
      if (request.headers.get("origin") !== authOrigin.origin) throw new AuthError("AUTH_ORIGIN_MISMATCH", 403);
      const token = readSessionCookie(request.headers);
      if (!token) throw new AuthError("AUTH_SESSION_INVALID");
      const session = await auth.authenticateSession(token);
      auth.requireRecentAuth(session);
      const resource = await resources.createChainAccount(deriveAccountResourceId(session.walletAddress), session.walletAddress);
      return Response.json({ account: { resourceId: resource.resourceId, status: resource.status } }, {
        status: 201,
        headers: { "cache-control": "no-store", "x-request-id": requestId },
      });
    } catch (error) {
      const authError = error instanceof AuthError ? error : null;
      const resourceError = error instanceof ChainResourceError ? error : null;
      return Response.json({ error: authError?.code ?? resourceError?.code ?? "CHAIN_ACCOUNT_UNAVAILABLE", requestId }, {
        status: authError?.status ?? resourceError?.status ?? 503,
        headers: { "cache-control": "no-store", "x-request-id": requestId },
      });
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = resolveRequestId(request.headers);
  try {
    const runtime = getTransactionRuntime();
    return await createChainAccountHandler({ auth: getAuthService(), resources: runtime.resources, authOrigin: getAuthOrigin() })(request);
  } catch {
    return Response.json({ error: "CHAIN_ACCOUNT_UNAVAILABLE", requestId }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
