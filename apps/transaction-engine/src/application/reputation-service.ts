import {
  computeReputationSnapshot,
  ReputationReviewSchema,
  type ReputationReview,
  type ReputationSnapshot,
} from "@agent-market/shared-contracts";

export type ReviewEligibility = {
  orderId: string;
  taskId: string;
  agentId: string;
  publisherWallet: string;
  agentOwnerWallet: string;
  status: "available" | "consumed" | "revoked";
};

export interface ReputationStore {
  findEligibility(orderId: string): Promise<ReviewEligibility | null>;
  findEligibilityForTaskAgent(taskId: string, agentId: string): Promise<ReviewEligibility | null>;
  findReview(orderId: string): Promise<ReputationReview | null>;
  listReviews(agentId: string): Promise<ReputationReview[]>;
  linkedWallets(wallet: string): Promise<string[]>;
  saveReview(review: ReputationReview): Promise<void>;
}

const wallet = (value: string) => value.toLowerCase();

export class ReputationService {
  constructor(private readonly store: ReputationStore) {}

  async findEligibilityForTaskAgent(taskId: string, agentId: string): Promise<ReviewEligibility | null> {
    const parsedTaskId = ReputationReviewSchema.shape.orderId.parse(taskId);
    const parsedAgentId = ReputationReviewSchema.shape.agentId.parse(agentId);
    return this.store.findEligibilityForTaskAgent(parsedTaskId, parsedAgentId);
  }

  async submitReview(input: ReputationReview, calculatedAt = input.occurredAt): Promise<ReputationSnapshot> {
    const review = ReputationReviewSchema.parse(input);
    const eligibility = await this.store.findEligibility(review.orderId);
    if (!eligibility || eligibility.status !== "available") throw new Error("REVIEW_NOT_ELIGIBLE");
    if (eligibility.agentId !== review.agentId) throw new Error("REVIEW_AGENT_CONFLICT");
    if (wallet(eligibility.publisherWallet) !== wallet(review.reviewerWallet)) {
      throw new Error("REVIEW_PUBLISHER_FORBIDDEN");
    }
    if (wallet(eligibility.agentOwnerWallet) !== wallet(review.agentOwnerWallet)) {
      throw new Error("REVIEW_OWNER_CONFLICT");
    }
    if (wallet(review.reviewerWallet) === wallet(review.agentOwnerWallet)) throw new Error("REVIEW_SELF_FORBIDDEN");
    const linked = (await this.store.linkedWallets(review.agentOwnerWallet)).map(wallet);
    if (linked.includes(wallet(review.reviewerWallet))) throw new Error("REVIEW_LINKED_WALLET_FORBIDDEN");
    const existing = await this.store.findReview(review.orderId);
    if (existing) throw new Error("REVIEW_ALREADY_EXISTS");
    await this.store.saveReview(review);
    return computeReputationSnapshot(
      review.agentId,
      await this.store.listReviews(review.agentId),
      calculatedAt,
    );
  }
}

export class MemoryReputationStore implements ReputationStore {
  private readonly reviews = new Map<string, ReputationReview>();
  private readonly links = new Map<string, string[]>();

  constructor(private readonly eligibilities: ReviewEligibility[]) {}

  setLinkedWallets(ownerWallet: string, linkedWallets: string[]): void {
    this.links.set(wallet(ownerWallet), linkedWallets.map(wallet));
  }

  async findEligibility(orderId: string): Promise<ReviewEligibility | null> {
    return this.eligibilities.find((eligibility) => eligibility.orderId === orderId) ?? null;
  }

  async findEligibilityForTaskAgent(taskId: string, agentId: string): Promise<ReviewEligibility | null> {
    return this.eligibilities.find((eligibility) => (
      eligibility.taskId === taskId && eligibility.agentId === agentId
    )) ?? null;
  }

  async findReview(orderId: string): Promise<ReputationReview | null> {
    return this.reviews.get(orderId) ?? null;
  }

  async listReviews(agentId: string): Promise<ReputationReview[]> {
    return [...this.reviews.values()].filter((review) => review.agentId === agentId);
  }

  async linkedWallets(ownerWallet: string): Promise<string[]> {
    return this.links.get(wallet(ownerWallet)) ?? [];
  }

  async saveReview(review: ReputationReview): Promise<void> {
    if (this.reviews.has(review.orderId)) throw new Error("REVIEW_ALREADY_EXISTS");
    this.reviews.set(review.orderId, structuredClone(review));
    const eligibility = this.eligibilities.find((candidate) => candidate.orderId === review.orderId);
    if (eligibility) eligibility.status = "consumed";
  }
}
