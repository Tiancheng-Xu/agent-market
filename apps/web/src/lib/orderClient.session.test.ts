import { afterEach, describe, expect, it, vi } from "vitest";
import { executeOrderCommand, readOrder } from "./orderClient";
import { invalidateWalletSession, withWalletSession } from "./walletSession";

afterEach(() => vi.unstubAllGlobals());
describe("order callers reject a superseded session", () => {
  for (const action of ["read", "command"] as const) {
    it(`rejects a delayed ${action} response after invalidation and a new login`, async () => {
      let release!: (value: Response) => void;
      const gate = new Promise<Response>((resolve) => { release = resolve; });
      const fetcher = vi.fn(async (path: string) => path.includes("/orders/") ? gate : new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetcher);
      await withWalletSession(async () => undefined); // fixture authentication only
      const request = action === "read" ? readOrder("fixture") : executeOrderCommand("fixture", { type: "accept_assignment" });
      const rejection = expect(request).rejects.toThrow("AUTH_WALLET_CHANGED");
      await invalidateWalletSession();
      await withWalletSession(async () => undefined);
      release(Response.json({ order: {}, snapshot: {} }));
      await rejection;
      expect(fetcher.mock.calls.filter(([path]) => path.includes("/orders/"))).toHaveLength(1);
    });
  }
});
