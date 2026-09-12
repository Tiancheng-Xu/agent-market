import {
  ReputationSnapshotSchema,
  RiskQuoteSchema,
  TaskFingerprintSchema,
  type ReputationSnapshot,
  type RiskQuote,
} from "@agent-market/shared-contracts";
import { assertWalletSessionAuthenticated, walletSessionRevision } from "./walletSession";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface BrowserRiskQuote {
  quoteId: string;
  quoteHash: string;
  quote: RiskQuote;
  version: number;
  requestId: string;
}

export interface BrowserRiskQuoteConfirmation {
  quoteId: string;
  actorType: "publisher" | "agent";
  agentId: string | null;
}

export interface BrowserRiskContext {
  activeQuote: { quoteId: string; version: number; quoteHash: string } | null;
  taskId: string;
  assetId: string;
  quoteSchemaVersion: 2;
  taskFingerprint: string;
  phase: "preliminary" | "final";
  dagRevision: number;
  quoteStatus: "not_issued" | "active" | "confirmed" | "expired" | "superseded" | "manual_review" | "requote_required";
  requestId: string;
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RISK_API_RESPONSE_INVALID");
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("RISK_API_RESPONSE_INVALID");
  }
  return record;
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json();
  if (!response.ok) {
    const error = value && typeof value === "object" && typeof (value as Record<string, unknown>).error === "string"
      ? String((value as Record<string, unknown>).error)
      : "RISK_API_UNAVAILABLE";
    throw new Error(error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RISK_API_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

function requestId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("RISK_API_RESPONSE_INVALID");
  return value;
}

async function authenticatedPayload(url: string, init: RequestInit) {
  assertWalletSessionAuthenticated();
  const revision = walletSessionRevision();
  const checkSession = () => {
    assertWalletSessionAuthenticated();
    if (walletSessionRevision() !== revision) throw new Error("AUTH_WALLET_CHANGED");
  };
  const response = await fetch(url, init);
  checkSession();
  const value = await payload(response);
  checkSession();
  return value;
}

export async function readRiskContext(taskId: string): Promise<BrowserRiskContext> {
  if (!UUID.test(taskId)) throw new Error("RISK_TASK_ID_INVALID");
  return parseRiskContext(await authenticatedPayload(`/api/tasks/${encodeURIComponent(taskId)}/risk-context`, {
    credentials: "include",
    headers: { accept: "application/json" },
  }), taskId);
}

function parseQuoteIdentity(value: unknown) {
  const parsed = exactObject(value, ["quoteId", "version", "quoteHash"]);
  const hash = TaskFingerprintSchema.safeParse(parsed.quoteHash);
  if (typeof parsed.quoteId !== "string" || !UUID.test(parsed.quoteId)
    || !Number.isSafeInteger(parsed.version) || Number(parsed.version) < 1 || !hash.success) {
    throw new Error("RISK_API_RESPONSE_INVALID");
  }
  return { quoteId: parsed.quoteId, version: Number(parsed.version), quoteHash: hash.data };
}

function parseRiskContext(value: unknown, taskId: string): BrowserRiskContext {
  const parsed = exactObject(value, ["activeQuote", "taskId", "assetId", "quoteSchemaVersion", "taskFingerprint", "phase", "dagRevision", "quoteStatus", "requestId"]);
  const quoteStatuses = ["not_issued", "active", "confirmed", "expired", "superseded", "manual_review", "requote_required"];
  if (parsed.taskId !== taskId
    || parsed.quoteSchemaVersion !== 2
    || typeof parsed.assetId !== "string"
    || !/^eip155:[1-9][0-9]{0,15}\/erc20:0x[0-9a-f]{40}$/u.test(parsed.assetId)
    || parsed.assetId.endsWith(`0x${"0".repeat(40)}`)
    || !["preliminary", "final"].includes(String(parsed.phase))
    || !Number.isInteger(parsed.dagRevision) || Number(parsed.dagRevision) < 0
    || !quoteStatuses.includes(String(parsed.quoteStatus))) {
    throw new Error("RISK_API_RESPONSE_INVALID");
  }
  const taskFingerprint = TaskFingerprintSchema.safeParse(parsed.taskFingerprint);
  if (!taskFingerprint.success) throw new Error("RISK_API_RESPONSE_INVALID");
  return {
    activeQuote: parsed.activeQuote === null ? null : parseQuoteIdentity(parsed.activeQuote),
    taskId,
    assetId: parsed.assetId,
    quoteSchemaVersion: 2,
    taskFingerprint: taskFingerprint.data,
    phase: parsed.phase as BrowserRiskContext["phase"],
    dagRevision: Number(parsed.dagRevision),
    quoteStatus: parsed.quoteStatus as BrowserRiskContext["quoteStatus"],
    requestId: requestId(parsed.requestId),
  };
}

export async function readCurrentRiskQuote(taskId: string): Promise<{ context: BrowserRiskContext; record: BrowserRiskQuote | null }> {
  if (!UUID.test(taskId)) throw new Error("RISK_TASK_ID_INVALID");
  const response = exactObject(await authenticatedPayload(`/api/tasks/${encodeURIComponent(taskId)}/risk-quote`, {
    method: "GET", credentials: "include", headers: { accept: "application/json" },
  }), ["context", "quote", "requestId"]);
  const rawContext = exactObject(response.context, ["activeQuote", "taskId", "assetId", "quoteSchemaVersion", "taskFingerprint", "phase", "dagRevision", "quoteStatus"]);
  const context = parseRiskContext({ ...rawContext, requestId: response.requestId }, taskId);
  if (response.quote === null) {
    if (context.activeQuote !== null) throw new Error("RISK_API_RESPONSE_INVALID");
    return { context, record: null };
  }
  const rawQuote = exactObject(response.quote, ["quoteId", "quoteHash", "version", "quote"]);
  const identity = parseQuoteIdentity({ quoteId: rawQuote.quoteId, quoteHash: rawQuote.quoteHash, version: rawQuote.version });
  if (!context.activeQuote || context.activeQuote.quoteId !== identity.quoteId
    || context.activeQuote.version !== identity.version || context.activeQuote.quoteHash !== identity.quoteHash) {
    throw new Error("RISK_API_RESPONSE_INVALID");
  }
  return { context, record: { ...identity, quote: RiskQuoteSchema.parse(rawQuote.quote), requestId: context.requestId } };
}

export async function requestRiskQuote(taskId: string, taskFingerprint: string): Promise<BrowserRiskQuote> {
  if (!UUID.test(taskId)) throw new Error("RISK_TASK_ID_INVALID");
  const fingerprint = TaskFingerprintSchema.parse(taskFingerprint);
  const parsed = exactObject(await authenticatedPayload(`/api/tasks/${encodeURIComponent(taskId)}/risk-quote`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ taskFingerprint: fingerprint }),
  }), ["quoteId", "quoteHash", "quote", "version", "requestId"]);
  if (typeof parsed.quoteId !== "string" || !UUID.test(parsed.quoteId)
    || !Number.isInteger(parsed.version) || Number(parsed.version) < 1) {
    throw new Error("RISK_API_RESPONSE_INVALID");
  }
  const quote = RiskQuoteSchema.parse(parsed.quote);
  const quoteHash = TaskFingerprintSchema.safeParse(parsed.quoteHash);
  if (!quoteHash.success) throw new Error("RISK_API_RESPONSE_INVALID");
  if (quote.schemaVersion !== 2 || !quote.assetId) throw new Error("RISK_QUOTE_REQUOTE_REQUIRED");
  if (quote.taskFingerprint !== fingerprint) throw new Error("RISK_API_RESPONSE_INVALID");
  return {
    quoteId: parsed.quoteId,
    quoteHash: quoteHash.data,
    quote,
    version: Number(parsed.version),
    requestId: requestId(parsed.requestId),
  };
}

export async function confirmRiskQuote(
  taskId: string,
  quoteId: string,
  taskFingerprint: string,
  quoteHash: string,
): Promise<BrowserRiskQuoteConfirmation> {
  if (!UUID.test(taskId)) throw new Error("RISK_TASK_ID_INVALID");
  const fingerprint = TaskFingerprintSchema.parse(taskFingerprint);
  if (!UUID.test(quoteId)) throw new Error("RISK_QUOTE_ID_INVALID");
  const hash = TaskFingerprintSchema.safeParse(quoteHash);
  if (!hash.success) throw new Error("RISK_QUOTE_HASH_INVALID");
  const parsed = exactObject(await authenticatedPayload(`/api/tasks/${encodeURIComponent(taskId)}/risk-quote/confirm`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ quoteId, taskFingerprint: fingerprint, quoteHash: hash.data }),
  }), ["confirmation", "requestId"]);
  requestId(parsed.requestId);
  const confirmation = exactObject(parsed.confirmation, ["quoteId", "actorType", "agentId"]);
  if (confirmation.quoteId !== quoteId || !["publisher", "agent"].includes(String(confirmation.actorType))
    || !(confirmation.agentId === null || typeof confirmation.agentId === "string")) {
    throw new Error("RISK_API_RESPONSE_INVALID");
  }
  return confirmation as unknown as BrowserRiskQuoteConfirmation;
}

export async function readAgentReputation(agentId: string): Promise<ReputationSnapshot> {
  if (!UUID.test(agentId)) throw new Error("REPUTATION_AGENT_ID_INVALID");
  const parsed = exactObject(await payload(await fetch(`/api/agents/${encodeURIComponent(agentId)}/reputation`, {
    credentials: "omit",
    headers: { accept: "application/json" },
  })), ["reputation", "requestId"]);
  requestId(parsed.requestId);
  const reputation = ReputationSnapshotSchema.parse(parsed.reputation);
  if (reputation.agentId !== agentId) throw new Error("RISK_API_RESPONSE_INVALID");
  return reputation;
}
