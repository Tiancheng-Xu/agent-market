import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendTransactionIntent, TransactionSubmissionUncertainError } from "./chainClient";
import { invalidateWalletSession, withWalletSession } from "./walletSession";
const sender = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const hash = `0x${"ab".repeat(32)}`;
const intent = {
  intentId: "0191f6f8-cb6b-7f31-81ad-c497d7d90301", requestId: "0191f6f8-cb6b-7f31-81ad-c497d7d90301",
  requestRef: `0x${"11".repeat(32)}`, chainId: 11_155_111 as const, from: sender, to: other,
  method: "createTask" as const, data: "0x1234", valueAtomic: "0", createdAt: "2026-08-26T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z",
};
let account: string | null;
let chain: string;
let onRead: (() => Promise<void>) | undefined;
let onSend: () => Promise<unknown>;
let request: ReturnType<typeof vi.fn>;
let listeners: Map<string, () => void>;
beforeEach(async () => {
  vi.stubEnv("SSR", false); // Exercise the browser branch with Mock EIP-1193 only.
  account = sender; chain = "0xaa36a7"; onRead = undefined; onSend = async () => hash;
  listeners = new Map();
  request = vi.fn(async ({ method }: { method: string }) => {
    if (method === "eth_accounts") return account ? [account] : [];
    if (method === "eth_chainId") { await onRead?.(); return chain; }
    if (method === "eth_sendTransaction") return onSend();
    throw new Error("UNEXPECTED_MOCK_METHOD");
  });
  vi.stubGlobal("window", { ethereum: { request,
    on: (event: string, fn: () => void) => listeners.set(event, fn),
    removeListener: (event: string) => listeners.delete(event),
  } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  await withWalletSession(async () => undefined); // Mock authenticated revision, not real wallet authentication.
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const sends = () => request.mock.calls.filter(([input]) => input.method === "eth_sendTransaction");
describe("mock-only transaction submission identity boundary", () => {
  it("rejects SSR wallet access even if a provider-shaped global exists", async () => {
    vi.stubEnv("SSR", true);
    await expect(sendTransactionIntent(intent, sender)).rejects.toThrow("WALLET_BROWSER_REQUIRED");
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects a browser environment without a window safely", async () => {
    vi.stubGlobal("window", undefined);
    await expect(sendTransactionIntent(intent, sender)).rejects.toThrow("METAMASK_UNAVAILABLE");
    expect(request).not.toHaveBeenCalled();
  });
  it("binds the exact request to Sepolia and returns only a hash reference", async () => {
    await expect(sendTransactionIntent(intent, sender)).resolves.toBe(hash);
    expect(sends()).toHaveLength(1);
    expect(sends()[0]![0].params).toEqual([{ from: sender, to: other, data: "0x1234", value: "0x0", chainId: "0xaa36a7" }]);
    expect(listeners.size).toBe(0);
  });
  for (const mismatch of ["account", "chain", "disconnect", "unauthenticated"]) {
    it(`does not invoke send for preflight ${mismatch}`, async () => {
      if (mismatch === "account") account = other;
      if (mismatch === "chain") chain = "0x1";
      if (mismatch === "disconnect") account = null;
      if (mismatch === "unauthenticated") await invalidateWalletSession();
      await expect(sendTransactionIntent(intent, sender)).rejects.toThrow();
      expect(sends()).toHaveLength(0);
      expect(listeners.size).toBe(0);
    });
  }
  it("rejects a revision changed during preflight even after reauthentication", async () => {
    onRead = async () => { await invalidateWalletSession(); await withWalletSession(async () => undefined); };
    await expect(sendTransactionIntent(intent, sender)).rejects.toThrow("AUTH_WALLET_CHANGED");
    expect(sends()).toHaveLength(0);
  });
  it("does not send when the selected account changes silently during the chain read", async () => {
    onRead = async () => { account = other; };
    await expect(sendTransactionIntent(intent, sender)).rejects.toThrow("AUTH_WALLET_CHANGED");
    expect(sends()).toHaveLength(0);
  });
  for (const change of ["account", "chain", "disconnect", "revision", "provider"]) {
    it(`retains a delayed hash as uncertain after ${change}, without resending or rebinding`, async () => {
      let release!: (value: unknown) => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      onSend = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
      const result = sendTransactionIntent(intent, sender).catch((error: unknown) => error);
      await waiting;
      if (change === "account") account = other;
      if (change === "chain") chain = "0x1";
      if (change === "disconnect") account = null;
      if (change === "revision") { await invalidateWalletSession(); await withWalletSession(async () => undefined); }
      if (change === "provider") vi.stubGlobal("window", { ethereum: { request } });
      release(hash);
      const error = await result;
      expect(error).toBeInstanceOf(TransactionSubmissionUncertainError);
      expect(error).toMatchObject({ submission: "uncertain", reference: { intentId: intent.intentId, originalSender: sender, chainId: 11_155_111, txHash: hash } });
      expect(sends()).toHaveLength(1);
      expect(listeners.size).toBe(0);
    });
  }
  it("detects an account event even when the final account returns to its original value", async () => {
    onSend = async () => { listeners.get("accountsChanged")!(); return hash; };
    await expect(sendTransactionIntent(intent, sender)).rejects.toMatchObject({ submission: "uncertain", reference: { txHash: hash } });
    expect(sends()).toHaveLength(1);
  });
  for (const result of ["invalid-hash", "transport-error"]) {
    it(`keeps the original intent reference when ${result} leaves submission unknown`, async () => {
      onSend = async () => { if (result === "transport-error") throw new Error("PROVIDER_DISCONNECTED"); return "invalid"; };
      const error = await sendTransactionIntent(intent, sender).catch((value: unknown) => value);
      expect(error).toMatchObject({ submission: "uncertain", reference: { intentId: intent.intentId, originalSender: sender, txHash: null } });
      expect(Object.keys((error as TransactionSubmissionUncertainError).reference).sort()).toEqual(["chainId", "intentId", "originalSender", "requestId", "txHash"]);
      expect(sends()).toHaveLength(1);
    });
  }
});
