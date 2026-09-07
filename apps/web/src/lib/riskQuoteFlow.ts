import { confirmRiskQuote, readRiskContext, requestRiskQuote, type BrowserRiskQuote } from "./riskPricingClient";

export async function loadCurrentRiskQuote(taskId: string): Promise<BrowserRiskQuote> {
  const context = await readRiskContext(taskId);
  const record = await requestRiskQuote(taskId, context.taskFingerprint);
  if (record.quote.taskFingerprint !== context.taskFingerprint || record.quote.phase !== context.phase) {
    throw new Error("RISK_QUOTE_CONTEXT_CHANGED");
  }
  return record;
}

export async function refreshCurrentRiskQuote(taskId: string, record: BrowserRiskQuote) {
  const context = await readRiskContext(taskId);
  if (context.taskFingerprint !== record.quote.taskFingerprint || context.phase !== record.quote.phase
    || Date.parse(record.quote.expiresAt) <= Date.now()) {
    throw new Error("RISK_QUOTE_CONTEXT_CHANGED");
  }
  return {
    status: context.quoteStatus,
    fundingContext: context.phase === "final" && context.quoteStatus === "confirmed"
      ? { quoteId: record.quoteId, taskFingerprint: context.taskFingerprint }
      : null,
  };
}

export async function confirmCurrentRiskQuote(taskId: string, record: BrowserRiskQuote) {
  const before = await readRiskContext(taskId);
  if (before.taskFingerprint !== record.quote.taskFingerprint || before.phase !== record.quote.phase
    || Date.parse(record.quote.expiresAt) <= Date.now()) {
    throw new Error("RISK_QUOTE_CONTEXT_CHANGED");
  }
  await confirmRiskQuote(taskId, record.quoteId, before.taskFingerprint);
  return refreshCurrentRiskQuote(taskId, record);
}
