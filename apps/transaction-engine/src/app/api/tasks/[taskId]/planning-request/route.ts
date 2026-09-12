import { getOrderRuntime } from "../../../../../application/order-runtime";
import { QueenPlanningError, requestQueenPlanning } from "../../../../../application/queen-planning-request";
import { getAuthOrigin, getAuthService } from "../../../../../auth/runtime";
import { AuthError, readSessionCookie } from "../../../../../auth/session";
import { readQueenPlanningStatus } from "../../../../../application/queen-planning-status";
import { createQueenPlanningStatusHandler } from "../../../../../application/queen-planning-status-http";

export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    return await createQueenPlanningStatusHandler({
      authOrigin: getAuthOrigin(), auth: getAuthService(),
      read: input => readQueenPlanningStatus(getOrderRuntime().sql, input),
    })(request, (await context.params).taskId);
  } catch {
    return Response.json({ error: "QUEEN_PLANNING_UNAVAILABLE" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const headers = { "cache-control": "no-store" };
  try {
    // Both switches are required: accepting work without a live consumer would
    // create an unbounded queue that cannot make forward progress.
    if (process.env.QUEEN_ASYNC_PLANNING_ENABLED !== "true"
        || process.env.QUEEN_ASYNC_WORKER_READY !== "true") {
      return Response.json({ error: "QUEEN_ASYNC_PLANNING_DISABLED" }, { status: 503, headers });
    }
    if (request.headers.get("origin") !== getAuthOrigin().origin) {
      throw new AuthError("AUTH_ORIGIN_MISMATCH", 403);
    }
    const token = readSessionCookie(request.headers);
    if (!token) throw new AuthError("AUTH_SESSION_INVALID");
    const session = await getAuthService().authenticateSession(token);
    let body: unknown;
    try { body = await request.json(); } catch { throw new QueenPlanningError("QUEEN_PLANNING_INPUT_INVALID", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).length !== 1 || !("taskVersion" in body)
        || typeof body.taskVersion !== "number") {
      throw new QueenPlanningError("QUEEN_PLANNING_INPUT_INVALID", 400);
    }
    const { taskId } = await context.params;
    const result = await requestQueenPlanning(getOrderRuntime().sql, {
      taskId, actorWallet: session.walletAddress, expectedTaskVersion: body.taskVersion,
    });
    return Response.json(result, { status: 202, headers });
  } catch (error) {
    const known = error instanceof AuthError || error instanceof QueenPlanningError ? error : null;
    return Response.json({ error: known?.code ?? "QUEEN_PLANNING_UNAVAILABLE" }, {
      status: known?.status ?? 503, headers,
    });
  }
}
