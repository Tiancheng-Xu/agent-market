import { getAddress } from "ethers";
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
}

const ACTIVE_STATUSES: readonly TaskResourceStatus[] = [
  "open", "funding_pending", "funded", "matching", "assigned", "in_progress",
  "submitted", "accepted", "disputed", "settled",
];

const METHOD_STATUSES: Record<TransactionMethod, readonly TaskResourceStatus[]> = {
  faucet: ACTIVE_STATUSES,
  approve: ACTIVE_STATUSES,
  createTask: ["open", "funding_pending"],
  assignAgent: ["matching", "assigned"],
  acceptTask: ["assigned"],
  submitWork: ["in_progress"],
  acceptWork: ["submitted", "accepted"],
  timeoutTask: ["in_progress"],
  openDispute: ["in_progress", "submitted", "disputed"],
  castVote: ["disputed"],
  stake: ACTIVE_STATUSES,
  unstake: ACTIVE_STATUSES,
  claimYield: ACTIVE_STATUSES,
};

const PUBLISHER_METHODS = new Set<TransactionMethod>([
  "faucet", "approve", "createTask", "assignAgent", "acceptWork", "timeoutTask",
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
): ChainTransactionExpectation {
  const budget = BigInt(resource.budgetAtomic);
  return {
    resourceId: resource.resourceId,
    ...(resource.kind === "account" ? { resourceKind: "account" as const } : {}),
    budgetAtomic: budget.toString(),
    bondAtomic: ((budget * 6n) / 100n).toString(),
    agentWins: method === "acceptWork" ? true : method === "timeoutTask" ? false : null,
  };
}

function authorize(
  resource: ChainResourceRecord,
  actorWallet: string,
  method: TransactionMethod,
  committeeMembers: ReadonlySet<string>,
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
  private readonly committeeMembers: ReadonlySet<string>;

  constructor(resources: readonly ChainResourceRecord[], committeeMembers: readonly string[] = []) {
    for (const resource of resources) {
      const resourceId = normalizeResourceId(resource.resourceId);
      this.resources.set(resourceId, { ...resource, resourceId });
    }
    this.committeeMembers = new Set(committeeMembers.map((wallet) => getAddress(wallet)));
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
    return authorize(resource, actorWallet, method, this.committeeMembers);
  }
}

interface ResourceRow {
  resource_id: string;
  publisher_wallet: string;
  agent_wallet: string | null;
  budget_atomic: string;
  status: TaskResourceStatus;
  resource_kind: "task" | "account";
}

export class PostgresChainResourceRepository implements ChainResourceRepository {
  private readonly committeeMembers: ReadonlySet<string>;

  private constructor(private readonly sql: Sql, committeeMembers: readonly string[]) {
    this.committeeMembers = new Set(committeeMembers.map((wallet) => getAddress(wallet)));
  }

  static connect(databaseUrl: string, committeeMembers: readonly string[] = []): PostgresChainResourceRepository {
    return new PostgresChainResourceRepository(postgres(databaseUrl, { max: 5, prepare: false }), committeeMembers);
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
        a.owner_wallet AS agent_wallet, t.budget_atomic::text AS budget_atomic, t.status
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
        'open'::text AS status, 'account'::text AS resource_kind
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
          t.status, 'task'::text AS resource_kind
        FROM agent_market.tasks AS t
        LEFT JOIN agent_market.agents AS a ON a.id = t.agent_id
        WHERE t.id = ${normalized}::uuid
        UNION ALL
        SELECT c.id::text AS resource_id, c.wallet_address AS publisher_wallet,
          NULL::text AS agent_wallet, '1'::text AS budget_atomic,
          'open'::text AS status, 'account'::text AS resource_kind
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
    }, actorWallet, method, this.committeeMembers);
  }
}
