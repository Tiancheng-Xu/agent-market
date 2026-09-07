import { z } from "zod";

const WalletSchema = z.string().regex(/^0x[0-9a-f]{40}$/u);

export const OrderStatusSchema = z.enum([
  "open",
  "funding_pending",
  "funded",
  "matching",
  "assigned",
  "in_progress",
  "submitted",
  "accepted",
  "disputed",
  "settled",
  "refunded",
  "manual_review",
]);

export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const OrderArtifactSchema = z.object({
  id: z.string().uuid(),
  uri: z.string().url(),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  mediaType: z.string().trim().min(1).max(120),
  sizeBytes: z.number().int().positive().max(50_000_000),
  submittedAt: z.string().datetime(),
});

export type OrderArtifact = z.infer<typeof OrderArtifactSchema>;

export const OrderManualReviewSchema = z.object({
  previousStatus: OrderStatusSchema.exclude(["manual_review"]),
  reasonCode: z.string().trim().min(1).max(80),
  openedAt: z.string().datetime(),
});

export const OrderSnapshotSchema = z.object({
  id: z.string().uuid(),
  publisherWallet: WalletSchema,
  agentId: z.string().uuid().nullable(),
  agentWallet: WalletSchema.nullable(),
  title: z.string().trim().min(3).max(160),
  budgetAtomic: z.string().regex(/^[1-9][0-9]*$/u),
  status: OrderStatusSchema,
  version: z.number().int().positive(),
  artifacts: z.array(OrderArtifactSchema),
  reviewEligible: z.boolean(),
  manualReview: OrderManualReviewSchema.nullable(),
  updatedAt: z.string().datetime(),
});

export type OrderSnapshot = z.infer<typeof OrderSnapshotSchema>;

const CommandContextSchema = z.object({
  requestId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(8).max(160),
  actorWallet: WalletSchema.nullable(),
  occurredAt: z.string().datetime(),
});

const QuoteGateContextShape = {
  quoteId: z.string().uuid(),
  taskFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
};

export const OrderCommandSchema = z.discriminatedUnion("type", [
  CommandContextSchema.extend({ type: z.literal("mark_funding_pending"), ...QuoteGateContextShape }),
  CommandContextSchema.extend({ type: z.literal("confirm_funding") }),
  CommandContextSchema.extend({ type: z.literal("start_matching"), ...QuoteGateContextShape }),
  CommandContextSchema.extend({ type: z.literal("assign_agent"), agentId: z.string().uuid(), agentWallet: WalletSchema }),
  CommandContextSchema.extend({ type: z.literal("accept_assignment") }),
  CommandContextSchema.extend({ type: z.literal("submit_artifact"), artifact: OrderArtifactSchema }),
  CommandContextSchema.extend({ type: z.literal("accept_delivery") }),
  CommandContextSchema.extend({
    type: z.literal("open_dispute"),
    reasonCode: z.string().trim().min(1).max(80),
  }),
  CommandContextSchema.extend({ type: z.literal("settle") }),
  CommandContextSchema.extend({ type: z.literal("refund") }),
  CommandContextSchema.extend({
    type: z.literal("mark_manual_review"),
    reasonCode: z.string().trim().min(1).max(80),
  }),
  CommandContextSchema.extend({ type: z.literal("resolve_manual_review") }),
]);

export type OrderCommand = z.infer<typeof OrderCommandSchema>;

export const OrderEventSchema = z.object({
  orderId: z.string().uuid(),
  requestId: z.string().uuid(),
  action: OrderCommandSchema.options.reduce(
    (schema, option) => schema.or(option.shape.type),
    z.never() as z.ZodType<string>,
  ),
  actorWallet: WalletSchema.nullable(),
  from: OrderStatusSchema,
  to: OrderStatusSchema,
  version: z.number().int().positive(),
  occurredAt: z.string().datetime(),
});

export type OrderEvent = z.infer<typeof OrderEventSchema>;

const normalizeWallet = (wallet: string | null) => wallet?.toLowerCase() ?? null;

function requireActor(actual: string | null, expected: string | null, code: string): void {
  if (normalizeWallet(actual) !== normalizeWallet(expected)) throw new Error(code);
}

function requireStatus(snapshot: OrderSnapshot, allowed: readonly OrderStatus[]): void {
  if (!allowed.includes(snapshot.status)) throw new Error("ORDER_TRANSITION_INVALID");
}

export function applyOrderCommand(
  input: OrderSnapshot,
  rawCommand: OrderCommand,
): { snapshot: OrderSnapshot; event: OrderEvent } {
  const current = OrderSnapshotSchema.parse(input);
  const command = OrderCommandSchema.parse(rawCommand);
  if (current.status === "settled" || current.status === "refunded") {
    throw new Error("ORDER_TERMINAL");
  }

  let status: OrderStatus = current.status;
  let agentId = current.agentId;
  let agentWallet = current.agentWallet;
  let artifacts = current.artifacts;
  let reviewEligible = current.reviewEligible;
  let manualReview = current.manualReview;

  switch (command.type) {
    case "mark_funding_pending":
      requireStatus(current, ["open", "assigned"]);
      requireActor(command.actorWallet, current.publisherWallet, "ORDER_PUBLISHER_FORBIDDEN");
      status = "funding_pending";
      break;
    case "confirm_funding":
      requireStatus(current, ["funding_pending"]);
      requireActor(command.actorWallet, null, "ORDER_SYSTEM_ACTOR_REQUIRED");
      status = "funded";
      break;
    case "start_matching":
      requireStatus(current, ["open", "funded"]);
      requireActor(command.actorWallet, null, "ORDER_SYSTEM_ACTOR_REQUIRED");
      status = "matching";
      break;
    case "assign_agent":
      requireStatus(current, ["matching"]);
      requireActor(command.actorWallet, null, "ORDER_SYSTEM_ACTOR_REQUIRED");
      agentId = command.agentId;
      agentWallet = command.agentWallet;
      status = "assigned";
      break;
    case "accept_assignment":
      requireStatus(current, ["assigned"]);
      requireActor(command.actorWallet, current.agentWallet, "ORDER_AGENT_FORBIDDEN");
      status = "in_progress";
      break;
    case "submit_artifact":
      requireStatus(current, ["in_progress"]);
      requireActor(command.actorWallet, current.agentWallet, "ORDER_AGENT_FORBIDDEN");
      artifacts = [...current.artifacts, command.artifact];
      status = "submitted";
      break;
    case "accept_delivery":
      requireStatus(current, ["submitted"]);
      requireActor(command.actorWallet, current.publisherWallet, "ORDER_PUBLISHER_FORBIDDEN");
      if (current.artifacts.length === 0) throw new Error("ORDER_ARTIFACT_REQUIRED");
      reviewEligible = true;
      status = "accepted";
      break;
    case "open_dispute":
      requireStatus(current, ["submitted", "accepted"]);
      if (![current.publisherWallet, current.agentWallet].map(normalizeWallet).includes(normalizeWallet(command.actorWallet))) {
        throw new Error("ORDER_PARTICIPANT_FORBIDDEN");
      }
      status = "disputed";
      break;
    case "settle":
      requireStatus(current, ["accepted", "disputed"]);
      requireActor(command.actorWallet, null, "ORDER_SYSTEM_ACTOR_REQUIRED");
      status = "settled";
      break;
    case "refund":
      requireStatus(current, ["funded", "assigned", "in_progress", "submitted", "disputed"]);
      requireActor(command.actorWallet, null, "ORDER_SYSTEM_ACTOR_REQUIRED");
      status = "refunded";
      reviewEligible = false;
      break;
    case "mark_manual_review":
      requireActor(command.actorWallet, null, "ORDER_SYSTEM_ACTOR_REQUIRED");
      if (current.status === "manual_review") throw new Error("ORDER_MANUAL_REVIEW_ALREADY_OPEN");
      manualReview = {
        previousStatus: current.status,
        reasonCode: command.reasonCode,
        openedAt: command.occurredAt,
      };
      status = "manual_review";
      break;
    case "resolve_manual_review":
      requireStatus(current, ["manual_review"]);
      if (command.actorWallet === null) throw new Error("ORDER_OPERATOR_REQUIRED");
      if (!current.manualReview) throw new Error("ORDER_MANUAL_REVIEW_CONTEXT_MISSING");
      status = current.manualReview.previousStatus;
      manualReview = null;
      break;
  }

  const snapshot = OrderSnapshotSchema.parse({
    ...current,
    agentId,
    agentWallet,
    status,
    version: current.version + 1,
    artifacts,
    reviewEligible,
    manualReview,
    updatedAt: command.occurredAt,
  });
  const event = OrderEventSchema.parse({
    orderId: current.id,
    requestId: command.requestId,
    action: command.type,
    actorWallet: command.actorWallet,
    from: current.status,
    to: status,
    version: snapshot.version,
    occurredAt: command.occurredAt,
  });
  return { snapshot, event };
}
