import { getOrderRuntime } from "../../../../application/order-runtime";
import { recordQueenPlanningApproval } from "../../../../application/queen-planning-approval";
import { requestQueenPlanning } from "../../../../application/queen-planning-request";
import { readQueenPlanningStatus } from "../../../../application/queen-planning-status";
import {
  createQueenGraphqlGateway, queenGraphqlMethodNotAllowed, queenGraphqlUnavailable,
} from "../../../../application/queen-graphql-gateway";
import { getAuthOrigin, getAuthService } from "../../../../auth/runtime";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    return await createQueenGraphqlGateway({
      authOrigin: getAuthOrigin(),
      auth: { authenticateSession: token => getAuthService().authenticateSession(token) },
      // These are admission switches, not evidence of a live worker/supervisor.
      planningEnabled: process.env.QUEEN_ASYNC_PLANNING_ENABLED === "true",
      workerReady: process.env.QUEEN_ASYNC_WORKER_READY === "true",
      propose: input => requestQueenPlanning(getOrderRuntime().sql, input),
      confirm: input => recordQueenPlanningApproval(getOrderRuntime().sql, input),
      read: input => readQueenPlanningStatus(getOrderRuntime().sql, input),
    })(request);
  } catch {
    return queenGraphqlUnavailable();
  }
}

export function GET(): Response { return queenGraphqlMethodNotAllowed(); }
