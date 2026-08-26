import { WalletAddressSchema } from "@agent-market/shared-contracts";
import { randomUUID } from "node:crypto";

import { getAuthOrigin, getAuthService } from "../../../auth/runtime";
import { AuthError, readSessionCookie, type WalletAuthService } from "../../../auth/session";
import { getTransactionRuntime } from "../../../chain/runtime";
import { ChainResourceError, type ChainResourceRepository } from "../../../chain/resources";
import { resolveRequestId } from "../../../lib/request-context";

interface TaskDraftInput {
  title: string;
  description: string;
  category: string;
  tags: string[];
  budgetAtomic: string;
}

class TaskDraftValidationError extends Error {}

function parseTaskDraftInput(value: unknown): TaskDraftInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TaskDraftValidationError();
  const body = value as Record<string, unknown>;
  const allowed = new Set(["title", "description", "category", "tags", "budgetAtomic"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new TaskDraftValidationError();
  const readString = (key: string, min: number, max: number) => {
    const result = typeof body[key] === "string" ? body[key].trim() : "";
    if (result.length < min || result.length > max) throw new TaskDraftValidationError();
    return result;
  };
  const rawTags = body.tags ?? [];
  if (!Array.isArray(rawTags) || rawTags.length > 12) throw new TaskDraftValidationError();
  const tags = rawTags.map((tag) => {
    if (typeof tag !== "string") throw new TaskDraftValidationError();
    const normalized = tag.trim();
    if (normalized.length < 1 || normalized.length > 48) throw new TaskDraftValidationError();
    return normalized;
  });
  const budgetAtomic = readString("budgetAtomic", 1, 78);
  if (!/^[1-9][0-9]*$/u.test(budgetAtomic)) throw new TaskDraftValidationError();
  return {
    title: readString("title", 3, 160),
    description: readString("description", 3, 4_000),
    category: readString("category", 1, 64),
    tags,
    budgetAtomic,
  };
}

interface TaskDraftHandlerDependencies {
  auth: WalletAuthService;
  resources: ChainResourceRepository;
  authOrigin: URL;
  id?: () => string;
}

export function createTaskDraftHandler({ auth, resources, authOrigin, id = randomUUID }: TaskDraftHandlerDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = resolveRequestId(request.headers);
    try {
      if (request.headers.get("origin") !== authOrigin.origin) throw new AuthError("AUTH_ORIGIN_MISMATCH", 403);
      const token = readSessionCookie(request.headers);
      if (!token) throw new AuthError("AUTH_SESSION_INVALID");
      const session = await auth.authenticateSession(token);
      auth.requireRecentAuth(session);
      const input = parseTaskDraftInput(await request.json());
      const resourceId = id();
      const record = await resources.createTaskDraft({
        resourceId,
        requestId,
        publisherWallet: WalletAddressSchema.parse(session.walletAddress),
        agentWallet: null,
        budgetAtomic: input.budgetAtomic,
        status: "funding_pending",
        title: input.title,
        description: input.description,
        requirements: [input.description],
        category: input.category,
        tags: [...new Set(input.tags.map((tag) => tag.toLowerCase()))],
      });
      return Response.json({
        task: {
          resourceId: record.resourceId,
          requestId,
          status: record.status,
          budgetAtomic: record.budgetAtomic,
          platformFeeAtomic: ((BigInt(record.budgetAtomic) * 6n) / 100n).toString(),
          platformFeeStatus: "contract-support-pending",
        },
      }, { status: 201, headers: { "cache-control": "no-store", "x-request-id": requestId } });
    } catch (error) {
      const authError = error instanceof AuthError ? error : null;
      const resourceError = error instanceof ChainResourceError ? error : null;
      const code = authError?.code ?? resourceError?.code ?? (error instanceof TaskDraftValidationError ? "TASK_DRAFT_INVALID" : "TASK_DRAFT_UNAVAILABLE");
      const status = authError?.status ?? resourceError?.status ?? (error instanceof TaskDraftValidationError ? 400 : 503);
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
    return await createTaskDraftHandler({
      auth: getAuthService(), resources: runtime.resources, authOrigin: getAuthOrigin(),
    })(request);
  } catch {
    return Response.json({ error: "TASK_DRAFT_UNAVAILABLE", requestId }, {
      status: 503,
      headers: { "cache-control": "no-store", "x-request-id": requestId },
    });
  }
}
