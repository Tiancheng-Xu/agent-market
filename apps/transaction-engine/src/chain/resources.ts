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
  publisherWallet: string;
  agentWallet: string | null;
  budgetAtomic: string;
  status: TaskResourceStatus;
}

export interface ChainTransactionExpectation {
  resourceId: string;
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
}

export class PostgresChainResourceRepository implements ChainResourceRepository {
  private readonly committeeMembers: ReadonlySet<string>;

  private constructor(private readonly sql: Sql, committeeMembers: readonly string[]) {
    this.committeeMembers = new Set(committeeMembers.map((wallet) => getAddress(wallet)));
  }

  static connect(databaseUrl: string, committeeMembers: readonly string[] = []): PostgresChainResourceRepository {
    return new PostgresChainResourceRepository(postgres(databaseUrl, { max: 5, prepare: false }), committeeMembers);
  }

  async requireAuthorized(
    resourceId: string,
    actorWallet: string,
    method: TransactionMethod,
  ): Promise<ChainResourceRecord> {
    const normalized = normalizeResourceId(resourceId);
    const rows = await this.sql<ResourceRow[]>`
      SELECT t.id::text AS resource_id, t.publisher_wallet,
        a.owner_wallet AS agent_wallet, t.budget_atomic::text AS budget_atomic, t.status
      FROM agent_market.tasks AS t
      LEFT JOIN agent_market.agents AS a ON a.id = t.agent_id
      WHERE t.id = ${normalized}::uuid
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) throw new ChainResourceError("CHAIN_RESOURCE_NOT_FOUND", 404);
    return authorize({
      resourceId: row.resource_id,
      publisherWallet: row.publisher_wallet,
      agentWallet: row.agent_wallet,
      budgetAtomic: row.budget_atomic,
      status: row.status,
    }, actorWallet, method, this.committeeMembers);
  }
}
