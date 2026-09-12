import { confirmRiskQuote, readCurrentRiskQuote, readRiskContext, requestRiskQuote, type BrowserRiskContext, type BrowserRiskQuote } from "./riskPricingClient";

function requireQuoteIdentity(context: BrowserRiskContext, record: BrowserRiskQuote) {
  if (!context.activeQuote || context.activeQuote.quoteId !== record.quoteId
    || context.activeQuote.version !== record.version || context.activeQuote.quoteHash !== record.quoteHash) {
    throw new Error("RISK_QUOTE_CONTEXT_CHANGED");
  }
}

function requireCurrentQuote(context: BrowserRiskContext, record: BrowserRiskQuote) {
  requireQuoteIdentity(context, record);
  if (record.quote.schemaVersion !== 2 || context.quoteSchemaVersion !== 2
    || !record.quote.assetId || record.quote.assetId !== context.assetId
    || record.quote.taskFingerprint !== context.taskFingerprint || record.quote.phase !== context.phase
    || !(Date.parse(record.quote.expiresAt) > Date.now())) {
    throw new Error("RISK_QUOTE_CONTEXT_CHANGED");
  }
}

export async function loadCurrentRiskQuote(taskId: string): Promise<BrowserRiskQuote | null> {
  const { context, record } = await readCurrentRiskQuote(taskId);
  if (record) requireQuoteIdentity(context, record);
  return record;
}

export async function createCurrentRiskQuote(taskId: string): Promise<BrowserRiskQuote> {
  const context = await readRiskContext(taskId);
  const record = await requestRiskQuote(taskId, context.taskFingerprint);
  requireCurrentQuote(await readRiskContext(taskId), record);
  return record;
}

export async function refreshCurrentRiskQuote(taskId: string, record: BrowserRiskQuote) {
  const context = await readRiskContext(taskId);
  requireCurrentQuote(context, record);
  return {
    status: context.quoteStatus,
    fundingContext: context.phase === "final" && context.quoteStatus === "confirmed"
      ? { quoteId: record.quoteId, taskFingerprint: context.taskFingerprint }
      : null,
  };
}

export async function confirmCurrentRiskQuote(taskId: string, record: BrowserRiskQuote) {
  const before = await readRiskContext(taskId);
  requireCurrentQuote(before, record);
  await confirmRiskQuote(taskId, record.quoteId, before.taskFingerprint, record.quoteHash);
  return refreshCurrentRiskQuote(taskId, record);
}
