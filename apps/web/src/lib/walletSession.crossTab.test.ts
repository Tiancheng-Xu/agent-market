import { afterEach, expect, it, vi } from "vitest";
import { invalidateWalletSession, subscribeWalletSession, walletSessionRevision, withWalletSession } from "./walletSession";
afterEach(() => vi.unstubAllGlobals());
it("broadcasts invalidation metadata only, deduplicates itself, never relays received events, revokes pending work, and detaches", async () => {
  let receive: (event: { data: unknown }) => void = () => undefined;
  const postMessage = vi.fn();
  const close = vi.fn();
  const remove = vi.fn();
  class Channel {
    postMessage = postMessage;
    close = close;
    addEventListener(_name: string, handler: typeof receive) { receive = handler; }
    removeEventListener = remove;
  }
  vi.stubGlobal("window", { BroadcastChannel: Channel });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  const notice = vi.fn();
  const unsubscribe = subscribeWalletSession(notice);
  try {
    await invalidateWalletSession();
    const message = postMessage.mock.calls[0]![0];
    expect(Object.keys(message).sort()).toEqual(["eventId", "type", "version"]);
    const beforeEcho = walletSessionRevision();
    receive({ data: message });
    expect(walletSessionRevision()).toBe(beforeEcho);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const running = new Promise<void>((resolve) => { entered = resolve; });
    const login = withWalletSession(async () => { entered(); await gate; });
    const rejection = expect(login).rejects.toThrow("AUTH_WALLET_CHANGED");
    await running;
    receive({ data: { type: "wallet-invalidated", version: 1, eventId: "22222222-2222-4222-8222-222222222222" } });
    expect(walletSessionRevision()).toBe(beforeEcho + 1);
    expect(notice).toHaveBeenLastCalledWith("invalidated");
    expect(postMessage).toHaveBeenCalledTimes(1);
    release();
    await rejection;
    receive({ data: { ...message, address: "should-not-be-accepted" } });
    expect(walletSessionRevision()).toBe(beforeEcho + 1);
  } finally { unsubscribe(); }
  expect(remove).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});
