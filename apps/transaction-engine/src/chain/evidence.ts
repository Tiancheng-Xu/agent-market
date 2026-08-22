import type {
  TransactionIntentV1,
  TransactionVerificationV1,
} from "@agent-market/shared-contracts";

export interface PublicTransactionEvidence {
  from: string;
  to: string;
  txHash: string;
  eventName: string | null;
  requestRef: string;
  blockNumber: number | null;
  confirmations: number;
  status: TransactionVerificationV1["status"];
  checkedAt: string;
}

export function projectTransactionEvidence(
  intent: TransactionIntentV1,
  verification: TransactionVerificationV1,
): PublicTransactionEvidence {
  if (
    verification.intentId !== intent.intentId ||
    verification.requestId !== intent.requestId
  ) {
    throw new Error("Verification does not belong to intent");
  }
  return {
    from: intent.from.toLowerCase(),
    to: intent.to.toLowerCase(),
    txHash: verification.txHash.toLowerCase(),
    eventName: verification.status === "confirmed" ? verification.eventName : null,
    requestRef: intent.requestRef.toLowerCase(),
    blockNumber: verification.blockNumber,
    confirmations: verification.confirmations,
    status: verification.status,
    checkedAt: verification.checkedAt,
  };
}
