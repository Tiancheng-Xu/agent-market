import { getAuthService } from "../../../../auth/runtime";
import { AuthError, readSessionCookie, type WalletAuthService } from "../../../../auth/session";
import { projectTransactionEvidence } from "../../../../chain/evidence";
import { reconcileTransaction, type ChainReader } from "../../../../chain/reconcile";
import { getTransactionRuntime } from "../../../../chain/runtime";
import type { TransactionStore } from "../../../../chain/transaction-store";
import { resolveRequestId } from "../../../../lib/request-context";

interface VerifyHandlerDependencies {
  auth: WalletAuthService;
  store: TransactionStore;
  rpc: ChainReader;
  blockscout: ChainReader;
  now?: () => Date;
  minimumConfirmations?: number;
}

export function createTransactionVerifyHandler({
  auth, store, rpc, blockscout, now = () => new Date(), minimumConfirmations = 2,
}: VerifyHandlerDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = resolveRequestId(request.headers);
    try {
      const token = readSessionCookie(request.headers);
      if (!token) throw new AuthError("AUTH_SESSION_INVALID");
      const session = await auth.authenticateSession(token);
      const body = await request.json() as { intentId?: unknown; txHash?: unknown };
      if (typeof body.intentId !== "string" || typeof body.txHash !== "string"
        || !/^0x[a-fA-F0-9]{64}$/u.test(body.txHash)) {
        throw new AuthError("CHAIN_VERIFY_INVALID", 400);
      }
      const intent = await store.findIntent(body.intentId);
      if (!intent) throw new AuthError("CHAIN_INTENT_NOT_FOUND", 404);
      if (intent.from !== session.walletAddress) throw new AuthError("CHAIN_INTENT_FORBIDDEN", 403);
      const expectation = await store.findExpectation(intent.intentId);
      if (!expectation) throw new Error("CHAIN_EXPECTATION_NOT_FOUND");
      const checkedAt = now().toISOString();
      await store.recordSubmission(intent.intentId, body.txHash, checkedAt);
      const previous = await store.findVerification(intent.intentId);
      const previousCanonicalBlockHash = await store.findCanonicalBlockHash(intent.intentId) ?? undefined;
      let canonicalObservation: { blockHash: string; requestRef?: string } | undefined;
      const verification = await reconcileTransaction({
        intent, expectation, txHash: body.txHash, rpc, blockscout, minimumConfirmations, checkedAt,
        ...(previous ? { previous } : {}),
        ...(previousCanonicalBlockHash ? { previousCanonicalBlockHash } : {}),
        onCanonicalObservation: (observation) => { canonicalObservation = observation; },
      });
      if (verification.status === "confirmed" && !canonicalObservation) throw new Error("CHAIN_CANONICAL_OBSERVATION_MISSING");
      const persisted = await store.saveVerification(verification, canonicalObservation);
      return Response.json({
        verification: persisted,
        evidence: projectTransactionEvidence(intent, persisted),
        requestId,
      }, { headers: { "cache-control": "no-store", "x-request-id": requestId } });
    } catch (error) {
      const authError = error instanceof AuthError ? error : null;
      const code = authError?.code ?? (error instanceof Error ? error.message : "CHAIN_SERVICE_UNAVAILABLE");
      const status = authError?.status ?? (code === "CHAIN_TRANSACTION_CONFLICT" ? 409 : 503);
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
    return await createTransactionVerifyHandler({ auth: getAuthService(), ...runtime })(request);
  } catch {
    return Response.json({ error: "CHAIN_SERVICE_UNAVAILABLE", requestId }, {
      status: 503,
      headers: { "cache-control": "no-store", "x-request-id": requestId },
    });
  }
}
