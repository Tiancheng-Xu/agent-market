import { AuthError, readSessionCookie } from "../auth/session";
import { QueenPlanningError } from "./queen-planning-request";
import type { PlanningStatusInput, readQueenPlanningStatus } from "./queen-planning-status";

export function createQueenPlanningStatusHandler(options: {
  authOrigin: URL;
  auth: { authenticateSession(token: string): Promise<{ walletAddress: string }> };
  read: (input: PlanningStatusInput) => ReturnType<typeof readQueenPlanningStatus>;
}) {
  return async (request: Request, taskId: string): Promise<Response> => {
    const headers = { "cache-control": "no-store", vary: "Cookie, Origin" };
    try {
      if (request.method !== "GET") return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405, headers: { ...headers, allow: "GET" } });
      const origin = request.headers.get("origin");
      if ((origin !== null && origin !== options.authOrigin.origin) || request.headers.get("sec-fetch-site") === "cross-site") {
        throw new AuthError("AUTH_ORIGIN_MISMATCH", 403);
      }
      const token = readSessionCookie(request.headers);
      if (!token) throw new AuthError("AUTH_SESSION_INVALID");
      const session = await options.auth.authenticateSession(token);
      if (new URL(request.url).search) throw new QueenPlanningError("QUEEN_PLANNING_INPUT_INVALID", 400);
      const status = await options.read({ taskId, actorWallet: session.walletAddress });
      return Response.json(status, { headers });
    } catch (error) {
      const known = error instanceof AuthError || error instanceof QueenPlanningError ? error : null;
      return Response.json({ error: known?.code ?? "QUEEN_PLANNING_UNAVAILABLE" }, { status: known?.status ?? 503, headers });
    }
  };
}
