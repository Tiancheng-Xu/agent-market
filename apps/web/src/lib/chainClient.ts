import type { TransactionIntentV1, TransactionVerificationV1 } from "@agent-market/shared-contracts";
import { assertWalletSessionAuthenticated, walletSessionRevision, withWalletSession } from "./walletSession";

const SEPOLIA_CHAIN_ID = 11_155_111;
const YD_DECIMALS = 18n;
let authenticatedWalletAddress: string | null = null;

interface EthereumProvider {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: () => void): void;
  removeListener?(event: string, listener: () => void): void;
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

export interface VaultPositionSnapshot {
  wallet: string;
  principalAtomic: string;
  accruedAtomic: string;
  checkpointAt: string;
  earnedAtomic: string;
  rewardReserveAtomic: string;
  blockNumber: number;
  checkedAt: string;
}

export interface ArbitrationReviewRecord {
  reviewId: string;
  resourceId: string;
  resourceRevision: number;
  reviewerWallet: string;
  agentsWin: boolean;
  args: { agentsWin: boolean };
  reviewHash: string;
  createdAt: string;
  expiresAt: string;
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const protectedRequest = !path.startsWith("/api/auth/");
  if (protectedRequest) assertWalletSessionAuthenticated();
  const revision = walletSessionRevision();
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({ error: "INVALID_RESPONSE" })) as { error?: string } & T;
  if (protectedRequest && revision !== walletSessionRevision()) throw new Error("AUTH_WALLET_CHANGED");
  if (!response.ok) throw new Error(payload.error ?? `HTTP_${response.status}`);
  return payload;
}

function provider(): EthereumProvider {
  // This module also supplies pure formatting helpers to SSR consumers. Vite
  // removes this browser branch from the Edge build, rather than hiding a
  // provider access from the build policy with alternate property spelling.
  if (import.meta.env.SSR) {
    throw new Error("WALLET_BROWSER_REQUIRED");
  } else {
    if (typeof window === "undefined" || !window.ethereum) throw new Error("METAMASK_UNAVAILABLE");
    return window.ethereum;
  }
}

export function ydIntegerToAtomic(value: string): string {
  if (!/^[1-9][0-9]*$/u.test(value.trim())) throw new Error("YD_AMOUNT_INVALID");
  return (BigInt(value.trim()) * (10n ** YD_DECIMALS)).toString();
}

export function formatYdAtomic(value: string, precision = 4): string {
  if (!/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isInteger(precision) || precision < 0 || precision > 18) {
    throw new Error("YD_ATOMIC_INVALID");
  }
  const atomic = BigInt(value);
  const base = 10n ** YD_DECIMALS;
  const whole = atomic / base;
  if (precision === 0) return whole.toString();
  const fraction = (atomic % base).toString().padStart(18, "0").slice(0, precision).replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function walletTransactionFromIntent(intent: TransactionIntentV1, walletAddress: string, now = Date.now()) {
  if (intent.chainId !== SEPOLIA_CHAIN_ID) throw new Error("CHAIN_ID_MISMATCH");
  if (intent.from.toLowerCase() !== walletAddress.toLowerCase()) throw new Error("INTENT_SENDER_MISMATCH");
  if (Date.parse(intent.expiresAt) <= now) throw new Error("INTENT_EXPIRED");
  if (!/^0x[a-fA-F0-9]{40}$/u.test(intent.to) || !/^0x(?:[a-fA-F0-9]{2})*$/u.test(intent.data)) throw new Error("INTENT_INVALID");
  return { from: walletAddress, to: intent.to, data: intent.data, value: `0x${BigInt(intent.valueAtomic).toString(16)}` };
}

export async function authenticateWalletSession(walletAddress: string): Promise<void> {
  authenticatedWalletAddress = null;
  await withWalletSession(async () => {
    const wallet = provider();
    const assertIdentity = async () => {
      const accounts = await wallet.request({ method: "eth_accounts" });
      const chain = await wallet.request({ method: "eth_chainId" });
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string"
          || accounts[0].toLowerCase() !== walletAddress.toLowerCase()) throw new Error("AUTH_WALLET_CHANGED");
      if (chain !== "0xaa36a7") throw new Error("CHAIN_ID_MISMATCH");
    };
    await assertIdentity();
    const challenge = await postJson<{ message: string }>("/api/auth/challenge", { address: walletAddress });
    await assertIdentity();
    const signature = await wallet.request({ method: "personal_sign", params: [challenge.message, walletAddress] });
    if (typeof signature !== "string") throw new Error("AUTH_SIGNATURE_INVALID");
    await assertIdentity();
    await postJson("/api/auth/verify", { message: challenge.message, signature });
    await assertIdentity();
  });
  authenticatedWalletAddress = walletAddress.toLowerCase();
}

async function assertAuthenticatedWalletIdentity(walletAddress: string): Promise<{
  revision: number;
  wallet: EthereumProvider;
}> {
  assertWalletSessionAuthenticated();
  const expectedAddress = walletAddress.toLowerCase();
  if (authenticatedWalletAddress !== expectedAddress) throw new Error("AUTH_REAUTH_REQUIRED");
  const revision = walletSessionRevision();
  const wallet = provider();
  const accounts = await wallet.request({ method: "eth_accounts" });
  if (revision !== walletSessionRevision() || !Array.isArray(accounts) || typeof accounts[0] !== "string"
      || accounts[0].toLowerCase() !== expectedAddress) throw new Error("AUTH_WALLET_CHANGED");
  const chain = await wallet.request({ method: "eth_chainId" });
  if (revision !== walletSessionRevision()) throw new Error("AUTH_WALLET_CHANGED");
  if (typeof chain !== "string" || !/^0x[0-9a-f]+$/iu.test(chain)
      || BigInt(chain) !== BigInt(SEPOLIA_CHAIN_ID)) throw new Error("CHAIN_ID_MISMATCH");
  return { revision, wallet };
}

async function assertIdentityUnchanged(walletAddress: string, revision: number, wallet: EthereumProvider): Promise<void> {
  if (revision !== walletSessionRevision() || provider() !== wallet) throw new Error("AUTH_WALLET_CHANGED");
  const accounts = await wallet.request({ method: "eth_accounts" });
  if (revision !== walletSessionRevision() || !Array.isArray(accounts) || typeof accounts[0] !== "string"
      || accounts[0].toLowerCase() !== walletAddress.toLowerCase()) throw new Error("AUTH_WALLET_CHANGED");
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

export async function readVaultPosition(resourceId: string): Promise<VaultPositionSnapshot> {
  const response = await postJson<{ position: VaultPositionSnapshot }>("/api/chain/position", { resourceId });
  return response.position;
}

export async function createTransactionIntent(resourceId: string, method: TransactionIntentV1["method"], args: Record<string, unknown>): Promise<TransactionIntentV1> {
  const response = await postJson<{ intent: TransactionIntentV1 }>("/api/transactions/intents", { resourceId, method, args });
  return response.intent;
}

export async function readArbitrationReview(resourceId: string, walletAddress: string): Promise<ArbitrationReviewRecord | null> {
  const identity = await assertAuthenticatedWalletIdentity(walletAddress);
  const response = await fetch(`/api/chain/resources/${encodeURIComponent(resourceId)}/arbitration-review`, {
    method: "GET", credentials: "include", signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({ error: "INVALID_RESPONSE" })) as { review?: ArbitrationReviewRecord | null; error?: string };
  await assertIdentityUnchanged(walletAddress, identity.revision, identity.wallet);
  if (!response.ok) throw new Error(payload.error ?? `HTTP_${response.status}`);
  return payload.review ?? null;
}

export async function completeArbitrationReview(resourceId: string, agentsWin: boolean): Promise<ArbitrationReviewRecord> {
  const response = await postJson<{ review: ArbitrationReviewRecord }>(
    `/api/chain/resources/${encodeURIComponent(resourceId)}/arbitration-review`, { agentsWin },
  );
  return response.review;
}

export class TransactionSubmissionUncertainError extends Error {
  readonly code = "TRANSACTION_SUBMISSION_UNCERTAIN";
  readonly submission = "uncertain";
  readonly reference: Readonly<{
    intentId: string; requestId: string; chainId: number; originalSender: string; txHash: string | null;
  }>;

  constructor(intent: TransactionIntentV1, txHash: string | null) {
    super(`TRANSACTION_SUBMISSION_UNCERTAIN: submission may have occurred. Check original intent ${intent.intentId}${txHash ? ` / hash ${txHash}` : " (hash unavailable)"} before retrying.`);
    this.name = "TransactionSubmissionUncertainError";
    this.reference = Object.freeze({ intentId: intent.intentId, requestId: intent.requestId,
      chainId: intent.chainId, originalSender: intent.from, txHash });
  }
}

export async function sendTransactionIntent(intent: TransactionIntentV1, walletAddress: string): Promise<string> {
  assertWalletSessionAuthenticated();
  const revision = walletSessionRevision();
  const wallet = provider();
  const original = { ...intent };
  let identityChanged = false;
  const changed = () => { identityChanged = true; };
  const events = ["accountsChanged", "chainChanged", "disconnect"];
  const assertCurrent = () => {
    if (identityChanged || revision !== walletSessionRevision() || provider() !== wallet) throw new Error("AUTH_WALLET_CHANGED");
    assertWalletSessionAuthenticated();
  };
  const assertIdentity = async () => {
    assertCurrent();
    const accounts = await wallet.request({ method: "eth_accounts" });
    assertCurrent();
    if (!Array.isArray(accounts) || typeof accounts[0] !== "string"
        || accounts[0].toLowerCase() !== walletAddress.toLowerCase()) throw new Error("AUTH_WALLET_CHANGED");
    const chain = await wallet.request({ method: "eth_chainId" });
    assertCurrent();
    if (typeof chain !== "string" || !/^0x[0-9a-f]+$/i.test(chain)
        || BigInt(chain) !== BigInt(SEPOLIA_CHAIN_ID)) throw new Error("CHAIN_ID_MISMATCH");
    const currentAccounts = await wallet.request({ method: "eth_accounts" });
    assertCurrent();
    if (!Array.isArray(currentAccounts) || typeof currentAccounts[0] !== "string"
        || currentAccounts[0].toLowerCase() !== walletAddress.toLowerCase()) throw new Error("AUTH_WALLET_CHANGED");
  };
  // These listeners are independent of a mounted hook and also catch A -> B -> A.
  const observe = Boolean(wallet.on && wallet.removeListener);
  if (observe) for (const event of events) wallet.on!(event, changed);
  try {
    walletTransactionFromIntent(original, walletAddress);
    await assertIdentity();
    const transaction = { ...walletTransactionFromIntent(original, walletAddress), chainId: "0xaa36a7" };
    assertCurrent();
    let txHash: string | null = null;
    try {
      const result = await wallet.request({ method: "eth_sendTransaction", params: [transaction] });
      if (typeof result !== "string" || !/^0x[a-fA-F0-9]{64}$/u.test(result)) throw new Error("TRANSACTION_HASH_INVALID");
      txHash = result;
      await assertIdentity();
      assertCurrent();
      // A hash is only a submission reference, not confirmation or settlement.
      return txHash;
    } catch {
      // Once handed to the provider, failure is not proof of non-submission.
      // Preserve only the original intent identity and a validated hash, never
      // replay or associate this reference with a newly connected wallet.
      throw new TransactionSubmissionUncertainError(original, txHash);
    }
  } finally {
    if (observe) for (const event of events) wallet.removeListener!(event, changed);
  }
}

export async function verifyTransactionIntent(intentId: string, txHash: string): Promise<TransactionCheck> {
  return postJson<TransactionCheck>("/api/transactions/verify", { intentId, txHash });
}
