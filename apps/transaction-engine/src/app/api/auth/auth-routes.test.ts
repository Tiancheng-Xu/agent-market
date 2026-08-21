import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";

import { MemoryAuthStore, type AuthStore } from "../../../auth/auth-store";
import { WalletAuthService } from "../../../auth/session";
import { createChallengeHandler } from "./challenge/route";
import { createLogoutHandler } from "./logout/route";
import { createVerifyHandler } from "./verify/route";

function service(): WalletAuthService {
  let id = 0;
  const ids = ["0191f6f8-cb6b-7f31-81ad-c497d7d90101", "0191f6f8-cb6b-7f31-81ad-c497d7d90103"];
  return new WalletAuthService(new MemoryAuthStore(), {
    now: () => new Date("2026-08-21T12:00:00.000Z"),
    id: () => ids[id++]!,
    nonce: () => "0123456789abcdef01234567",
    sessionToken: () => "raw-session-cookie-only",
  });
}

describe("wallet auth routes", () => {
  it("sets a secure HttpOnly cookie without returning its raw value", async () => {
    const auth = service();
    const wallet = Wallet.createRandom();
    const challengeResponse = await createChallengeHandler(auth, new URL("https://agent-market.test"))(new Request("https://agent-market.test/api/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://agent-market.test", "x-request-id": "0191f6f8-cb6b-7f31-81ad-c497d7d90102" },
      body: JSON.stringify({ address: wallet.address }),
    }));
    const challengeBody = await challengeResponse.json() as { message: string };
    const signature = await wallet.signMessage(challengeBody.message);
    const response = await createVerifyHandler(auth)(new Request("https://agent-market.test/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: challengeBody.message, signature }),
    }));
    const body = JSON.stringify(await response.json());
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(response.status).toBe(200);
    expect(cookie).toContain("__Host-agent_market_session=raw-session-cookie-only");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(body).not.toContain("raw-session-cookie-only");
  });

  it("revokes idempotently and clears the cookie", async () => {
    const response = await createLogoutHandler(service())(new Request("https://agent-market.test/api/auth/logout", {
      method: "POST",
      headers: { cookie: "__Host-agent_market_session=unknown" },
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("rejects spoofed request and forwarded hosts", async () => {
    const auth = service();
    const wallet = Wallet.createRandom();
    const body = JSON.stringify({ address: wallet.address });
    const handler = createChallengeHandler(auth, new URL("https://agent-market.test"));
    const spoofed = await handler(new Request("https://evil.test/api/auth/challenge", {
      method: "POST", headers: { origin: "https://agent-market.test" }, body,
    }));
    const forwarded = await handler(new Request("https://agent-market.test/api/auth/challenge", {
      method: "POST", headers: { origin: "https://agent-market.test", "x-forwarded-host": "evil.test" }, body,
    }));
    expect(spoofed.status).toBe(403);
    expect(forwarded.status).toBe(403);
  });

  it("maps store failures to 503, preserves retryable cookies, and clears malformed cookies", async () => {
    const fail = async (): Promise<never> => { throw new Error("DATABASE_UNAVAILABLE"); };
    const store: AuthStore = {
      createChallenge: fail,
      findChallenge: fail,
      consumeChallengeAndCreateSession: fail,
      findActiveSession: fail,
      revokeSession: fail,
    };
    const auth = new WalletAuthService(store);
    const wallet = Wallet.createRandom();
    const challengeResponse = await createChallengeHandler(auth, new URL("https://agent-market.test"))(new Request("https://agent-market.test/api/auth/challenge", {
      method: "POST", headers: { origin: "https://agent-market.test", "content-type": "application/json" }, body: JSON.stringify({ address: wallet.address }),
    }));
    const healthy = service();
    const healthyChallengeResponse = await createChallengeHandler(healthy, new URL("https://agent-market.test"))(new Request("https://agent-market.test/api/auth/challenge", {
      method: "POST", headers: { origin: "https://agent-market.test", "content-type": "application/json" }, body: JSON.stringify({ address: wallet.address }),
    }));
    const healthyChallenge = await healthyChallengeResponse.json() as { message: string };
    const verifyResponse = await createVerifyHandler(auth)(new Request("https://agent-market.test/api/auth/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: healthyChallenge.message, signature: await wallet.signMessage(healthyChallenge.message) }),
    }));
    const failedLogoutResponse = await createLogoutHandler(auth)(new Request("https://agent-market.test/api/auth/logout", {
      method: "POST", headers: { cookie: "__Host-agent_market_session=retryable", "x-request-id": "0191f6f8-cb6b-7f31-81ad-c497d7d90102" },
    }));
    const malformedLogoutResponse = await createLogoutHandler(auth)(new Request("https://agent-market.test/api/auth/logout", {
      method: "POST", headers: { cookie: "__Host-agent_market_session=%E0%A4%A" },
    }));
    expect(challengeResponse.status).toBe(503);
    expect(verifyResponse.status).toBe(503);
    expect(failedLogoutResponse.status).toBe(503);
    expect(failedLogoutResponse.headers.get("set-cookie")).toBeNull();
    expect(failedLogoutResponse.headers.get("x-request-id")).toBe("0191f6f8-cb6b-7f31-81ad-c497d7d90102");
    expect(malformedLogoutResponse.status).toBe(204);
    expect(malformedLogoutResponse.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
