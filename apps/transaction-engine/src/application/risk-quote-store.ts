import { createHash, randomUUID } from "node:crypto";

import { RiskQuoteSchema, type RiskQuote } from "@agent-market/shared-contracts";
import type { Sql, TransactionSql } from "postgres";

const WALLET = /^0x[0-9a-f]{40}$/u;

export interface RiskQuoteAssignment {
  agentId: string;
  agentWallet: string;
}

export interface IssueRiskQuoteInput {
  taskId: string;
  publisherWallet: string;
  dagRevision: number;
  assignments: readonly RiskQuoteAssignment[];
  quote: RiskQuote;
  createdAt: string;
}

export interface StoredRiskQuote {
  id: string;
  taskId: string;
  publisherWallet: string;
  version: number;
  dagRevision: number;
  assignments: RiskQuoteAssignment[];
  quote: RiskQuote;
  basisFingerprint: string;
  status: "active" | "superseded";
  supersededBy: string | null;
  supersededAt: string | null;
  manualApprovedAt: string | null;
  manualApprovedBy: string | null;
  createdAt: string;
}

export interface ConfirmRiskQuoteInput {
  quoteId: string;
  actorType: "publisher" | "agent";
  actorWallet: string;
  agentId?: string;
  taskFingerprint: string;
  confirmedAt: string;
}

export interface ApproveRiskQuoteInput {
  quoteId: string;
  approvedAt: string;
  approvedBy: string;
  approverRole: "platform_operator" | "risk_assessor" | "agent";
}

export interface EvaluateRiskQuoteInput {
  taskId: string;
  quoteId: string;
  taskFingerprint: string;
  evaluatedAt: string;
}

export type RiskQuoteGateDecision =
  | { status: "ready"; code: "RISK_QUOTE_READY"; quoteId: string }
  | { status: "blocked"; code: string; quoteId: string }
  | { status: "manual_review"; code: string; reasonCode: string; quoteId: string };

interface RiskQuoteConfirmation {
  quoteId: string;
  actorType: "publisher" | "agent";
  actorKey: string;
  actorWallet: string;
  agentId: string | null;
  taskFingerprint: string;
  confirmedAt: string;
}

export interface RiskQuoteStore {
  issue(input: IssueRiskQuoteInput): Promise<StoredRiskQuote>;
  find(quoteId: string): Promise<StoredRiskQuote | null>;
  confirm(input: ConfirmRiskQuoteInput): Promise<void>;
  approveManual(input: ApproveRiskQuoteInput): Promise<void>;
  evaluatePreliminary(input: EvaluateRiskQuoteInput): Promise<RiskQuoteGateDecision>;
  evaluateFunding(input: EvaluateRiskQuoteInput): Promise<RiskQuoteGateDecision>;
}

const normalizeWallet = (wallet: string): string => wallet.toLowerCase();
const iso = (value: string | Date): string => new Date(value).toISOString();

function assertWallet(wallet: string): string {
  const normalized = normalizeWallet(wallet);
  if (!WALLET.test(normalized)) throw new Error("RISK_QUOTE_WALLET_INVALID");
  return normalized;
}

function canonicalAssignments(assignments: readonly RiskQuoteAssignment[]): RiskQuoteAssignment[] {
  const normalized = assignments.map(({ agentId, agentWallet }) => ({
    agentId: agentId.trim(),
    agentWallet: assertWallet(agentWallet),
  })).sort((left, right) => left.agentId.localeCompare(right.agentId));
  if (normalized.some(({ agentId }) => agentId.length === 0 || agentId.length > 160)) {
    throw new Error("RISK_QUOTE_AGENT_ID_INVALID");
  }
  if (new Set(normalized.map(({ agentId }) => agentId).map((value) => value.toLowerCase())).size !== normalized.length) {
    throw new Error("RISK_QUOTE_ASSIGNMENT_DUPLICATED");
  }
  if (new Set(normalized.map(({ agentWallet }) => agentWallet)).size !== normalized.length) {
    throw new Error("RISK_QUOTE_ASSIGNMENT_WALLET_DUPLICATED");
  }
  return normalized;
}

function validateIssue(input: IssueRiskQuoteInput) {
  const quote = RiskQuoteSchema.parse(input.quote);
  const publisherWallet = assertWallet(input.publisherWallet);
  const assignments = canonicalAssignments(input.assignments);
  if (!Number.isInteger(input.dagRevision) || input.dagRevision < 0) throw new Error("RISK_QUOTE_DAG_REVISION_INVALID");
  const createdAt = iso(input.createdAt);
  if (new Date(quote.expiresAt).getTime() <= new Date(createdAt).getTime()) throw new Error("RISK_QUOTE_EXPIRY_INVALID");
  const allocationIds = [...quote.agentAllocations.map(({ agentId }) => agentId)].sort();
  const assignmentIds = [...assignments.map(({ agentId }) => agentId)].sort();
  if (JSON.stringify(allocationIds) !== JSON.stringify(assignmentIds)) {
    throw new Error("RISK_QUOTE_ASSIGNMENTS_MISMATCH");
  }
  return { quote, publisherWallet, assignments, createdAt };
}

function basisFingerprint(input: {
  taskId: string;
  publisherWallet: string;
  dagRevision: number;
  assignments: readonly RiskQuoteAssignment[];
  quote: RiskQuote;
}): string {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return `sha256:${digest}`;
}

function manualDecision(quoteId: string, code: string, reasonCode: string): RiskQuoteGateDecision {
  return { status: "manual_review", code, reasonCode, quoteId };
}

function blockedDecision(quoteId: string, code: string): RiskQuoteGateDecision {
  return { status: "blocked", code, quoteId };
}

function confirmationKey(input: ConfirmRiskQuoteInput): string {
  return input.actorType === "publisher" ? normalizeWallet(input.actorWallet) : String(input.agentId);
}

function validateConfirmation(record: StoredRiskQuote, input: ConfirmRiskQuoteInput): RiskQuoteConfirmation {
  if (record.status !== "active") throw new Error("RISK_QUOTE_SUPERSEDED");
  if (record.quote.taskFingerprint !== input.taskFingerprint) throw new Error("RISK_QUOTE_FINGERPRINT_MISMATCH");
  if (new Date(input.confirmedAt).getTime() >= new Date(record.quote.expiresAt).getTime()) throw new Error("RISK_QUOTE_EXPIRED");
  const actorWallet = assertWallet(input.actorWallet);
  if (input.actorType === "publisher") {
    if (actorWallet !== record.publisherWallet || input.agentId !== undefined) throw new Error("RISK_QUOTE_PUBLISHER_FORBIDDEN");
  } else {
    const assignment = record.assignments.find(({ agentId }) => agentId === input.agentId);
    if (!assignment || assignment.agentWallet !== actorWallet) throw new Error("RISK_QUOTE_AGENT_FORBIDDEN");
  }
  return {
    quoteId: record.id,
    actorType: input.actorType,
    actorKey: confirmationKey(input),
    actorWallet,
    agentId: input.agentId ?? null,
    taskFingerprint: input.taskFingerprint,
    confirmedAt: iso(input.confirmedAt),
  };
}

function evaluateBase(record: StoredRiskQuote | null, input: EvaluateRiskQuoteInput, phase: "preliminary" | "final") {
  if (!record || record.taskId !== input.taskId) return blockedDecision(input.quoteId, "RISK_QUOTE_NOT_FOUND");
  if (record.status !== "active") return manualDecision(input.quoteId, "RISK_QUOTE_SUPERSEDED", "risk_quote_superseded");
  if (record.quote.phase !== phase) return blockedDecision(input.quoteId, "RISK_QUOTE_PHASE_INVALID");
  if (record.quote.taskFingerprint !== input.taskFingerprint) {
    return manualDecision(input.quoteId, "RISK_QUOTE_FINGERPRINT_MISMATCH", "risk_quote_fingerprint_mismatch");
  }
  if (new Date(input.evaluatedAt).getTime() >= new Date(record.quote.expiresAt).getTime()) {
    return manualDecision(input.quoteId, "RISK_QUOTE_EXPIRED", "risk_quote_expired");
  }
  return null;
}

abstract class RiskQuoteStoreBase implements RiskQuoteStore {
  abstract issue(input: IssueRiskQuoteInput): Promise<StoredRiskQuote>;
  abstract find(quoteId: string): Promise<StoredRiskQuote | null>;
  abstract confirm(input: ConfirmRiskQuoteInput): Promise<void>;
  abstract approveManual(input: ApproveRiskQuoteInput): Promise<void>;
  protected abstract confirmations(quoteId: string): Promise<RiskQuoteConfirmation[]>;

  async evaluatePreliminary(input: EvaluateRiskQuoteInput): Promise<RiskQuoteGateDecision> {
    const record = await this.find(input.quoteId);
    const rejected = evaluateBase(record, input, "preliminary");
    if (rejected) return rejected;
    if (record!.quote.manualReviewRequired && (!record!.manualApprovedAt || !record!.manualApprovedBy)) {
      return blockedDecision(input.quoteId, "RISK_QUOTE_MANUAL_APPROVAL_REQUIRED");
    }
    const confirmed = await this.confirmations(input.quoteId);
    if (!confirmed.some(({ actorType }) => actorType === "publisher")) {
      return blockedDecision(input.quoteId, "RISK_QUOTE_PUBLISHER_CONFIRMATION_REQUIRED");
    }
    return { status: "ready", code: "RISK_QUOTE_READY", quoteId: input.quoteId };
  }

  async evaluateFunding(input: EvaluateRiskQuoteInput): Promise<RiskQuoteGateDecision> {
    const record = await this.find(input.quoteId);
    const rejected = evaluateBase(record, input, "final");
    if (rejected) return rejected;
    const quote = record!;
    const confirmed = await this.confirmations(input.quoteId);
    if (!confirmed.some(({ actorType }) => actorType === "publisher")) {
      return blockedDecision(input.quoteId, "RISK_QUOTE_PUBLISHER_CONFIRMATION_REQUIRED");
    }
    const confirmedAgents = new Set(confirmed.filter(({ actorType }) => actorType === "agent").map(({ agentId }) => agentId));
    if (quote.assignments.some(({ agentId }) => !confirmedAgents.has(agentId))) {
      return blockedDecision(input.quoteId, "RISK_QUOTE_AGENT_CONFIRMATIONS_REQUIRED");
    }
    if (quote.quote.manualReviewRequired && (!quote.manualApprovedAt || !quote.manualApprovedBy)) {
      return blockedDecision(input.quoteId, "RISK_QUOTE_MANUAL_APPROVAL_REQUIRED");
    }
    return { status: "ready", code: "RISK_QUOTE_READY", quoteId: input.quoteId };
  }
}

export class MemoryRiskQuoteStore extends RiskQuoteStoreBase {
  private readonly records = new Map<string, StoredRiskQuote>();
  private readonly confirmationRecords = new Map<string, RiskQuoteConfirmation>();

  async issue(input: IssueRiskQuoteInput): Promise<StoredRiskQuote> {
    const validated = validateIssue(input);
    const basis = basisFingerprint({
      taskId: input.taskId,
      publisherWallet: validated.publisherWallet,
      dagRevision: input.dagRevision,
      assignments: validated.assignments,
      quote: validated.quote,
    });
    const taskRecords = [...this.records.values()].filter(({ taskId }) => taskId === input.taskId);
    const active = taskRecords.find(({ status }) => status === "active");
    if (active?.basisFingerprint === basis) return structuredClone(active);
    const id = randomUUID();
    const version = Math.max(0, ...taskRecords.map((record) => record.version)) + 1;
    if (active) {
      active.status = "superseded";
      active.supersededBy = id;
      active.supersededAt = validated.createdAt;
    }
    const record: StoredRiskQuote = {
      id,
      taskId: input.taskId,
      publisherWallet: validated.publisherWallet,
      version,
      dagRevision: input.dagRevision,
      assignments: validated.assignments,
      quote: validated.quote,
      basisFingerprint: basis,
      status: "active",
      supersededBy: null,
      supersededAt: null,
      manualApprovedAt: null,
      manualApprovedBy: null,
      createdAt: validated.createdAt,
    };
    this.records.set(id, record);
    return structuredClone(record);
  }

  async find(quoteId: string): Promise<StoredRiskQuote | null> {
    const record = this.records.get(quoteId);
    return record ? structuredClone(record) : null;
  }

  async confirm(input: ConfirmRiskQuoteInput): Promise<void> {
    const record = this.records.get(input.quoteId);
    if (!record) throw new Error("RISK_QUOTE_NOT_FOUND");
    const confirmation = validateConfirmation(record, input);
    const key = `${confirmation.quoteId}:${confirmation.actorType}:${confirmation.actorKey}`;
    if (this.confirmationRecords.has(key)) throw new Error("RISK_QUOTE_CONFIRMATION_DUPLICATE");
    this.confirmationRecords.set(key, confirmation);
  }

  async approveManual(input: ApproveRiskQuoteInput): Promise<void> {
    if (input.approverRole !== "platform_operator") throw new Error("RISK_QUOTE_MANUAL_APPROVER_FORBIDDEN");
    const record = this.records.get(input.quoteId);
    if (!record) throw new Error("RISK_QUOTE_NOT_FOUND");
    if (record.status !== "active") throw new Error("RISK_QUOTE_SUPERSEDED");
    if (!record.quote.manualReviewRequired) throw new Error("RISK_QUOTE_MANUAL_APPROVAL_NOT_REQUIRED");
    record.manualApprovedAt = iso(input.approvedAt);
    record.manualApprovedBy = input.approvedBy.trim();
    if (!record.manualApprovedBy) throw new Error("RISK_QUOTE_MANUAL_APPROVER_REQUIRED");
  }

  protected async confirmations(quoteId: string): Promise<RiskQuoteConfirmation[]> {
    return [...this.confirmationRecords.values()]
      .filter((confirmation) => confirmation.quoteId === quoteId)
      .map((confirmation) => structuredClone(confirmation));
  }
}

type DatabaseRow = Record<string, unknown>;

export class PostgresRiskQuoteStore extends RiskQuoteStoreBase {
  constructor(private readonly sql: Sql) { super(); }

  private async load(db: Sql | TransactionSql, quoteId: string): Promise<StoredRiskQuote | null> {
    const rows = await db<DatabaseRow[]>`
      SELECT quote.*, task.publisher_wallet
      FROM agent_market.risk_quotes quote
      JOIN agent_market.tasks task ON task.id = quote.task_id
      WHERE quote.id = ${quoteId}
    `;
    const row = rows[0];
    if (!row) return null;
    const allocations = await db<DatabaseRow[]>`
      SELECT agent_id, agent_wallet
      FROM agent_market.risk_quote_agent_allocations
      WHERE quote_id = ${quoteId}
      ORDER BY agent_id
    `;
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      publisherWallet: normalizeWallet(String(row.publisher_wallet)),
      version: Number(row.quote_version),
      dagRevision: Number(row.dag_revision),
      assignments: allocations.map((allocation) => ({ agentId: String(allocation.agent_id), agentWallet: normalizeWallet(String(allocation.agent_wallet)) })),
      quote: RiskQuoteSchema.parse(row.quote_payload),
      basisFingerprint: String(row.basis_fingerprint),
      status: row.status as StoredRiskQuote["status"],
      supersededBy: row.superseded_by ? String(row.superseded_by) : null,
      supersededAt: row.superseded_at ? iso(row.superseded_at as string | Date) : null,
      manualApprovedAt: row.manual_approved_at ? iso(row.manual_approved_at as string | Date) : null,
      manualApprovedBy: row.manual_approved_by ? String(row.manual_approved_by) : null,
      createdAt: iso(row.created_at as string | Date),
    };
  }

  async issue(input: IssueRiskQuoteInput): Promise<StoredRiskQuote> {
    const validated = validateIssue(input);
    const basis = basisFingerprint({ taskId: input.taskId, publisherWallet: validated.publisherWallet, dagRevision: input.dagRevision, assignments: validated.assignments, quote: validated.quote });
    return this.sql.begin(async (transaction) => {
      const taskRows = await transaction<DatabaseRow[]>`
        SELECT publisher_wallet
        FROM agent_market.tasks
        WHERE id = ${input.taskId}
        FOR UPDATE
      `;
      if (!taskRows[0]) throw new Error("RISK_QUOTE_TASK_NOT_FOUND");
      if (normalizeWallet(String(taskRows[0].publisher_wallet)) !== validated.publisherWallet) {
        throw new Error("RISK_QUOTE_PUBLISHER_FORBIDDEN");
      }
      const activeRows = await transaction<DatabaseRow[]>`
        SELECT id, quote_version, basis_fingerprint
        FROM agent_market.risk_quotes
        WHERE task_id = ${input.taskId} AND status = 'active'
        FOR UPDATE
      `;
      const active = activeRows[0];
      if (active?.basis_fingerprint === basis) return (await this.load(transaction, String(active.id)))!;
      const versionRows = await transaction<DatabaseRow[]>`
        SELECT COALESCE(MAX(quote_version), 0) + 1 AS next_version
        FROM agent_market.risk_quotes
        WHERE task_id = ${input.taskId}
      `;
      const id = randomUUID();
      const version = Number(versionRows[0]?.next_version ?? 1);
      if (active) {
        await transaction`SET CONSTRAINTS agent_market.fk_risk_quotes_superseded_by DEFERRED`;
        await transaction`
          UPDATE agent_market.risk_quotes
          SET status = 'superseded', superseded_by = ${id}, superseded_at = ${validated.createdAt}::timestamptz
          WHERE id = ${String(active.id)}
        `;
      }
      await transaction`
        INSERT INTO agent_market.risk_quotes (
          id, task_id, quote_version, phase, task_fingerprint, dag_revision,
          policy_version, basis_fingerprint, quote_payload, manual_review_required,
          expires_at, status, created_at
        ) VALUES (
          ${id}, ${input.taskId}, ${version}, ${validated.quote.phase}, ${validated.quote.taskFingerprint},
          ${input.dagRevision}, ${validated.quote.policyVersion}, ${basis}, ${transaction.json(validated.quote)},
          ${validated.quote.manualReviewRequired}, ${validated.quote.expiresAt}::timestamptz, 'active',
          ${validated.createdAt}::timestamptz
        )
      `;
      for (const assignment of validated.assignments) {
        const allocation = validated.quote.agentAllocations.find(({ agentId }) => agentId === assignment.agentId)!;
        await transaction`
          INSERT INTO agent_market.risk_quote_agent_allocations (quote_id, agent_id, agent_wallet, amount_atomic)
          VALUES (${id}, ${assignment.agentId}, ${assignment.agentWallet}, ${allocation.amountAtomic}::numeric)
        `;
      }
      return (await this.load(transaction, id))!;
    });
  }

  async find(quoteId: string): Promise<StoredRiskQuote | null> {
    try {
      return await this.load(this.sql, quoteId);
    } catch {
      throw new Error("RISK_QUOTE_STATE_UNKNOWN");
    }
  }

  async confirm(input: ConfirmRiskQuoteInput): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const record = await this.load(transaction, input.quoteId);
      if (!record) throw new Error("RISK_QUOTE_NOT_FOUND");
      const confirmation = validateConfirmation(record, input);
      const inserted = await transaction<DatabaseRow[]>`
        INSERT INTO agent_market.risk_quote_confirmations (
          quote_id, actor_type, actor_key, actor_wallet, agent_id, task_fingerprint, confirmed_at
        ) VALUES (
          ${confirmation.quoteId}, ${confirmation.actorType}, ${confirmation.actorKey},
          ${confirmation.actorWallet}, ${confirmation.agentId}, ${confirmation.taskFingerprint},
          ${confirmation.confirmedAt}::timestamptz
        ) ON CONFLICT DO NOTHING RETURNING quote_id
      `;
      if (!inserted[0]) throw new Error("RISK_QUOTE_CONFIRMATION_DUPLICATE");
    });
  }

  async approveManual(input: ApproveRiskQuoteInput): Promise<void> {
    if (input.approverRole !== "platform_operator") throw new Error("RISK_QUOTE_MANUAL_APPROVER_FORBIDDEN");
    const approvedBy = input.approvedBy.trim();
    if (!approvedBy) throw new Error("RISK_QUOTE_MANUAL_APPROVER_REQUIRED");
    const updated = await this.sql<DatabaseRow[]>`
      UPDATE agent_market.risk_quotes
      SET manual_approved_at = ${iso(input.approvedAt)}::timestamptz, manual_approved_by = ${approvedBy}
      WHERE id = ${input.quoteId} AND status = 'active' AND manual_review_required = true
      RETURNING id
    `;
    if (!updated[0]) throw new Error("RISK_QUOTE_MANUAL_APPROVAL_NOT_ALLOWED");
  }

  protected async confirmations(quoteId: string): Promise<RiskQuoteConfirmation[]> {
    const rows = await this.sql<DatabaseRow[]>`
      SELECT quote_id, actor_type, actor_key, actor_wallet, agent_id, task_fingerprint, confirmed_at
      FROM agent_market.risk_quote_confirmations
      WHERE quote_id = ${quoteId}
    `;
    return rows.map((row) => ({
      quoteId: String(row.quote_id),
      actorType: row.actor_type as RiskQuoteConfirmation["actorType"],
      actorKey: String(row.actor_key),
      actorWallet: normalizeWallet(String(row.actor_wallet)),
      agentId: row.agent_id ? String(row.agent_id) : null,
      taskFingerprint: String(row.task_fingerprint),
      confirmedAt: iso(row.confirmed_at as string | Date),
    }));
  }
}
