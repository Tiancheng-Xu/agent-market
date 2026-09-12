import postgres from "postgres";
import { getAuthOrigin, getAuthService } from "../auth/runtime";
import { AuthError, readSessionCookie, type WalletAuthService } from "../auth/session";
import { MatchingService } from "./service";
import { JsonRpcVrfOracleReader } from "./oracle-reader";

let service: MatchingService | undefined;
function normalizedDatabasePrincipal(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error();
    const normalize = (part: string) => decodeURIComponent(part).normalize("NFKC");
    const host = normalize(url.hostname || url.searchParams.get("host") || "").toLowerCase();
    const port = url.port || "5432";
    const database = normalize(url.pathname.replace(/^\/+/, "") || url.searchParams.get("dbname") || "");
    const username = normalize(url.username || url.searchParams.get("user") || "");
    if (!host || !database || !username) throw new Error();
    return JSON.stringify([host, port, database, username]);
  } catch {
    throw new Error("MATCH_DATABASE_CONFIGURATION_INVALID");
  }
}
export function assertSeparateVrfChainReaderCredentials(databaseUrl: string, readerDatabaseUrl: string) {
  if (normalizedDatabasePrincipal(databaseUrl) === normalizedDatabasePrincipal(readerDatabaseUrl)) {
    throw new Error("VRF_CHAIN_READER_CREDENTIAL_REUSE");
  }
}
function runtime() {
  if (service) return service;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("MATCH_DATABASE_UNAVAILABLE");
  const selectorAddress = process.env.VRF_SELECTOR_ADDRESS;
  const coordinatorAddress = process.env.VRF_COORDINATOR_ADDRESS;
  const evidenceUrl = process.env.VRF_CHAIN_READER_DATABASE_URL;
  if (evidenceUrl) assertSeparateVrfChainReaderCredentials(url,evidenceUrl);
  const rpc=process.env.SEPOLIA_RPC_URL, selectorHash=process.env.VRF_SELECTOR_CODE_HASH, coordinatorHash=process.env.VRF_COORDINATOR_CODE_HASH;
  service = new MatchingService(postgres(url), selectorAddress && coordinatorAddress ? {
    namespace: "agent-market-exploration", chainId: 11155111, selectorAddress, coordinatorAddress,
  } : null, rpc && selectorHash && coordinatorHash && evidenceUrl ? new JsonRpcVrfOracleReader(rpc,selectorHash,coordinatorHash) : null,
  evidenceUrl ? postgres(evidenceUrl) : null);
  return service;
}
export function matchingHandler(deps: { auth: WalletAuthService; origin: URL; service: MatchingService }) {
  return async (request: Request, target: string, kind: "task" | "agent") => {
    try {
      if (request.method !== "GET" && request.headers.get("origin") !== deps.origin.origin) throw new AuthError("AUTH_ORIGIN_MISMATCH",403);
      const cookie = readSessionCookie(request.headers);
      if (!cookie) throw new AuthError("AUTH_SESSION_INVALID");
      const session = await deps.auth.authenticateSession(cookie);
      if (request.method !== "GET") deps.auth.requireRecentAuth(session);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(target)) throw new Error("MATCH_INPUT_INVALID");
      const body: unknown = request.method === "GET" ? null : await request.json();
      const result = kind === "task" && request.method === "GET" ? await deps.service.status(session.walletAddress,target)
        : kind === "task" && body && typeof body === "object" && !Array.isArray(body)
          && Object.keys(body).length === 1 && (body as {action?:unknown}).action === "refresh"
          ? await deps.service.refresh(session.walletAddress,target)
        : kind === "task" ? await deps.service.configure(session.walletAddress,target,body)
        : await deps.service.setAccess(session.walletAddress,target,body);
      return Response.json(result,{headers:{"cache-control":"no-store"}});
    } catch (error) {
      const known = error instanceof AuthError ? error.code : error instanceof Error ? error.message : "MATCH_UNAVAILABLE";
      const code = /^(MATCH_|VRF_|AUTH_)[A-Z_]+$/u.test(known) ? known : "MATCH_UNAVAILABLE";
      const status = error instanceof AuthError ? error.status : code.includes("FORBIDDEN") ? 403
        : code.includes("INVALID") ? 400 : /LOCKED|STALE|CONFLICT/u.test(code) ? 409 : 503;
      return Response.json({error:code},{status,headers:{"cache-control":"no-store"}});
    }
  };
}
export async function handleMatching(request: Request, target: string, kind: "task" | "agent") {
  try { return await matchingHandler({auth:getAuthService(),origin:getAuthOrigin(),service:runtime()})(request,target,kind); }
  catch { return Response.json({error:"MATCH_UNAVAILABLE"},{status:503}); }
}
