import { afterEach, expect, it, vi } from "vitest";
import { invalidateWalletSession, withWalletSession } from "./walletSession";
afterEach(() => vi.unstubAllGlobals());
it("revokes a late verification before allowing a new login", async () => {
  const events: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async () => { events.push("logout"); return new Response(null, { status: 204 }); }));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const first = withWalletSession(async () => { events.push("verify-start"); await blocked; events.push("verify-end"); });
  const rejected = expect(first).rejects.toThrow("AUTH_WALLET_CHANGED");
  await Promise.resolve();
  const logout = invalidateWalletSession();
  const second = withWalletSession(async () => { events.push("new-login"); });
  release();
  await rejected;
  await logout;
  await second;
  expect(events).toEqual(["verify-start", "verify-end", "logout", "logout", "new-login"]);
});
it("does not run a queued signature for a superseded identity", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  const operation = vi.fn(async () => undefined);
  const login = withWalletSession(operation);
  const rejected = expect(login).rejects.toThrow("AUTH_WALLET_CHANGED");
  await invalidateWalletSession();
  await rejected;
  expect(operation).not.toHaveBeenCalled();
});

it("revokes verification cookies when identity readback fails without provider events", async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL) => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(withWalletSession(async () => { throw new Error("AUTH_WALLET_CHANGED"); })).rejects.toThrow("AUTH_WALLET_CHANGED");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/auth/logout");
});
