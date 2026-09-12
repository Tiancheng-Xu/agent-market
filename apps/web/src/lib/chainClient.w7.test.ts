import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateWalletSession } from "./chainClient";
import { invalidateWalletSession } from "./walletSession";
const address = "0x1111111111111111111111111111111111111111";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function setup(options: { phase?: string; change?: string; fail?: string; invalidSignature?: boolean } = {}) {
  vi.stubEnv("SSR", false); // Mock browser branch, no real external wallet.
  let account: string | null = address;
  let chain = "0xaa36a7";
  const calls: string[] = [];
  const change = (phase: string) => {
    if (options.phase !== phase) return;
    if (options.change === "account") account = "0x2222222222222222222222222222222222222222";
    if (options.change === "chain") chain = "0x1";
    if (options.change === "disconnect") account = null;
  };
  change("initial");
  const request = vi.fn(async ({ method }: { method: string }) => {
    calls.push(method);
    if (method === "eth_accounts") return account ? [account] : [];
    if (method === "eth_chainId") return chain;
    if (method === "personal_sign") {
      if (options.fail === "sign") throw new Error("USER_REJECTED");
      change("sign");
      return options.invalidSignature ? null : "0xmock-signature";
    }
    throw new Error(`UNEXPECTED_WALLET_METHOD:${method}`);
  });
  const fetcher = vi.fn(async (path: string) => {
    calls.push(path);
    if (path === "/api/auth/logout") return new Response(null, { status: 204 });
    if (path === "/api/auth/challenge" || path === "/api/auth/verify") {
      const phase = path.endsWith("challenge") ? "challenge" : "verify";
      change(phase);
      return Response.json(options.fail === phase ? { error: "AUTH_FAILED" } : { message: "mock-only-login-challenge" }, { status: options.fail === phase ? 401 : 200 });
    }
    throw new Error(`UNEXPECTED_FETCH:${path}`);
  });
  vi.stubGlobal("window", { ethereum: { request } });
  vi.stubGlobal("fetch", fetcher);
  return { calls, request, fetcher };
}
describe("W7 mock EIP-1193 login safety (not real wallet or chain evidence)", () => {
  it("completes a stable mock login without any transaction method", async () => {
    const { calls } = setup();
    await authenticateWalletSession(address);
    expect(calls).toEqual(["eth_accounts", "eth_chainId", "/api/auth/challenge", "eth_accounts", "eth_chainId", "personal_sign", "eth_accounts", "eth_chainId", "/api/auth/verify", "eth_accounts", "eth_chainId"]);
  });
  for (const phase of ["initial", "challenge", "sign", "verify"]) {
    for (const change of ["account", "chain", "disconnect"]) {
      it(`rejects ${change} at ${phase} even without provider events`, async () => {
        const { calls } = setup({ phase, change });
        await expect(authenticateWalletSession(address)).rejects.toThrow(change === "chain" ? "CHAIN_ID_MISMATCH" : "AUTH_WALLET_CHANGED");
        expect(calls.at(-1)).toBe("/api/auth/logout");
        if (phase === "initial" || phase === "challenge") expect(calls).not.toContain("personal_sign");
        if (phase !== "verify") expect(calls).not.toContain("/api/auth/verify");
        expect(calls).not.toContain("eth_sendTransaction");
      });
    }
  }
  for (const fail of ["challenge", "sign", "verify"]) {
    it(`clears the session after ${fail} failure`, async () => {
      const { calls } = setup({ fail });
      await expect(authenticateWalletSession(address)).rejects.toThrow();
      expect(calls.at(-1)).toBe("/api/auth/logout");
      if (fail !== "verify") expect(calls).not.toContain("/api/auth/verify");
    });
  }
  it("rejects a malformed signature before verification", async () => {
    const { calls } = setup({ invalidSignature: true });
    await expect(authenticateWalletSession(address)).rejects.toThrow("AUTH_SIGNATURE_INVALID");
    expect(calls).not.toContain("/api/auth/verify");
    expect(calls.at(-1)).toBe("/api/auth/logout");
  });
  it("does not restore a login invalidated while verification was pending", async () => {
    const { fetcher, calls } = setup();
    let release!: () => void;
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const normalFetch = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path) => {
      if (path === "/api/auth/verify") { reached(); await gate; }
      return normalFetch(path);
    });
    const login = authenticateWalletSession(address);
    const rejection = expect(login).rejects.toThrow("AUTH_WALLET_CHANGED");
    await entered;
    const logout = invalidateWalletSession();
    release();
    await rejection;
    await logout;
    expect(calls.slice(-2)).toEqual(["/api/auth/logout", "/api/auth/logout"]);
  });
});
