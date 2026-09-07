import type {
  OrderCommand,
  TransactionIntentV1,
  TransactionVerificationV1,
} from "@agent-market/shared-contracts";
import type { ChainTransactionExpectation } from "../chain/resources";
import type { OrderService } from "./order-service";

export type SettlementProjection =
  | { status: "pending"; reasonCode: "confirmations_pending" }
  | { status: "not_applicable"; reasonCode: "non_order_method" }
  | { status: "project"; command: OrderCommand };

const commandContext = (
  intent: TransactionIntentV1,
  verification: TransactionVerificationV1,
  actorWallet: string | null,
) => ({
  requestId: verification.requestId,
  idempotencyKey: `chain-${intent.intentId}-${verification.status}`,
  actorWallet,
  occurredAt: verification.checkedAt,
});

const manualReview = (
  intent: TransactionIntentV1,
  verification: TransactionVerificationV1,
  reasonCode: string,
): SettlementProjection => ({
  status: "project",
  command: {
    type: "mark_manual_review",
    ...commandContext(intent, verification, null),
    reasonCode,
  },
});

export function projectSettlementVerification(
  intent: TransactionIntentV1,
  verification: TransactionVerificationV1,
  expectation: ChainTransactionExpectation,
): SettlementProjection {
  if (verification.status === "verifying") {
    return Date.parse(verification.checkedAt) > Date.parse(intent.expiresAt)
      ? manualReview(intent, verification, "chain_verification_timeout")
      : { status: "pending", reasonCode: "confirmations_pending" };
  }
  if (verification.status === "reorged") {
    return manualReview(intent, verification, "chain_reorg");
  }
  if (verification.status === "failed") {
    return manualReview(intent, verification, `chain_failed_${verification.errorCode.toLowerCase()}`);
  }

  const system = commandContext(intent, verification, null);
  const actor = commandContext(intent, verification, intent.from);
  switch (intent.method) {
    case "createTask":
    case "createWorkflowTask":
      return { status: "project", command: { type: "confirm_funding", ...system } };
    case "acceptTask":
      return { status: "project", command: { type: "accept_assignment", ...actor } };
    case "acceptWork":
      return { status: "project", command: { type: "accept_delivery", ...actor } };
    case "openDispute":
      return {
        status: "project",
        command: { type: "open_dispute", ...actor, reasonCode: "chain_dispute_confirmed" },
      };
    case "timeoutTask":
      return { status: "project", command: { type: "refund", ...system } };
    case "resolveWorkflowTask":
      if (expectation.agentWins === null) {
        return manualReview(intent, verification, "resolution_outcome_missing");
      }
      return {
        status: "project",
        command: expectation.agentWins
          ? { type: "settle", ...system }
          : { type: "refund", ...system },
      };
    case "assignAgent":
      return manualReview(intent, verification, "assignment_wallet_projection_missing");
    case "submitWork":
      return manualReview(intent, verification, "artifact_projection_missing");
    default:
      return { status: "not_applicable", reasonCode: "non_order_method" };
  }
}

export class SettlementService {
  constructor(private readonly orders: OrderService) {}

  async project(
    intent: TransactionIntentV1,
    verification: TransactionVerificationV1,
    expectation: ChainTransactionExpectation,
  ): Promise<SettlementProjection> {
    const projection = projectSettlementVerification(intent, verification, expectation);
    if (projection.status === "project") {
      await this.orders.execute(expectation.resourceId, projection.command);
    }
    return projection;
  }
}
