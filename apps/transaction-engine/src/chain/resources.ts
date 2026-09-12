import { getAddress } from "ethers";
import { createHash, randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { validate as isUuid } from "uuid";

import type { TransactionMethod } from "./intents";

export type TaskResourceStatus =
  | "open"
  | "funding_pending"
  | "funded"
  | "matching"
  | "assigned"
  | "in_progress"
  | "submitted"
  | "accepted"
  | "disputed"
  | "settled"
  | "refunded"
  | "cancelled";

export interface ChainResourceRecord {
  resourceId: string;
  kind?: "task" | "account";
  publisherWallet: string;
  agentWallet: string | null;
  budgetAtomic: string;
  status: TaskResourceStatus;
  revision?: number;
}

export interface ArbitrationReviewRecord {
  reviewId: string;
  resourceId: string;
  resourceRevision: number;
  reviewerWallet: string;
  agentsWin: boolean;
  args: { agentsWin: boolean };
  reviewHash: string;
  createdAt: string;
  expiresAt: string;
}

export interface ResolutionReviewBinding {
  resource: ChainResourceRecord;
  review: ArbitrationReviewRecord;
}

export interface TaskDraftRecord extends ChainResourceRecord {
  requestId: string;
  title: string;
  description: string;
  requirements: string[];
  category: string;
  tags: string[];
}

export interface ChainTransactionExpectation {
  resourceId: string;
  resourceKind?: "task" | "account";
  budgetAtomic: string;
  bondAtomic: string;
  agentWins: boolean | null;
  resourceRevision?: number;
  reviewId?: string;
  reviewHash?: string;
  reviewExpiresAt?: string;
}

export class ChainResourceError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}

export interface ChainResourceRepository {
  createTaskDraft(input: TaskDraftRecord): Promise<ChainResourceRecord>;
  createChainAccount(resourceId: string, walletAddress: string): Promise<ChainResourceRecord>;
  requireAuthorized(
    resourceId: string,
    actorWallet: string,
    method: TransactionMethod,
  ): Promise<ChainResourceRecord>;
  recordArbitrationReview(resourceId: string, actorWallet: string, args: { agentsWin: boolean }, now: Date): Promise<ArbitrationReviewRecord>;
  readArbitrationReview(resourceId: string, actorWallet: string, now: Date): Promise<ArbitrationReviewRecord | null>;
  requireResolutionReview(resourceId: string, actorWallet: string, args: { agentsWin: boolean }, now: Date): Promise<ResolutionReviewBinding>;
}

const ARBITRATION_REVIEW_VALIDITY_MS = 10 * 60_000;

function requireTaskRevision(resource: ChainResourceRecord): number {
  if (!Number.isSafeInteger(resource.revision) || resource.revision! <= 0) {
    throw new ChainResourceError("CHAIN_RESOURCE_REVISION_UNAVAILABLE", 503);
  }
  return resource.revision!;
}

function createReviewRecord(resource: ChainResourceRecord, actorWallet: string, args: { agentsWin: boolean }, now: Date): ArbitrationReviewRecord {
  const reviewId = randomUUID();
  const resourceRevision = requireTaskRevision(resource);
  const reviewerWallet = getAddress(actorWallet).toLowerCase();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ARBITRATION_REVIEW_VALIDITY_MS).toISOString();
  const canonical = JSON.stringify({ reviewId, resourceId: resource.resourceId, resourceRevision, reviewerWallet, agentsWin: args.agentsWin, args, createdAt, expiresAt });
  return {
    reviewId, resourceId: resource.resourceId, resourceRevision, reviewerWallet,
    agentsWin: args.agentsWin, args: { agentsWin: args.agentsWin },
    reviewHash: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
    createdAt, expiresAt,
  };
}

function validateResolutionReview(resource: ChainResourceRecord, review: ArbitrationReviewRecord | undefined, actorWallet: string, args: { agentsWin: boolean }, now: Date): ArbitrationReviewRecord {
  if (!review) throw new ChainResourceError("CHAIN_ARBITRATION_REVIEW_REQUIRED", 409);
  if (review.resourceRevision !== requireTaskRevision(resource)) throw new ChainResourceError("CHAIN_ARBITRATION_REVIEW_STALE", 409);
  if (review.reviewerWallet !== getAddress(actorWallet).toLowerCase()) throw new ChainResourceError("CHAIN_ARBITRATION_REVIEW_FORBIDDEN", 403);
  if (review.agentsWin !== args.agentsWin || review.args.agentsWin !== args.agentsWin) throw new ChainResourceError("CHAIN_ARBITRATION_REVIEW_ARGS_MISMATCH", 409);
  if (Date.parse(review.expiresAt) <= now.getTime()) throw new ChainResourceError("CHAIN_ARBITRATION_REVIEW_EXPIRED", 409);
  return review;
}

const ACTIVE_STATUSES: readonly TaskResourceStatus[] = [
  "open", "funding_pending", "funded", "matching", "assigned", "in_progress",
  "submitted", "accepted", "disputed", "settled",
];

const METHOD_STATUSES: Record<TransactionMethod, readonly TaskResourceStatus[]> = {
  faucet: ACTIVE_STATUSES,
  approve: ACTIVE_STATUSES,
  createTask: ["open", "funding_pending"],
  createWorkflowTask: ["open", "funding_pending"],
  assignAgent: ["matching", "assigned"],
  acceptTask: ["assigned"],
  submitWork: ["in_progress"],
  acceptWork: ["submitted", "accepted"],
  timeoutTask: ["in_progress"],
  openDispute: ["in_progress", "submitted", "disputed"],
  castVote: ["disputed"],
  resolveWorkflowTask: ["in_progress", "disputed"],
  stake: ACTIVE_STATUSES,
  unstake: ACTIVE_STATUSES,
  claimYield: ACTIVE_STATUSES,
};

const PUBLISHER_METHODS = new Set<TransactionMethod>([
  "faucet", "approve", "createTask", "createWorkflowTask", "assignAgent", "acceptWork", "timeoutTask",
  "stake", "unstake", "claimYield",
]);
const AGENT_METHODS = new Set<TransactionMethod>(["acceptTask", "submitWork"]);
const ACCOUNT_METHODS = new Set<TransactionMethod>(["approve", "stake", "unstake", "claimYield"]);

export function normalizeResourceId(resourceId: string): string {
  const normalized = resourceId.trim().toLowerCase();
  if (!isUuid(normalized)) throw new ChainResourceError("CHAIN_RESOURCE_ID_INVALID", 400);
  return normalized;
}

export function buildTransactionExpectation(
  resource: ChainResourceRecord,
  method: TransactionMethod,
  review?: ArbitrationReviewRecord,
): ChainTransactionExpectation {
  const budget = BigInt(resource.budgetAtomic);
  return {
    resourceId: resource.resourceId,
    ...(resource.kind === "account" ? { resourceKind: "account" as const } : {}),
    budgetAtomic: budget.toString(),
    bondAtomic: ((budget * 6n) / 100n).toString(),
    agentWins: review ? review.agentsWin
      : method === "acceptWork" ? true : method === "timeoutTask" ? false : null,
    ...(review ? {
      resourceRevision: review.resourceRevision,
      reviewId: review.reviewId,
      reviewHash: review.reviewHash,
      reviewExpiresAt: review.expiresAt,
    } : {}),
  };
}

function authorize(
  resource: ChainResourceRecord,
  actorWallet: string,
  method: TransactionMethod,
  committeeMembers: ReadonlySet<string>,
  platformArbiter: string | null,
): ChainResourceRecord {
  const resourceKind = resource.kind ?? "task";
  if (resourceKind === "account" && !ACCOUNT_METHODS.has(method)) {
    throw new ChainResourceError("CHAIN_ACCOUNT_METHOD_FORBIDDEN", 403);
  }
  if (resourceKind === "task" && ["stake", "unstake", "claimYield"].includes(method)) {
    throw new ChainResourceError("CHAIN_TASK_METHOD_FORBIDDEN", 403);
  }
  if (!METHOD_STATUSES[method].includes(resource.status)) {
    throw new ChainResourceError("CHAIN_RESOURCE_STATE_INVALID", 409);
  }
  const actor = getAddress(actorWallet);
  const publisher = getAddress(resource.publisherWallet);
  const agent = resource.agentWallet === null ? null : getAddress(resource.agentWallet);
  if (method === "castVote") {
    if (!committeeMembers.has(actor)) throw new ChainResourceError("CHAIN_RESOURCE_FORBIDDEN", 403);
  } else if (method === "resolveWorkflowTask") {
    if (platformArbiter === null || actor !== platformArbiter) throw new ChainResourceError("CHAIN_RESOURCE_FORBIDDEN", 403);
  } else if (method === "openDispute") {
    if (actor !== publisher && actor !== agent) throw new ChainResourceError("CHAIN_RESOURCE_FORBIDDEN", 403);
  } else if (PUBLISHER_METHODS.has(method)) {
    if (actor !== publisher) throw new ChainResourceError("CHAIN_RESOURCE_FORBIDDEN", 403);
  } else if (AGENT_METHODS.has(method)) {
    if (agent === null || actor !== agent) throw new ChainResourceError("CHAIN_RESOURCE_FORBIDDEN", 403);
  }
  if (method === "assignAgent" && agent === null) {
    throw new ChainResourceError("CHAIN_RESOURCE_AGENT_MISSING", 409);
  }
  return resource;
}

export class MemoryChainResourceRepository implements ChainResourceRepository {
  private readonly resources = new Map<string, ChainResourceRecord>();
  private readonly arbitrationReviews = new Map<string, ArbitrationReviewRecord>();
  private readonly committeeMembers: ReadonlySet<string>;
  private readonly platformArbiter: string | null;

  constructor(resources: readonly ChainResourceRecord[], committeeMembers: readonly string[] = [], platformArbiter?: string) {
    for (const resource of resources) {
      const resourceId = normalizeResourceId(resource.resourceId);
      this.resources.set(resourceId, { ...resource, resourceId });
    }
    this.committeeMembers = new Set(committeeMembers.map((wallet) => getAddress(wallet)));
    this.platformArbiter = platformArbiter ? getAddress(platformArbiter) : null;
  }

  async createTaskDraft(input: TaskDraftRecord): Promise<ChainResourceRecord> {
    const resourceId = normalizeResourceId(input.resourceId);
    const existing = this.resources.get(resourceId);
    if (existing !== undefined) {
      if (existing.publisherWallet !== input.publisherWallet || existing.budgetAtomic !== input.budgetAtomic) {
        throw new ChainResourceError("CHAIN_RESOURCE_CONFLICT", 409);
      }
      return existing;
    }
    const record: ChainResourceRecord = {
      resourceId,
      kind: "task",
      publisherWallet: getAddress(input.publisherWallet).toLowerCase(),
      agentWallet: null,
      budgetAtomic: input.budgetAtomic,
      status: "funding_pending",
    };
    this.resources.set(resourceId, record);
    return record;
  }

  async createChainAccount(resourceIdInput: string, walletAddress: string): Promise<ChainResourceRecord> {
    const resourceId = normalizeResourceId(resourceIdInput);
    const publisherWallet = getAddress(walletAddress).toLowerCase();
    const existing = this.resources.get(resourceId);
    if (existing !== undefined) {
      if (existing.publisherWallet !== publisherWallet || existing.kind !== "account") throw new ChainResourceError("CHAIN_RESOURCE_CONFLICT", 409);
      return existing;
    }
    const record: ChainResourceRecord = { resourceId, kind: "account", publisherWallet, agentWallet: null, budgetAtomic: "1", status: "open" };
    this.resources.set(resourceId, record);
    return record;
  }

  async requireAuthorized(
    resourceId: string,
    actorWallet: string,
    method: TransactionMethod,
  ): Promise<ChainResourceRecord> {
    const normalized = normalizeResourceId(resourceId);
    const resource = this.resources.get(normalized);
    if (resource === undefined) throw new ChainResourceError("CHAIN_RESOURCE_NOT_FOUND", 404);
    return authorize(resource, actorWallet, method, this.committeeMembers, this.platformArbiter);
  }

  async recordArbitrationReview(resourceId: string, actorWallet: string, args: { agentsWin: boolean }, now: Date): Promise<ArbitrationReviewRecord> {
    const resource = await this.requireAuthorized(resourceId, actorWallet, "resolveWorkflowTask");
    const review = createReviewRecord(resource, actorWallet, args, now);
    this.arbitrationReviews.set(resource.resourceId, review);
    return review;
  }

  async readArbitrationReview(resourceId: string, actorWallet: string, now: Date): Promise<ArbitrationReviewRecord | null> {
    const resource = await this.requireAuthorized(resourceId, actorWallet, "resolveWorkflowTask");
    const review = this.arbitrationReviews.get(resource.resourceId);
    if (!review || review.resourceRevision !== requireTaskRevision(resource) || Date.parse(review.expiresAt) <= now.getTime()) return null;
    return review.reviewerWallet === getAddress(actorWallet).toLowerCase() ? review : null;
  }

  async requireResolutionReview(resourceId: string, actorWallet: string, args: { agentsWin: boolean }, now: Date): Promise<ResolutionReviewBinding> {
    const resource = await this.requireAuthorized(resourceId, actorWallet, "resolveWorkflowTask");
    return { resource, review: validateResolutionReview(resource, this.arbitrationReviews.get(resource.resourceId), actorWallet, args, now) };
  }
}

interface ResourceRow {
  resource_id: string;
  publisher_wallet: string;
  agent_wallet: string | null;
  budget_atomic: string;
  status: TaskResourceStatus;
  resource_kind: "task" | "account";
  revision: number | null;
}

interface ArbitrationReviewRow {
  review_id: string;
  resource_id: string;
  resource_revision: number;
  reviewer_wallet: string;
  outcome: "agents_win" | "publisher_wins";
  args: { agentsWin: boolean };
  review_hash: string;
  created_at: string;
  expires_at: string;
}

function reviewFromRow(row: ArbitrationReviewRow): ArbitrationReviewRecord {
  return {
    reviewId: row.review_id, resourceId: row.resource_id, resourceRevision: row.resource_revision,
    reviewerWallet: row.reviewer_wallet, agentsWin: row.outcome === "agents_win",
    args: row.args, reviewHash: row.review_hash,
    createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
  };
}

export class PostgresChainResourceRepository implements ChainResourceRepository {
  private readonly committeeMembers: ReadonlySet<string>;
  private readonly platformArbiter: string | null;

  private constructor(private readonly sql: Sql, committeeMembers: readonly string[], platformArbiter?: string) {
    this.committeeMembers = new Set(committeeMembers.map((wallet) => getAddress(wallet)));
    this.platformArbiter = platformArbiter ? getAddress(platformArbiter) : null;
  }

  static connect(databaseUrl: string, committeeMembers: readonly string[] = [], platformArbiter?: string): PostgresChainResourceRepository {
    return new PostgresChainResourceRepository(postgres(databaseUrl, { max: 5, prepare: false }), committeeMembers, platformArbiter);
  }

  async createTaskDraft(input: TaskDraftRecord): Promise<ChainResourceRecord> {
    const resourceId = normalizeResourceId(input.resourceId);
    const publisherWallet = getAddress(input.publisherWallet).toLowerCase();
    await this.sql`
      INSERT INTO agent_market.tasks (
        id, publisher_wallet, title, description, requirements, budget_atomic,
        status, request_id, category, tags
      ) VALUES (
        ${resourceId}::uuid, ${publisherWallet}, ${input.title}, ${input.description},
        ${input.requirements}, ${input.budgetAtomic}, 'funding_pending',
        ${input.requestId}::uuid, ${input.category}, ${input.tags}
      )
      ON CONFLICT (request_id) DO NOTHING
    `;
    const rows = await this.sql<ResourceRow[]>`
      SELECT t.id::text AS resource_id, t.publisher_wallet,
        a.owner_wallet AS agent_wallet, t.budget_atomic::text AS budget_atomic, t.status,
        'task'::text AS resource_kind, t.version AS revision
      FROM agent_market.tasks AS t
      LEFT JOIN agent_market.agents AS a ON a.id = t.agent_id
      WHERE t.request_id = ${input.requestId}::uuid
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) throw new ChainResourceError("CHAIN_RESOURCE_NOT_PERSISTED", 503);
    if (row.publisher_wallet !== publisherWallet || row.budget_atomic !== input.budgetAtomic) {
      throw new ChainResourceError("CHAIN_RESOURCE_CONFLICT", 409);
    }
    return {
      resourceId: row.resource_id,
      kind: "task",
      publisherWallet: row.publisher_wallet,
      agentWallet: row.agent_wallet,
      budgetAtomic: row.budget_atomic,
      status: row.status,
      ...(row.revision === null ? {} : { revision: row.revision }),
    };
  }

  async createChainAccount(resourceIdInput: string, walletAddress: string): Promise<ChainResourceRecord> {
    const resourceId = normalizeResourceId(resourceIdInput);
    const publisherWallet = getAddress(walletAddress).toLowerCase();
    await this.sql`
      INSERT INTO agent_market.chain_account_resources (id, wallet_address)
      VALUES (${resourceId}::uuid, ${publisherWallet})
      ON CONFLICT (wallet_address) DO NOTHING
    `;
    const rows = await this.sql<ResourceRow[]>`
      SELECT id::text AS resource_id, wallet_address AS publisher_wallet,
        NULL::text AS agent_wallet, '1'::text AS budget_atomic,
        'open'::text AS status, 'account'::text AS resource_kind, NULL::integer AS revision
      FROM agent_market.chain_account_resources
      WHERE wallet_address = ${publisherWallet}
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) throw new ChainResourceError("CHAIN_RESOURCE_NOT_PERSISTED", 503);
    return { resourceId: row.resource_id, kind: "account", publisherWallet: row.publisher_wallet, agentWallet: null, budgetAtomic: "1", status: "open" };
  }

  async requireAuthorized(
    resourceId: string,
    actorWallet: string,
    method: TransactionMethod,
  ): Promise<ChainResourceRecord> {
    const normalized = normalizeResourceId(resourceId);
    const rows = await this.sql<ResourceRow[]>`
      SELECT * FROM (
        SELECT t.id::text AS resource_id, t.publisher_wallet,
          a.owner_wallet AS agent_wallet, t.budget_atomic::text AS budget_atomic,
          t.status, 'task'::text AS resource_kind, t.version AS revision
        FROM agent_market.tasks AS t
        LEFT JOIN agent_market.agents AS a ON a.id = t.agent_id
        WHERE t.id = ${normalized}::uuid
        UNION ALL
        SELECT c.id::text AS resource_id, c.wallet_address AS publisher_wallet,
          NULL::text AS agent_wallet, '1'::text AS budget_atomic,
          'open'::text AS status, 'account'::text AS resource_kind, NULL::integer AS revision
        FROM agent_market.chain_account_resources AS c
        WHERE c.id = ${normalized}::uuid
      ) AS resources
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) throw new ChainResourceError("CHAIN_RESOURCE_NOT_FOUND", 404);
    return authorize({
      resourceId: row.resource_id,
      kind: row.resource_kind,
      publisherWallet: row.publisher_wallet,
      agentWallet: row.agent_wallet,
      budgetAtomic: row.budget_atomic,
      status: row.status,
      ...(row.revision === null ? {} : { revision: row.revision }),
    }, actorWallet, method, this.committeeMembers, this.platformArbiter);
  }

  async recordArbitrationReview(resourceId: string, actorWallet: string, args: { agentsWin: boolean }, now: Date): Promise<ArbitrationReviewRecord> {
    const normalized = normalizeResourceId(resourceId);
    return this.sql.begin(async sql => {
      const rows = await sql<ResourceRow[]>`
        SELECT t.id::text AS resource_id, t.publisher_wallet, a.owner_wallet AS agent_wallet,
          t.budget_atomic::text AS budget_atomic, t.status, 'task'::text AS resource_kind, t.version AS revision
        FROM agent_market.tasks AS t LEFT JOIN agent_market.agents AS a ON a.id = t.agent_id
        WHERE t.id = ${normalized}::uuid FOR UPDATE OF t
      `;
      const row = rows[0];
      if (!row) throw new ChainResourceError("CHAIN_RESOURCE_NOT_FOUND", 404);
      const resource = authorize({ resourceId: row.resource_id, kind: "task", publisherWallet: row.publisher_wallet, agentWallet: row.agent_wallet, budgetAtomic: row.budget_atomic, status: row.status, ...(row.revision === null ? {} : { revision: row.revision }) }, actorWallet, "resolveWorkflowTask", this.committeeMembers, this.platformArbiter);
      const review = createReviewRecord(resource, actorWallet, args, now);
      await sql`UPDATE agent_market.chain_arbitration_reviews SET superseded_at = ${review.createdAt} WHERE resource_id = ${normalized}::uuid AND superseded_at IS NULL`;
      await sql`
        INSERT INTO agent_market.chain_arbitration_reviews
          (id, resource_id, resource_revision, reviewer_wallet, outcome, args, review_hash, created_at, expires_at)
        VALUES (${review.reviewId}, ${normalized}::uuid, ${review.resourceRevision}, ${review.reviewerWallet},
          ${review.agentsWin ? "agents_win" : "publisher_wins"}, ${sql.json(review.args)}, ${review.reviewHash}, ${review.createdAt}, ${review.expiresAt})
      `;
      return review;
    });
  }

  async readArbitrationReview(resourceId: string, actorWallet: string, now: Date): Promise<ArbitrationReviewRecord | null> {
    const resource = await this.requireAuthorized(resourceId, actorWallet, "resolveWorkflowTask");
    const rows = await this.sql<ArbitrationReviewRow[]>`
      SELECT id::text AS review_id, resource_id::text, resource_revision, reviewer_wallet, outcome, args,
        review_hash, created_at::text, expires_at::text
      FROM agent_market.chain_arbitration_reviews
      WHERE resource_id = ${resource.resourceId}::uuid AND superseded_at IS NULL
        AND resource_revision = ${requireTaskRevision(resource)} AND expires_at > ${now.toISOString()}
      LIMIT 1
    `;
    const review = rows[0] ? reviewFromRow(rows[0]) : null;
    return review?.reviewerWallet === getAddress(actorWallet).toLowerCase() ? review : null;
  }

  async requireResolutionReview(resourceId: string, actorWallet: string, args: { agentsWin: boolean }, now: Date): Promise<ResolutionReviewBinding> {
    const normalized = normalizeResourceId(resourceId);
    return this.sql.begin(async sql => {
      const resourceRows = await sql<ResourceRow[]>`
        SELECT t.id::text AS resource_id, t.publisher_wallet, a.owner_wallet AS agent_wallet,
          t.budget_atomic::text AS budget_atomic, t.status, 'task'::text AS resource_kind, t.version AS revision
        FROM agent_market.tasks AS t LEFT JOIN agent_market.agents AS a ON a.id = t.agent_id
        WHERE t.id = ${normalized}::uuid FOR UPDATE OF t
      `;
      const row = resourceRows[0];
      if (!row) throw new ChainResourceError("CHAIN_RESOURCE_NOT_FOUND", 404);
      const resource = authorize({ resourceId: row.resource_id, kind: "task", publisherWallet: row.publisher_wallet, agentWallet: row.agent_wallet, budgetAtomic: row.budget_atomic, status: row.status, ...(row.revision === null ? {} : { revision: row.revision }) }, actorWallet, "resolveWorkflowTask", this.committeeMembers, this.platformArbiter);
      const reviewRows = await sql<ArbitrationReviewRow[]>`
        SELECT id::text AS review_id, resource_id::text, resource_revision, reviewer_wallet, outcome, args,
          review_hash, created_at::text, expires_at::text
        FROM agent_market.chain_arbitration_reviews
        WHERE resource_id = ${normalized}::uuid AND superseded_at IS NULL
        LIMIT 1 FOR UPDATE
      `;
      const review = reviewRows[0] ? reviewFromRow(reviewRows[0]) : undefined;
      return { resource, review: validateResolutionReview(resource, review, actorWallet, args, now) };
    });
  }
}
