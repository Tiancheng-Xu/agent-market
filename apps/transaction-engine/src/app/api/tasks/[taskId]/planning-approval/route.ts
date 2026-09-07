import type { Sql } from "postgres";
import { getOrderRuntime } from "../../../../../application/order-runtime";
import {
  QueenPlanningError,
} from "../../../../../application/queen-planning-request";
import {
  recordQueenPlanningApproval,
  type ApprovalInput,
} from "../../../../../application/queen-planning-approval";
import { getAuthOrigin, getAuthService } from "../../../../../auth/runtime";
import { AuthError, readSessionCookie } from "../../../../../auth/session";
import { resolveRequestId } from "../../../../../lib/request-context";

type Authenticator = { authenticateSession(token: string): Promise<{ walletAddress: string }> };
type ApprovalPort = (input: ApprovalInput) => Promise<{ approvalId: string; status: "queued"; duplicate: boolean }>;

const responseHeaders = (requestId: string) => ({ "cache-control": "no-store", "x-request-id": requestId });

export function createQueenPlanningApprovalHandler(options: {
  enabled: boolean;
  authOrigin: URL;
  auth: Authenticator;
  approve: ApprovalPort;
}) {
  return async (request: Request, taskId: string): Promise<Response> => {
    const requestId = resolveRequestId(request.headers);
    try {
      if (!options.enabled) throw new QueenPlanningError("QUEEN_ASYNC_PLANNING_DISABLED", 503);
      if (request.headers.get("origin") !== options.authOrigin.origin) {
        throw new AuthError("AUTH_ORIGIN_MISMATCH", 403);
      }
      const token = readSessionCookie(request.headers);
      if (!token) throw new AuthError("AUTH_SESSION_INVALID");
      const session = await options.auth.authenticateSession(token);
      let value: unknown;
      try { value = await request.json(); } catch {
        throw new QueenPlanningError("QUEEN_APPROVAL_INPUT_INVALID", 400);
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new QueenPlanningError("QUEEN_APPROVAL_INPUT_INVALID", 400);
      }
      const body = value as Record<string, unknown>;
      const allowed = ["approved", "graphRevision", "requestId", "taskFingerprint", "taskVersion"];
      if (Object.keys(body).length !== allowed.length || Object.keys(body).some(key => !allowed.includes(key))
          || typeof body.requestId !== "string" || typeof body.taskVersion !== "number"
          || typeof body.graphRevision !== "number" || typeof body.taskFingerprint !== "string"
          || typeof body.approved !== "boolean") {
        throw new QueenPlanningError("QUEEN_APPROVAL_INPUT_INVALID", 400);
      }
      const result = await options.approve({
        requestId: body.requestId,
        taskId,
        actorWallet: session.walletAddress,
        expectedTaskVersion: body.taskVersion,
        graphRevision: body.graphRevision,
        taskFingerprint: body.taskFingerprint,
        approved: body.approved,
      });
      return Response.json({ ...result, requestId }, { status: 202, headers: responseHeaders(requestId) });
    } catch (error) {
      const known = error instanceof AuthError || error instanceof QueenPlanningError ? error : null;
      return Response.json({ error: known?.code ?? "QUEEN_APPROVAL_UNAVAILABLE", requestId }, {
        status: known?.status ?? 503,
        headers: responseHeaders(requestId),
      });
    }
  };
}

export async function POST(request: Request, context: { params: Promise<{ taskId: string }> }) {
  const runtime = getOrderRuntime();
  const handler = createQueenPlanningApprovalHandler({
    enabled: process.env.QUEEN_ASYNC_PLANNING_ENABLED === "true"
      && process.env.QUEEN_ASYNC_WORKER_READY === "true",
    authOrigin: getAuthOrigin(),
    auth: getAuthService(),
    approve: (input) => recordQueenPlanningApproval(runtime.sql as Sql, input),
  });
  return handler(request, (await context.params).taskId);
}
