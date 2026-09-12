import { afterEach, describe, expect, it, vi } from "vitest";

import { authenticateWalletSession, readArbitrationReview } from "./chainClient";

const walletA = "0x1111111111111111111111111111111111111111";
const walletB = "0x2222222222222222222222222222222222222222";
const resourceId = "0191f6f8-cb6b-7f31-81ad-c497d7d90304";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("platform arbitration review wallet-session boundary", () => {
  it("does not read wallet A review after the connected account switches to wallet B", async () => {
    vi.stubEnv("SSR", false);
    let account = walletA;
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_accounts") return [account];
      if (method === "eth_chainId") return "0xaa36a7";
      if (method === "personal_sign") return "0xmock-signature";
      throw new Error(`UNEXPECTED_WALLET_METHOD:${method}`);
    });
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/api/auth/challenge") return Response.json({ message: "mock-only-login-challenge" });
      if (path === "/api/auth/verify") return Response.json({ ok: true });
      if (path === "/api/auth/logout") return new Response(null, { status: 204 });
      if (path === `/api/chain/resources/${resourceId}/arbitration-review`) return Response.json({ review: null });
      throw new Error(`UNEXPECTED_FETCH:${path}`);
    });
    vi.stubGlobal("window", { ethereum: { request } });
    vi.stubGlobal("fetch", fetcher);

    await authenticateWalletSession(walletA);
    account = walletB;

    await expect(readArbitrationReview(resourceId, walletB)).rejects.toThrow("AUTH_REAUTH_REQUIRED");
    expect(fetcher).not.toHaveBeenCalledWith(`/api/chain/resources/${resourceId}/arbitration-review`);
    expect(request.mock.calls.filter(([input]) => input.method === "personal_sign")).toHaveLength(1);
  });

  it("rejects an account switch while an authorized review read is in flight", async () => {
    vi.stubEnv("SSR", false);
    let account = walletA;
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_accounts") return [account];
      if (method === "eth_chainId") return "0xaa36a7";
      if (method === "personal_sign") return "0xmock-signature";
      throw new Error(`UNEXPECTED_WALLET_METHOD:${method}`);
    });
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/api/auth/challenge") return Response.json({ message: "mock-only-login-challenge" });
      if (path === "/api/auth/verify") return Response.json({ ok: true });
      if (path === "/api/auth/logout") return new Response(null, { status: 204 });
      if (path === `/api/chain/resources/${resourceId}/arbitration-review`) {
        account = walletB;
        return Response.json({ review: null });
      }
      throw new Error(`UNEXPECTED_FETCH:${path}`);
    });
    vi.stubGlobal("window", { ethereum: { request } });
    vi.stubGlobal("fetch", fetcher);

    await authenticateWalletSession(walletA);
    await expect(readArbitrationReview(resourceId, walletA)).rejects.toThrow("AUTH_WALLET_CHANGED");
  });
});
