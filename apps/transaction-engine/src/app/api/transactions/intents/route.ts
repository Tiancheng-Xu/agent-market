import { TransactionMethodSchema } from "@agent-market/shared-contracts";

import { getAuthService } from "../../../../auth/runtime";
import { AuthError, readSessionCookie, type WalletAuthService } from "../../../../auth/session";
import { buildTransactionIntent, type BuildIntentInput } from "../../../../chain/intents";
import {
  bindMethodArguments,
  contractForMethod,
  deriveChainResource,
  deriveIntentRequestId,
  type ContractAllowlist,
} from "../../../../chain/policy";
import {
  ChainResourceError,
  buildTransactionExpectation,
  normalizeResourceId,
  type ChainResourceRepository,
} from "../../../../chain/resources";
import { getTransactionRuntime } from "../../../../chain/runtime";
import type { TransactionStore } from "../../../../chain/transaction-store";
import { resolveRequestId } from "../../../../lib/request-context";

interface IntentHandlerDependencies {
  auth: WalletAuthService;
  store: TransactionStore;
  resources: ChainResourceRepository;
  contracts: ContractAllowlist;
  now?: () => Date;
}

export function createIntentHandler({ auth, store, resources, contracts, now = () => new Date() }: IntentHandlerDependencies) {
  return async function POST(request: Request): Promise<Response> {
    let requestId = resolveRequestId(request.headers);
    try {
      const token = readSessionCookie(request.headers);
      if (!token) throw new AuthError("AUTH_SESSION_INVALID");
      const session = await auth.authenticateSession(token);
      auth.requireRecentAuth(session);
      const body = await request.json() as Record<string, unknown>;
      for (const forbidden of ["from", "to", "requestRef", "taskId", "chainId", "data", "valueAtomic", "privateKey", "signature", "intentId", "requestId"]) {
        if (forbidden in body) throw new AuthError("CHAIN_INTENT_FORBIDDEN_FIELD", 400);
      }
      if (typeof body.resourceId !== "string" || typeof body.method !== "string"
        || typeof body.args !== "object" || body.args === null) {
        throw new AuthError("CHAIN_INTENT_INVALID", 400);
      }
      const parsedMethod = TransactionMethodSchema.safeParse(body.method);
      if (!parsedMethod.success) throw new AuthError("CHAIN_METHOD_INVALID", 400);
      const method = parsedMethod.data as BuildIntentInput["method"];
      const resourceId = normalizeResourceId(body.resourceId);
      let record;
      let review;
      try {
        if (method === "resolveWorkflowTask") {
          const keys = Object.keys(body.args as Record<string, unknown>);
          const agentsWin = (body.args as Record<string, unknown>).agentsWin;
          if (keys.length !== 1 || keys[0] !== "agentsWin" || typeof agentsWin !== "boolean") {
            throw new AuthError("CHAIN_INTENT_INVALID", 400);
          }
          const binding = await resources.requireResolutionReview(resourceId, session.walletAddress, { agentsWin }, now());
          record = binding.resource;
          review = binding.review;
        } else {
          record = await resources.requireAuthorized(resourceId, session.walletAddress, method);
        }
      } catch (error) {
        if (error instanceof ChainResourceError) throw new AuthError(error.code, error.status);
        throw error;
      }
      requestId = deriveIntentRequestId(session.walletAddress, resourceId, method, review ? `${review.reviewId}:${review.reviewHash}` : "");
      const resource = deriveChainResource(resourceId);
      const normalizedContracts = contracts;
      let intent;
      try {
        intent = buildTransactionIntent({
        intentId: requestId,
        requestId,
        requestRef: resource.requestRef,
        from: session.walletAddress,
        to: contractForMethod(method, normalizedContracts),
        method,
        args: bindMethodArguments(
          method, body.args as Record<string, unknown>, resource, normalizedContracts, record,
        ),
        createdAt: now(),
        ...(review ? { expiresAt: review.expiresAt } : {}),
        } as BuildIntentInput);
      } catch {
        throw new AuthError("CHAIN_INTENT_INVALID", 400);
      }
      const persisted = await store.createIntent(intent, buildTransactionExpectation(record, method, review));
      return Response.json({ intent: persisted, requestId }, {
        status: 201,
        headers: { "cache-control": "no-store", "x-request-id": requestId },
      });
    } catch (error) {
      const authError = error instanceof AuthError ? error : null;
      const code = authError?.code ?? (error instanceof Error ? error.message : "CHAIN_SERVICE_UNAVAILABLE");
      const status = authError?.status ?? (code === "CHAIN_INTENT_CONFLICT" ? 409
        : code.startsWith("CHAIN_") && !["CHAIN_INTENT_NOT_PERSISTED"].includes(code) ? 400 : 503);
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
    return await createIntentHandler({
      auth: getAuthService(), store: runtime.store, resources: runtime.resources, contracts: runtime.contracts,
    })(request);
  } catch {
    return Response.json({ error: "CHAIN_SERVICE_UNAVAILABLE", requestId }, {
      status: 503,
      headers: { "cache-control": "no-store", "x-request-id": requestId },
    });
  }
}
