import type { TransactionIntentV1, TransactionVerificationV1 } from "@agent-market/shared-contracts";

const SEPOLIA_CHAIN_ID = 11_155_111;
const YD_DECIMALS = 18n;

interface EthereumProvider {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface TaskDraftResponse {
  resourceId: string;
  requestId: string;
  status: string;
  budgetAtomic: string;
  platformFeeAtomic: string;
  platformFeeStatus: string;
}

export interface TransactionCheck {
  verification: TransactionVerificationV1;
  evidence?: Record<string, unknown>;
  requestId: string;
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({ error: "INVALID_RESPONSE" })) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error ?? `HTTP_${response.status}`);
  return payload;
}

function provider(): EthereumProvider {
  if (!window.ethereum) throw new Error("METAMASK_UNAVAILABLE");
  return window.ethereum;
}

export function ydIntegerToAtomic(value: string): string {
  if (!/^[1-9][0-9]*$/u.test(value.trim())) throw new Error("YD_AMOUNT_INVALID");
  return (BigInt(value.trim()) * (10n ** YD_DECIMALS)).toString();
}

export function walletTransactionFromIntent(intent: TransactionIntentV1, walletAddress: string, now = Date.now()) {
  if (intent.chainId !== SEPOLIA_CHAIN_ID) throw new Error("CHAIN_ID_MISMATCH");
  if (intent.from.toLowerCase() !== walletAddress.toLowerCase()) throw new Error("INTENT_SENDER_MISMATCH");
  if (Date.parse(intent.expiresAt) <= now) throw new Error("INTENT_EXPIRED");
  if (!/^0x[a-fA-F0-9]{40}$/u.test(intent.to) || !/^0x(?:[a-fA-F0-9]{2})*$/u.test(intent.data)) throw new Error("INTENT_INVALID");
  return { from: walletAddress, to: intent.to, data: intent.data, value: `0x${BigInt(intent.valueAtomic).toString(16)}` };
}

export async function authenticateWalletSession(walletAddress: string): Promise<void> {
  const challenge = await postJson<{ message: string }>("/api/auth/challenge", { address: walletAddress });
  const signature = await provider().request({ method: "personal_sign", params: [challenge.message, walletAddress] });
  if (typeof signature !== "string") throw new Error("AUTH_SIGNATURE_INVALID");
  await postJson("/api/auth/verify", { message: challenge.message, signature });
}

export async function createTaskDraft(input: {
  title: string;
  description: string;
  category: string;
  tags: string[];
  budgetAtomic: string;
}): Promise<TaskDraftResponse> {
  const response = await postJson<{ task: TaskDraftResponse }>("/api/tasks", input);
  return response.task;
}

export async function createChainAccountResource(): Promise<{ resourceId: string; status: string }> {
  const response = await postJson<{ account: { resourceId: string; status: string } }>("/api/chain/account", {});
  return response.account;
}

export async function createTransactionIntent(resourceId: string, method: TransactionIntentV1["method"], args: Record<string, unknown>): Promise<TransactionIntentV1> {
  const response = await postJson<{ intent: TransactionIntentV1 }>("/api/transactions/intents", { resourceId, method, args });
  return response.intent;
}

export async function sendTransactionIntent(intent: TransactionIntentV1, walletAddress: string): Promise<string> {
  const txHash = await provider().request({ method: "eth_sendTransaction", params: [walletTransactionFromIntent(intent, walletAddress)] });
  if (typeof txHash !== "string" || !/^0x[a-fA-F0-9]{64}$/u.test(txHash)) throw new Error("TRANSACTION_HASH_INVALID");
  return txHash;
}

export async function verifyTransactionIntent(intentId: string, txHash: string): Promise<TransactionCheck> {
  return postJson<TransactionCheck>("/api/transactions/verify", { intentId, txHash });
}
