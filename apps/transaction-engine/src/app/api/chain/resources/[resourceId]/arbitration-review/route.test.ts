import { Wallet } from "ethers";
import { describe, expect, it, vi } from "vitest";

import { MemoryChainResourceRepository } from "../../../../../../chain/resources";
import { createArbitrationReviewHandler } from "./route";

const resourceId = "0191f6f8-cb6b-7f31-81ad-c497d7d90304";
const now = new Date("2026-09-12T12:00:00.000Z");
const origin = new URL("https://agent-market.test");

function request(method: "GET" | "POST", agentsWin = true, requestOrigin = origin.origin) {
  return new Request(`${origin.origin}/api/chain/resources/${resourceId}/arbitration-review`, {
    method,
    headers: { cookie: "__Host-agent_market_session=review-session", origin: requestOrigin, "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify({ agentsWin }) } : {}),
  });
}

describe("platform arbitration review API", () => {
  it("requires same-origin recent authentication and persists only the configured arbiter review", async () => {
    const arbiter = Wallet.createRandom();
    const resources = new MemoryChainResourceRepository([{
      resourceId, publisherWallet: Wallet.createRandom().address, agentWallet: null,
      budgetAtomic: "100", status: "disputed", revision: 3,
    }], [], arbiter.address);
    const auth = {
      authenticateSession: vi.fn(async () => ({
        sessionId: "0191f6f8-cb6b-7f31-81ad-c497d7d90306",
        requestId: "0191f6f8-cb6b-7f31-81ad-c497d7d90307",
        walletAddress: arbiter.address.toLowerCase(), chainId: 11_155_111 as const,
        issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString(), recentAuthAt: now.toISOString(),
      })),
      requireRecentAuth: vi.fn(),
    };
    const handler = createArbitrationReviewHandler({ auth, resources, authOrigin: origin, now: () => now });

    const foreign = await handler(request("POST", true, "https://foreign.example"), resourceId);
    expect(foreign.status).toBe(403);
    expect(auth.authenticateSession).not.toHaveBeenCalled();

    const created = await handler(request("POST"), resourceId);
    const createdBody = await created.json() as { review: { resourceRevision: number; agentsWin: boolean; reviewHash: string } };
    expect(created.status).toBe(201);
    expect(createdBody.review).toMatchObject({ resourceRevision: 3, agentsWin: true });
    expect(createdBody.review.reviewHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(auth.requireRecentAuth).toHaveBeenCalledOnce();

    const read = await handler(request("GET"), resourceId);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(expect.objectContaining({ review: createdBody.review }));
  });
});
