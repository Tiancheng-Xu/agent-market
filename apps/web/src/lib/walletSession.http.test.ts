import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { Wallet } from "../../../transaction-engine/node_modules/ethers/lib.esm/index.js";
import { MemoryAuthStore } from "../../../transaction-engine/src/auth/auth-store";
import { readSessionCookie, WalletAuthService } from "../../../transaction-engine/src/auth/session";
import { createChallengeHandler } from "../../../transaction-engine/src/app/api/auth/challenge/route";
import { createVerifyHandler } from "../../../transaction-engine/src/app/api/auth/verify/route";
import { createLogoutHandler } from "../../../transaction-engine/src/app/api/auth/logout/route";
import { authenticateWalletSession, createChainAccountResource } from "./chainClient";
import { invalidateWalletSession, subscribeWalletSession } from "./walletSession";
import { executeOrderCommand, readOrder } from "./orderClient";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("uses real auth HTTP handlers: failed logout preserves cookie, local veto blocks reuse, retry revokes server session, fresh login recovers", async () => {
  vi.stubEnv("SSR", false); // Software fixture provider, not an external wallet.
  let failLogout = false;
  class FaultStore extends MemoryAuthStore {
    override async revokeSession(...args: Parameters<MemoryAuthStore["revokeSession"]>) {
      if (failLogout) throw new Error("FIXTURE_STORE_UNAVAILABLE");
      return super.revokeSession(...args);
    }
  }
  const auth = new WalletAuthService(new FaultStore());
  // Disposable software fixture key, never a user wallet. No transaction signing.
  const signer = Wallet.createRandom();
  const order = { id: "11111111-1111-4111-8111-111111111111", publisherWallet: signer.address.toLowerCase(),
    agentId: null, agentWallet: null, title: "HTTP fixture order", budgetAtomic: "100", status: "open",
    version: 1, artifacts: [], reviewEligible: false, manualReview: null, updatedAt: "2026-09-09T12:00:00.000Z" };
  const origin = "https://wallet-fixture.test";
  const handlers = new Map([
    ["/api/auth/challenge", createChallengeHandler(auth, new URL(origin))],
    ["/api/auth/verify", createVerifyHandler(auth)],
    ["/api/auth/logout", createLogoutHandler(auth)],
  ]);
  const events: Array<{ path: string; status: number; clearsCookie: boolean }> = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      let body = "";
      for await (const chunk of incoming) body += chunk;
      const path = incoming.url!;
      const headers = new Headers({ origin, "content-type": "application/json" });
      if (incoming.headers.cookie) headers.set("cookie", incoming.headers.cookie);
      const method = incoming.method ?? "GET";
      const request = new Request(origin + path, { method, headers,
        ...(method === "GET" ? {} : { body: body || "{}" }) });
      let response: Response;
      const handler = handlers.get(path);
      if (handler) response = await handler(request);
      else {
        try {
          await auth.authenticateSession(readSessionCookie(headers) ?? "");
          response = Response.json(path.startsWith("/api/orders/") ? { order, snapshot: order }
            : { account: { resourceId: "fixture-only", status: "authenticated" } });
        } catch { response = Response.json({ error: "AUTH_SESSION_INVALID" }, { status: 401 }); }
      }
      events.push({ path, status: response.status, clearsCookie: response.headers.get("set-cookie")?.includes("Max-Age=0") ?? false });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const nativeFetch = globalThis.fetch;
  let cookie = "";
  // Explicit in-memory cookie jar: exercises HTTP headers, not browser Secure-cookie policy.
  const transport = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.includes("Max-Age=0") ? "" : setCookie.split(";")[0]!;
    return response;
  };
  vi.stubGlobal("fetch", transport);
  vi.stubGlobal("window", { ethereum: { request: async ({ method, params }: { method: string; params?: string[] }) => {
    if (method === "eth_accounts") return [signer.address];
    if (method === "eth_chainId") return "0xaa36a7";
    if (method === "personal_sign") return signer.signMessage(params![0]!);
    throw new Error("UNEXPECTED_METHOD_NO_TRANSACTIONS_ALLOWED");
  } } });
  const notices: string[] = [];
  const unsubscribe = subscribeWalletSession((notice) => notices.push(notice));
  try {
    await authenticateWalletSession(signer.address);
    expect(Boolean(cookie)).toBe(true);
    await expect(readOrder(order.id)).resolves.toMatchObject({ id: order.id });
    await expect(createChainAccountResource()).resolves.toMatchObject({ status: "authenticated" });
    const originalCookie = cookie;
    failLogout = true;
    await expect(invalidateWalletSession()).rejects.toThrow("AUTH_LOGOUT_UNAVAILABLE");
    expect(notices.slice(-2)).toEqual(["invalidated", "logout-failed"]);
    expect(cookie === originalCookie).toBe(true);
    expect(events.at(-1)).toMatchObject({ status: 503, clearsCookie: false });
    const beforeProtected = events.length;
    await expect(createChainAccountResource()).rejects.toThrow("AUTH_REAUTH_REQUIRED");
    // Actual order callers must also veto the cookie that the server still accepts,
    // even if the same provider account is connected again without fresh login.
    await expect(readOrder("fixture-order")).rejects.toThrow("AUTH_REAUTH_REQUIRED");
    await expect(executeOrderCommand("fixture-order", { type: "accept_assignment" })).rejects.toThrow("AUTH_REAUTH_REQUIRED");
    expect(events.length).toBe(beforeProtected);
    // Demonstrates why a failed logout must never be described as cookie deletion.
    expect((await transport("/fixture/protected")).status).toBe(200);
    expect((await transport("/api/orders/fixture-order")).status).toBe(200);
    expect((await transport("/api/orders/fixture-order/commands")).status).toBe(200);
    await expect(authenticateWalletSession(signer.address)).rejects.toThrow("AUTH_LOGOUT_UNAVAILABLE");
    failLogout = false;
    await invalidateWalletSession();
    expect(cookie).toBe("");
    const rejected = await nativeFetch(`http://127.0.0.1:${port}/fixture/protected`, {
      method: "POST", headers: { cookie: originalCookie, "x-client-authenticated": "true" },
    });
    expect(rejected.status).toBe(401);
    await expect(createChainAccountResource()).rejects.toThrow("AUTH_REAUTH_REQUIRED");
    await authenticateWalletSession(signer.address);
    await expect(createChainAccountResource()).resolves.toMatchObject({ status: "authenticated" });
    await expect(readOrder(order.id)).resolves.toMatchObject({ id: order.id });
  } finally {
    unsubscribe();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
