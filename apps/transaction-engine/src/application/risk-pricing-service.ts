import { createHash } from "node:crypto";

import {
  RiskAssessmentInputSchema,
  TaskFingerprintSchema,
  type AgentDepositNode,
  type RiskAssessmentInput,
  type RiskAssessorResult,
  type RiskQuotePhase,
} from "@agent-market/shared-contracts";

import { assessRisk, createRiskQuote } from "./risk-engine";
import type { RiskQuoteStore, StoredRiskQuote } from "./risk-quote-store";

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
  | "manual_review";

export interface RiskContextSnapshot {
  taskId: string;
  taskFingerprint: string;
  phase: RiskQuotePhase;
  dagRevision: number;
  quoteStatus: RiskContextQuoteStatus;
}

export interface RiskTaskSource {
  loadAuthoritativeTask(taskId: string): Promise<AuthoritativeRiskTask | null>;
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
}

export interface IssueQuoteRequest {
  taskId: string;
  expectedTaskFingerprint: string;
  actorWallet: string;
}

export interface ConfirmQuoteRequest {
  taskId: string;
  quoteId: string;
  taskFingerprint: string;
  actorWallet: string;
}

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

export function fingerprintRiskTask(task: AuthoritativeRiskTask): string {
  const digest = createHash("sha256").update(JSON.stringify(normalizedTask(task))).digest("hex");
  return `sha256:${digest}`;
}

function mapStoreError(error: unknown): never {
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

  async readRiskContext(input: ReadRiskContextRequest): Promise<RiskContextSnapshot> {
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
      "not_issued", "active", "confirmed", "expired", "superseded", "manual_review",
    ];
    if (!quoteStatuses.includes(task.quoteStatus)) {
      throw new RiskPricingServiceError("RISK_CONTEXT_UNAVAILABLE", 503);
    }
    return {
      taskId: canonical.id,
      taskFingerprint: fingerprintRiskTask(task),
      phase: canonical.phase,
      dagRevision: canonical.dagRevision,
      quoteStatus: task.quoteStatus,
    };
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
    if (!WALLET.test(actorWallet) || !canonical.authorizedQuoteWallets.includes(actorWallet)) {
      throw new RiskPricingServiceError("RISK_QUOTE_REQUEST_FORBIDDEN", 403);
    }
    const taskFingerprint = fingerprintRiskTask(task);
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
      return await this.dependencies.quotes.issue({
        taskId: canonical.id,
        publisherWallet: canonical.publisherWallet,
        dagRevision: canonical.dagRevision,
        assignments: canonical.assignments.map(({ agentId, agentWallet }) => ({ agentId, agentWallet })),
        quote,
        createdAt: this.now().toISOString(),
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
    const parsedFingerprint = TaskFingerprintSchema.safeParse(input.taskFingerprint);
    if (!parsedFingerprint.success) throw new RiskPricingServiceError("RISK_TASK_FINGERPRINT_INVALID", 400);
    const record = await this.dependencies.quotes.find(input.quoteId);
    if (!record || record.taskId !== input.taskId) throw new RiskPricingServiceError("RISK_QUOTE_NOT_FOUND", 404);
    const actorWallet = normalizeWallet(input.actorWallet);
    let actorType: "publisher" | "agent";
    let agentId: string | undefined;
    if (actorWallet === record.publisherWallet) {
      actorType = "publisher";
    } else {
      const assignment = record.assignments.find(({ agentWallet }) => normalizeWallet(agentWallet) === actorWallet);
      if (!assignment) throw new RiskPricingServiceError("RISK_QUOTE_CONFIRM_FORBIDDEN", 403);
      actorType = "agent";
      agentId = assignment.agentId;
    }
    try {
      await this.dependencies.quotes.confirm({
        quoteId: record.id,
        actorType,
        actorWallet,
        ...(agentId === undefined ? {} : { agentId }),
        taskFingerprint: parsedFingerprint.data,
        confirmedAt: this.now().toISOString(),
      });
    } catch (error) {
      return mapStoreError(error);
    }
    return { quoteId: record.id, actorType, agentId: agentId ?? null };
  }
}
