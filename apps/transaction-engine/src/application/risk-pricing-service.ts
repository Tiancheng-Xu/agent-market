import { createHash } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";

import {
  RiskAssessmentInputSchema,
  RiskAssetIdSchema,
  TaskFingerprintSchema,
  type AgentDepositNode,
  type RiskAssessmentInput,
  type RiskAssessorResult,
  type RiskQuotePhase,
} from "@agent-market/shared-contracts";

import { assessRisk, createRiskQuote } from "./risk-engine";
import type { RiskQuoteStore, StoredRiskQuote } from "./risk-quote-store";

import { configuredRiskAsset } from './risk-asset';

const WALLET = /^0x[0-9a-f]{40}$/u;

export interface RiskTaskAssignment extends AgentDepositNode {
  agentWallet: string;
}

export interface AuthoritativeRiskTask {
  id: string;
  title: string;
  description: string;
  requirements: readonly string[];
  declaredPermissions: readonly string[];
  durationHours: number;
  dependencyClasses: readonly string[];
  budgetAtomic: string;
  publisherWallet: string;
  authorizedQuoteWallets: readonly string[];
  quoteStatus: RiskContextQuoteStatus;
  currentQuote?: RiskQuoteReadback | null;
  dag: null | {
    revision: number;
    finalized: boolean;
    assignments: readonly RiskTaskAssignment[];
  };
}

export type RiskContextQuoteStatus =
  | "not_issued"
  | "active"
  | "confirmed"
  | "expired"
  | "superseded"
  | "manual_review"
  | "requote_required";

export interface RiskQuoteReadback {
  quoteId: string;
  version: number;
  quoteHash: string;
  quote: StoredRiskQuote['quote'];
}

export interface RiskContextSnapshot {
  activeQuote: Omit<RiskQuoteReadback, 'quote'> | null;
  assetId?: string;
  quoteSchemaVersion?: 2;
  taskId: string;
  taskFingerprint: string;
  phase: RiskQuotePhase;
  dagRevision: number;
  quoteStatus: RiskContextQuoteStatus;
}

export interface RiskTaskSource {
  loadAuthoritativeTask(taskId: string, db?: Sql | TransactionSql): Promise<AuthoritativeRiskTask | null>;
}

export interface RiskAssessorClient {
  assess(input: RiskAssessmentInput): Promise<RiskAssessorResult>;
}

export class RiskPricingServiceError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 503) {
    super(code);
  }
}

export interface RiskPricingServiceDependencies {
  quotes: RiskQuoteStore;
  tasks?: RiskTaskSource;
  assessor?: RiskAssessorClient;
  now?: () => Date;
  policyVersion?: string;
  serviceFeeBps?: number;
  quoteTtlMs?: number;
  assetId?: () => string;
}

export interface IssueQuoteRequest {
  taskId: string;
  expectedTaskFingerprint: string;
  actorWallet: string;
}

interface ConfirmQuoteRequestBase {
  quoteHash?: string;
  taskId: string;
  quoteId: string;
  taskFingerprint: string;
  actorWallet: string;
}

export type ConfirmQuoteRequest = ConfirmQuoteRequestBase & (
  | { actorType: "publisher"; agentId?: never }
  | { actorType: "agent"; agentId: string }
);

export interface ReadRiskContextRequest {
  taskId: string;
  actorWallet: string;
}

const normalizeText = (value: string): string => value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
const normalizeWallet = (value: string): string => value.trim().toLowerCase();
const sortedStrings = (values: readonly string[]): string[] => values.map(normalizeText).sort();

function normalizedTask(task: AuthoritativeRiskTask) {
  const assignments = [...(task.dag?.assignments ?? [])].map((assignment) => ({
    agentId: normalizeText(assignment.agentId),
    agentWallet: normalizeWallet(assignment.agentWallet),
    shareBps: assignment.shareBps,
    nodeRiskMultiplierBps: assignment.nodeRiskMultiplierBps,
    reputationRiskMultiplierBps: assignment.reputationRiskMultiplierBps,
  })).sort((left, right) =>
    left.agentId.localeCompare(right.agentId)
    || left.agentWallet.localeCompare(right.agentWallet)
    || left.shareBps - right.shareBps
    || left.nodeRiskMultiplierBps - right.nodeRiskMultiplierBps
    || left.reputationRiskMultiplierBps - right.reputationRiskMultiplierBps,
  );
  const final = task.dag?.finalized === true && assignments.length > 0;
  return {
    id: task.id,
    title: normalizeText(task.title),
    description: normalizeText(task.description),
    requirements: sortedStrings(task.requirements),
    declaredPermissions: sortedStrings(task.declaredPermissions),
    durationHours: task.durationHours,
    dependencyClasses: sortedStrings(task.dependencyClasses),
    budgetAtomic: task.budgetAtomic,
    publisherWallet: normalizeWallet(task.publisherWallet),
    authorizedQuoteWallets: [...task.authorizedQuoteWallets].map(normalizeWallet).sort(),
    phase: (final ? "final" : "preliminary") as RiskQuotePhase,
    dagRevision: task.dag?.revision ?? 0,
    assignments: final ? assignments : [],
  };
}

export function fingerprintRiskTask(task: AuthoritativeRiskTask, assetId?: string): string {
  const normalized = normalizedTask(task);
  const digest = createHash("sha256").update(JSON.stringify(assetId === undefined ? normalized : { ...normalized, quoteSchemaVersion: 2, assetId: RiskAssetIdSchema.parse(assetId) })).digest("hex");
  return `sha256:${digest}`;
}

function mapStoreError(error: unknown): never {
  if (error instanceof RiskPricingServiceError) throw error;
  const code = error instanceof Error ? error.message : "RISK_QUOTE_UNAVAILABLE";
  if (code === "RISK_QUOTE_NOT_FOUND") throw new RiskPricingServiceError(code, 404);
  if (code.endsWith("FORBIDDEN")) throw new RiskPricingServiceError(code, 403);
  if (["RISK_QUOTE_FINGERPRINT_MISMATCH", "RISK_QUOTE_SUPERSEDED", "RISK_QUOTE_EXPIRED", "RISK_QUOTE_CONFIRMATION_DUPLICATE"].includes(code)) {
    throw new RiskPricingServiceError(code, 409);
  }
  if (code.startsWith("RISK_QUOTE_") || code.startsWith("RISK_")) {
    throw new RiskPricingServiceError(code, 400);
  }
  throw new RiskPricingServiceError("RISK_QUOTE_UNAVAILABLE", 503);
}

export class RiskPricingService {
  private readonly now: () => Date;
  private readonly policyVersion: string;
  private readonly serviceFeeBps: number;
  private readonly quoteTtlMs: number;

  constructor(private readonly dependencies: RiskPricingServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.policyVersion = dependencies.policyVersion ?? "risk-pricing-v2";
    this.serviceFeeBps = dependencies.serviceFeeBps ?? 600;
    this.quoteTtlMs = dependencies.quoteTtlMs ?? 15 * 60_000;
  }

  private asset(): string {
    try { return RiskAssetIdSchema.parse((this.dependencies.assetId ?? configuredRiskAsset)()); }
    catch (error) { throw new RiskPricingServiceError(error instanceof Error && error.message.startsWith('RISK_ASSET_CONFIG_') ? error.message : 'RISK_ASSET_CONFIG_INVALID', 503); }
  }

  async readRiskContext(input: ReadRiskContextRequest): Promise<RiskContextSnapshot> {
    return (await this.readCurrentQuote(input)).context;
  }

  async readCurrentQuote(input: ReadRiskContextRequest): Promise<{ context: RiskContextSnapshot; quote: RiskQuoteReadback | null }> {
    const { tasks } = this.dependencies;
    if (!tasks) throw new RiskPricingServiceError("RISK_CONTEXT_UNAVAILABLE", 503);
    const task = await tasks.loadAuthoritativeTask(input.taskId);
    if (!task) throw new RiskPricingServiceError("RISK_TASK_NOT_FOUND", 404);
    if (task.id !== input.taskId) throw new RiskPricingServiceError("RISK_TASK_ID_CONFLICT", 409);
    const canonical = normalizedTask(task);
    const actorWallet = normalizeWallet(input.actorWallet);
    const finalAgentWallets = canonical.phase === "final"
      ? canonical.assignments.map(({ agentWallet }) => agentWallet)
      : [];
    const canRead = WALLET.test(actorWallet)
      && (actorWallet === canonical.publisherWallet || finalAgentWallets.includes(actorWallet));
    if (!canRead) throw new RiskPricingServiceError("RISK_CONTEXT_READ_FORBIDDEN", 403);
    const quoteStatuses: readonly RiskContextQuoteStatus[] = [
      "not_issued", "active", "confirmed", "expired", "superseded", "manual_review", "requote_required",
    ];
    if (!quoteStatuses.includes(task.quoteStatus)) {
      throw new RiskPricingServiceError("RISK_CONTEXT_UNAVAILABLE", 503);
    }
    const assetId = this.asset();
    const current = task.currentQuote ?? null;
    const fingerprint = fingerprintRiskTask(task, assetId);
    let quoteStatus: RiskContextQuoteStatus = current ? task.quoteStatus : 'not_issued';
    if (current) {
      if (current.quote.schemaVersion !== 2) quoteStatus = 'requote_required';
      else if (current.quote.assetId !== assetId || current.quote.taskFingerprint !== fingerprint
        || current.quote.phase !== canonical.phase) quoteStatus = 'superseded';
      else if (Date.parse(current.quote.expiresAt) <= this.now().getTime()) quoteStatus = 'expired';
    }
    return { quote: current, context: {
      activeQuote: current ? { quoteId: current.quoteId, version: current.version, quoteHash: current.quoteHash } : null,
      assetId, quoteSchemaVersion: 2,
      taskId: canonical.id,
      taskFingerprint: fingerprintRiskTask(task, assetId),
      phase: canonical.phase,
      dagRevision: canonical.dagRevision,
      quoteStatus,
    } };
  }

  async issueQuote(input: IssueQuoteRequest): Promise<StoredRiskQuote> {
    const { tasks, assessor } = this.dependencies;
    if (!tasks || !assessor) throw new RiskPricingServiceError("RISK_QUOTE_CREATION_UNAVAILABLE", 503);
    const expected = TaskFingerprintSchema.safeParse(input.expectedTaskFingerprint);
    if (!expected.success) throw new RiskPricingServiceError("RISK_TASK_FINGERPRINT_INVALID", 400);
    const task = await tasks.loadAuthoritativeTask(input.taskId);
    if (!task) throw new RiskPricingServiceError("RISK_TASK_NOT_FOUND", 404);
    if (task.id !== input.taskId) throw new RiskPricingServiceError("RISK_TASK_ID_CONFLICT", 409);
    const canonical = normalizedTask(task);
    const actorWallet = normalizeWallet(input.actorWallet);
    if (!WALLET.test(actorWallet) || actorWallet !== canonical.publisherWallet) {
      throw new RiskPricingServiceError("RISK_QUOTE_REQUEST_FORBIDDEN", 403);
    }
    const assetId = this.asset();
    const taskFingerprint = fingerprintRiskTask(task, assetId);
    if (taskFingerprint !== expected.data) {
      throw new RiskPricingServiceError("RISK_TASK_FINGERPRINT_CONFLICT", 409);
    }
    const assessmentInput = RiskAssessmentInputSchema.parse({
      taskId: canonical.id,
      title: canonical.title,
      description: canonical.description,
      requirements: canonical.requirements,
      declaredPermissions: canonical.declaredPermissions,
      durationHours: canonical.durationHours,
      dependencyClasses: canonical.dependencyClasses,
    });
    const result = await assessor.assess(assessmentInput);
    const quote = createRiskQuote({
      assetId,
      phase: canonical.phase,
      policyVersion: this.policyVersion,
      taskFingerprint,
      budgetAtomic: canonical.budgetAtomic,
      serviceFeeBps: this.serviceFeeBps,
      assessment: assessRisk(result),
      expiresAt: new Date(this.now().getTime() + this.quoteTtlMs).toISOString(),
      ...(canonical.phase === "final" ? {
        agentNodes: canonical.assignments.map(({
          agentId, shareBps, nodeRiskMultiplierBps, reputationRiskMultiplierBps,
        }) => ({ agentId, shareBps, nodeRiskMultiplierBps, reputationRiskMultiplierBps })),
      } : {}),
    });
    try {
      const assignments = new Map<string, { agentId: string; agentWallet: string }>();
      for (const { agentId, agentWallet } of canonical.assignments) {
        const previous = assignments.get(agentId);
        if (previous && previous.agentWallet !== agentWallet) throw new Error('RISK_QUOTE_ASSIGNMENT_WALLET_CONFLICT');
        assignments.set(agentId, { agentId, agentWallet });
      }
      return await this.dependencies.quotes.issue({
        taskId: canonical.id,
        publisherWallet: canonical.publisherWallet,
        dagRevision: canonical.dagRevision,
        assignments: [...assignments.values()],
        quote,
        createdAt: this.now().toISOString(),
        validateAuthority: async (db) => {
          const latest = await tasks.loadAuthoritativeTask(input.taskId, db);
          if (!latest || fingerprintRiskTask(latest, this.asset()) !== taskFingerprint) {
            throw new RiskPricingServiceError('RISK_TASK_FINGERPRINT_CONFLICT', 409);
          }
        },
      });
    } catch (error) {
      return mapStoreError(error);
    }
  }

  async confirmQuote(input: ConfirmQuoteRequest): Promise<{
    quoteId: string;
    actorType: "publisher" | "agent";
    agentId: string | null;
  }> {
    if (input.actorType !== "publisher" && input.actorType !== "agent") {
      throw new RiskPricingServiceError("RISK_QUOTE_CONFIRMATION_INVALID", 400);
    }
    const requestedAgentId = input.actorType === "agent" ? normalizeText(input.agentId) : undefined;
    if ((input.actorType === "publisher" && input.agentId !== undefined)
      || (input.actorType === "agent" && (requestedAgentId!.length === 0 || requestedAgentId!.length > 160))) {
      throw new RiskPricingServiceError("RISK_QUOTE_CONFIRMATION_INVALID", 400);
    }
    const parsedFingerprint = TaskFingerprintSchema.safeParse(input.taskFingerprint);
    if (!parsedFingerprint.success) throw new RiskPricingServiceError("RISK_TASK_FINGERPRINT_INVALID", 400);
    const record = await this.dependencies.quotes.find(input.quoteId);
    if (!record || record.taskId !== input.taskId) throw new RiskPricingServiceError("RISK_QUOTE_NOT_FOUND", 404);
    if (record.quote.schemaVersion !== 2 || !record.quote.assetId) throw new RiskPricingServiceError('RISK_QUOTE_REQUOTE_REQUIRED', 409);
    if (record.quote.assetId !== this.asset()) throw new RiskPricingServiceError('RISK_QUOTE_ASSET_MISMATCH', 409);
    if (!input.quoteHash || input.quoteHash !== record.basisFingerprint) throw new RiskPricingServiceError('RISK_QUOTE_HASH_MISMATCH', 409);
    const validateAuthority = async (db?: Sql | TransactionSql) => {
      const task = await this.dependencies.tasks?.loadAuthoritativeTask(input.taskId, db);
      if (!task) throw new RiskPricingServiceError('RISK_CONTEXT_UNAVAILABLE', 503);
      const actor = normalizeWallet(input.actorWallet);
      const authorized = input.actorType === "publisher"
        ? actor === normalizeWallet(task.publisherWallet)
        : task.dag?.finalized === true && task.dag.assignments.some((assignment) =>
          normalizeText(assignment.agentId) === requestedAgentId
          && normalizeWallet(assignment.agentWallet) === actor);
      if (!authorized) {
        throw new RiskPricingServiceError('RISK_QUOTE_CONFIRM_FORBIDDEN', 403);
      }
      if (fingerprintRiskTask(task, this.asset()) !== record.quote.taskFingerprint) {
        throw new RiskPricingServiceError('RISK_TASK_FINGERPRINT_CONFLICT', 409);
      }
      if (task.currentQuote !== undefined && task.currentQuote?.quoteId !== record.id) {
        throw new RiskPricingServiceError('RISK_QUOTE_SUPERSEDED', 409);
      }
    };
    const actorWallet = normalizeWallet(input.actorWallet);
    if (input.actorType === "publisher") {
      if (actorWallet !== record.publisherWallet) {
        throw new RiskPricingServiceError("RISK_QUOTE_CONFIRM_FORBIDDEN", 403);
      }
    } else {
      const assignment = record.assignments.find(({ agentId, agentWallet }) =>
        agentId === requestedAgentId && normalizeWallet(agentWallet) === actorWallet);
      if (!assignment) throw new RiskPricingServiceError("RISK_QUOTE_CONFIRM_FORBIDDEN", 403);
    }
    try {
      await this.dependencies.quotes.confirm({
        quoteId: record.id,
        quoteHash: input.quoteHash,
        actorType: input.actorType,
        actorWallet,
        ...(requestedAgentId === undefined ? {} : { agentId: requestedAgentId }),
        taskFingerprint: parsedFingerprint.data,
        confirmedAt: this.now().toISOString(),
        validateAuthority,
      });
    } catch (error) {
      return mapStoreError(error);
    }
    return { quoteId: record.id, actorType: input.actorType, agentId: requestedAgentId ?? null };
  }
}
