import postgres, { type Sql } from "postgres";

import {
  TransactionIntentV1Schema,
  TransactionVerificationV1Schema,
  type TransactionIntentV1,
  type TransactionVerificationV1,
} from "@agent-market/shared-contracts";
import type { ChainTransactionExpectation } from "./resources";

export interface CanonicalObservation {
  blockHash: string;
  requestRef?: string;
}

export interface TransactionStore {
  createIntent(
    intent: TransactionIntentV1,
    expectation: ChainTransactionExpectation,
  ): Promise<TransactionIntentV1>;
  findIntent(intentId: string): Promise<TransactionIntentV1 | null>;
  findExpectation(intentId: string): Promise<ChainTransactionExpectation | null>;
  recordSubmission(intentId: string, txHash: string, submittedAt: string): Promise<void>;
  saveVerification(
    verification: TransactionVerificationV1,
    observation?: CanonicalObservation,
  ): Promise<TransactionVerificationV1>;
  findVerification(intentId: string): Promise<TransactionVerificationV1 | null>;
  findCanonicalBlockHash(intentId: string): Promise<string | null>;
}

interface StoredTransaction {
  intent: TransactionIntentV1;
  expectation: ChainTransactionExpectation;
  txHash?: string;
  verification?: TransactionVerificationV1;
  blockHash?: string;
}

const REQUEST_REF_EVENT_METHODS = new Set<TransactionIntentV1["method"]>([
  "createTask", "createWorkflowTask", "assignAgent", "acceptTask", "submitWork", "acceptWork", "timeoutTask", "openDispute",
]);

function sameIntentPayload(left: TransactionIntentV1, right: TransactionIntentV1): boolean {
  const fields: readonly (keyof TransactionIntentV1)[] = [
    "intentId", "requestId", "requestRef", "chainId", "from", "to", "method", "data", "valueAtomic",
  ];
  return fields.every((field) => left[field] === right[field]);
}

function sameExpectation(left: ChainTransactionExpectation, right: ChainTransactionExpectation): boolean {
  return left.resourceId === right.resourceId
    && (left.resourceKind ?? "task") === (right.resourceKind ?? "task")
    && left.budgetAtomic === right.budgetAtomic
    && left.bondAtomic === right.bondAtomic
    && left.agentWins === right.agentWins
    && left.resourceRevision === right.resourceRevision
    && left.reviewId === right.reviewId
    && left.reviewHash === right.reviewHash
    && left.reviewExpiresAt === right.reviewExpiresAt;
}

function validateObservation(
  intent: TransactionIntentV1,
  status: TransactionVerificationV1["status"],
  observation?: CanonicalObservation,
): void {
  if (status === "confirmed" && observation === undefined) {
    throw new Error("CHAIN_CANONICAL_OBSERVATION_REQUIRED");
  }
  if (observation === undefined) return;
  if (!/^0x[0-9a-f]{64}$/u.test(observation.blockHash.toLowerCase())) {
    throw new Error("CHAIN_CANONICAL_OBSERVATION_INVALID");
  }
  if (observation.requestRef !== undefined
    && observation.requestRef.toLowerCase() !== intent.requestRef.toLowerCase()) {
    throw new Error("CHAIN_REQUEST_REF_CONFLICT");
  }
  if (status === "confirmed" && REQUEST_REF_EVENT_METHODS.has(intent.method)
    && observation.requestRef === undefined) {
    throw new Error("CHAIN_REQUEST_REF_OBSERVATION_REQUIRED");
  }
}

export class MemoryTransactionStore implements TransactionStore {
  private readonly records = new Map<string, StoredTransaction>();

  async createIntent(
    input: TransactionIntentV1,
    expectation: ChainTransactionExpectation,
  ): Promise<TransactionIntentV1> {
    const intent = TransactionIntentV1Schema.parse(input);
    const existing = this.records.get(intent.intentId);
    if (existing) {
      if (!sameIntentPayload(existing.intent, intent) || !sameExpectation(existing.expectation, expectation)) {
        throw new Error("CHAIN_INTENT_CONFLICT");
      }
      return existing.intent;
    }
    this.records.set(intent.intentId, { intent, expectation });
    return intent;
  }

  async findExpectation(intentId: string): Promise<ChainTransactionExpectation | null> {
    return this.records.get(intentId)?.expectation ?? null;
  }

  async findIntent(intentId: string): Promise<TransactionIntentV1 | null> {
    return this.records.get(intentId)?.intent ?? null;
  }

  async recordSubmission(intentId: string, txHash: string, _submittedAt: string): Promise<void> {
    const record = this.records.get(intentId);
    if (!record) throw new Error("CHAIN_INTENT_NOT_FOUND");
    const normalized = txHash.toLowerCase();
    if (record.txHash && record.txHash !== normalized) throw new Error("CHAIN_TRANSACTION_CONFLICT");
    record.txHash = normalized;
  }

  async saveVerification(
    input: TransactionVerificationV1,
    observation?: CanonicalObservation,
  ): Promise<TransactionVerificationV1> {
    const verification = TransactionVerificationV1Schema.parse(input);
    const record = this.records.get(verification.intentId);
    if (!record) throw new Error("CHAIN_INTENT_NOT_FOUND");
    if (record.txHash && record.txHash !== verification.txHash) throw new Error("CHAIN_TRANSACTION_CONFLICT");
    validateObservation(record.intent, verification.status, observation);
    if (record.verification?.status === "confirmed" && verification.status !== "reorged") return record.verification;
    record.txHash = verification.txHash;
    record.verification = verification;
    if (observation) record.blockHash = observation.blockHash.toLowerCase();
    return verification;
  }

  async findVerification(intentId: string): Promise<TransactionVerificationV1 | null> {
    return this.records.get(intentId)?.verification ?? null;
  }

  async findCanonicalBlockHash(intentId: string): Promise<string | null> {
    return this.records.get(intentId)?.blockHash ?? null;
  }
}

interface ChainTransactionRow {
  intent_id: string;
  request_id: string;
  request_ref: string;
  chain_id: string;
  actor_wallet: string;
  contract_address: string;
  method: TransactionIntentV1["method"];
  call_data: string | null;
  expected_value_atomic: string;
  created_at: string;
  expires_at: string | null;
  transaction_hash: string | null;
  status: TransactionVerificationV1["status"] | "created" | "submitted";
  block_number: string | null;
  confirmations: number;
  error_code: string | null;
  event_name: string | null;
  checked_at: string | null;
  block_hash: string | null;
  resource_id: string | null;
  expected_budget_atomic: string | null;
  expected_bond_atomic: string | null;
  expected_agent_wins: boolean | null;
  resource_kind: "task" | "account";
  expected_resource_revision: number | null;
  expected_review_id: string | null;
  expected_review_hash: string | null;
  expected_review_expires_at: string | null;
}

export class PostgresTransactionStore implements TransactionStore {
  constructor(private readonly sql: Sql) {}

  static connect(databaseUrl: string): PostgresTransactionStore {
    return new PostgresTransactionStore(postgres(databaseUrl, { max: 8, prepare: false }));
  }

  async createIntent(
    input: TransactionIntentV1,
    expectation: ChainTransactionExpectation,
  ): Promise<TransactionIntentV1> {
    const intent = TransactionIntentV1Schema.parse(input);
    await this.sql`
      INSERT INTO agent_market.chain_transactions (
        id, intent_id, request_id, request_ref, chain_id, actor_wallet,
        contract_address, method, call_data, expected_value_atomic,
        resource_id, resource_kind, expected_budget_atomic, expected_bond_atomic, expected_agent_wins,
        expected_resource_revision, expected_review_id, expected_review_hash, expected_review_expires_at,
        status, created_at, expires_at
      ) VALUES (
        ${intent.intentId}, ${intent.intentId}, ${intent.requestId},
        decode(${intent.requestRef.slice(2)}, 'hex'), ${intent.chainId}, ${intent.from},
        ${intent.to}, ${intent.method}, ${intent.data.toLowerCase()}, ${intent.valueAtomic},
        ${expectation.resourceId}, ${expectation.resourceKind ?? "task"}, ${expectation.budgetAtomic}, ${expectation.bondAtomic}, ${expectation.agentWins},
        ${expectation.resourceRevision ?? null}, ${expectation.reviewId ?? null}, ${expectation.reviewHash ?? null}, ${expectation.reviewExpiresAt ?? null},
        'created', ${intent.createdAt}, ${intent.expiresAt}
      )
      ON CONFLICT (intent_id) DO NOTHING
    `;
    const persisted = await this.findIntent(intent.intentId);
    if (!persisted) throw new Error("CHAIN_INTENT_NOT_PERSISTED");
    const persistedExpectation = await this.findExpectation(intent.intentId);
    if (!sameIntentPayload(persisted, intent) || persistedExpectation === null
      || !sameExpectation(persistedExpectation, expectation)) throw new Error("CHAIN_INTENT_CONFLICT");
    return persisted;
  }

  async findExpectation(intentId: string): Promise<ChainTransactionExpectation | null> {
    const rows = await this.sql<ChainTransactionRow[]>`
      SELECT resource_id::text, resource_kind, expected_budget_atomic::text, expected_bond_atomic::text,
        expected_agent_wins, expected_resource_revision, expected_review_id::text,
        expected_review_hash, expected_review_expires_at::text
      FROM agent_market.chain_transactions WHERE intent_id = ${intentId} LIMIT 1
    `;
    const row = rows[0];
    if (!row?.resource_id || row.expected_budget_atomic === null || row.expected_bond_atomic === null) return null;
    return {
      resourceId: row.resource_id,
      resourceKind: row.resource_kind,
      budgetAtomic: row.expected_budget_atomic,
      bondAtomic: row.expected_bond_atomic,
      agentWins: row.expected_agent_wins,
      ...(row.expected_resource_revision === null ? {} : { resourceRevision: row.expected_resource_revision }),
      ...(row.expected_review_id === null ? {} : { reviewId: row.expected_review_id }),
      ...(row.expected_review_hash === null ? {} : { reviewHash: row.expected_review_hash }),
      ...(row.expected_review_expires_at === null ? {} : { reviewExpiresAt: new Date(row.expected_review_expires_at).toISOString() }),
    };
  }

  async findIntent(intentId: string): Promise<TransactionIntentV1 | null> {
    const rows = await this.sql<ChainTransactionRow[]>`
      SELECT intent_id, request_id, encode(request_ref, 'hex') AS request_ref,
        chain_id::text, actor_wallet, contract_address, method, call_data,
        expected_value_atomic::text, created_at::text, expires_at::text,
        transaction_hash, status, block_number::text, confirmations,
        error_code, event_name, checked_at::text, block_hash
      FROM agent_market.chain_transactions WHERE intent_id = ${intentId} LIMIT 1
    `;
    const row = rows[0];
    if (!row?.call_data || !row.expires_at) return null;
    return TransactionIntentV1Schema.parse({
      intentId: row.intent_id,
      requestId: row.request_id,
      requestRef: `0x${row.request_ref}`,
      chainId: Number(row.chain_id),
      from: row.actor_wallet,
      to: row.contract_address,
      method: row.method,
      data: row.call_data,
      valueAtomic: row.expected_value_atomic,
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    });
  }

  async recordSubmission(intentId: string, txHash: string, submittedAt: string): Promise<void> {
    const normalized = txHash.toLowerCase();
    const rows = await this.sql<{ intent_id: string }[]>`
      UPDATE agent_market.chain_transactions
      SET transaction_hash = ${normalized}, status = 'submitted', submitted_at = ${submittedAt}
      WHERE intent_id = ${intentId}
        AND (transaction_hash IS NULL OR transaction_hash = ${normalized})
      RETURNING intent_id
    `;
    if (rows.length === 0) {
      if (!await this.findIntent(intentId)) throw new Error("CHAIN_INTENT_NOT_FOUND");
      throw new Error("CHAIN_TRANSACTION_CONFLICT");
    }
  }

  async saveVerification(
    input: TransactionVerificationV1,
    observation?: CanonicalObservation,
  ): Promise<TransactionVerificationV1> {
    const verification = TransactionVerificationV1Schema.parse(input);
    const intent = await this.findIntent(verification.intentId);
    if (!intent) throw new Error("CHAIN_INTENT_NOT_FOUND");
    validateObservation(intent, verification.status, observation);
    const eventName = verification.status === "confirmed" ? verification.eventName : null;
    const errorCode = verification.status === "failed" || verification.status === "reorged"
      ? verification.errorCode
      : null;
    const rows = await this.sql<{ intent_id: string }[]>`
      UPDATE agent_market.chain_transactions SET
        transaction_hash = ${verification.txHash}, status = ${verification.status},
        block_number = ${verification.blockNumber}, confirmations = ${verification.confirmations},
        error_code = ${errorCode}, event_name = ${eventName},
        block_hash = COALESCE(${observation?.blockHash.toLowerCase() ?? null}, block_hash),
        event_request_ref = COALESCE(${observation?.requestRef
          ? this.sql`decode(${observation.requestRef.slice(2)}, 'hex')` : null}, event_request_ref),
        checked_at = ${verification.checkedAt},
        confirmed_at = ${verification.status === "confirmed" ? verification.checkedAt : null}
      WHERE intent_id = ${verification.intentId}
        AND (transaction_hash IS NULL OR transaction_hash = ${verification.txHash})
        AND (status != 'confirmed' OR ${verification.status} = 'reorged')
      RETURNING intent_id
    `;
    if (rows.length === 0) {
      const existing = await this.findVerification(verification.intentId);
      if (existing?.status === "confirmed" && verification.status !== "reorged"
        && existing.txHash === verification.txHash) return existing;
      throw new Error("CHAIN_TRANSACTION_CONFLICT");
    }
    return await this.findVerification(verification.intentId) ?? verification;
  }

  async findVerification(intentId: string): Promise<TransactionVerificationV1 | null> {
    const rows = await this.sql<ChainTransactionRow[]>`
      SELECT intent_id, request_id, encode(request_ref, 'hex') AS request_ref,
        chain_id::text, actor_wallet, contract_address, method, call_data,
        expected_value_atomic::text, created_at::text, expires_at::text,
        transaction_hash, status, block_number::text, confirmations,
        error_code, event_name, checked_at::text, block_hash
      FROM agent_market.chain_transactions WHERE intent_id = ${intentId} LIMIT 1
    `;
    const row = rows[0];
    if (!row?.transaction_hash || !row.checked_at || !["verifying", "confirmed", "failed", "reorged"].includes(row.status)) return null;
    const base = {
      intentId: row.intent_id,
      requestId: row.request_id,
      txHash: row.transaction_hash,
      status: row.status,
      confirmations: row.confirmations,
      blockNumber: row.block_number === null ? null : Number(row.block_number),
      checkedAt: new Date(row.checked_at).toISOString(),
    };
    return TransactionVerificationV1Schema.parse(row.status === "confirmed"
      ? { ...base, eventName: row.event_name }
      : row.status === "failed" || row.status === "reorged"
        ? { ...base, errorCode: row.error_code }
        : base);
  }

  async findCanonicalBlockHash(intentId: string): Promise<string | null> {
    const rows = await this.sql<{ block_hash: string | null }[]>`
      SELECT block_hash FROM agent_market.chain_transactions WHERE intent_id = ${intentId} LIMIT 1
    `;
    return rows[0]?.block_hash?.toLowerCase() ?? null;
  }
}
