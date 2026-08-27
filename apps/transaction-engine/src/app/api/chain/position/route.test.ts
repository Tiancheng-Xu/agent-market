import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";

import { MemoryAuthStore } from "../../../../auth/auth-store";
import { formatChallengeMessage } from "../../../../auth/challenge";
import { WalletAuthService } from "../../../../auth/session";
import { deriveAccountResourceId } from "../../../../chain/policy";
import type { VaultPositionReader } from "../../../../chain/readers";
import { MemoryChainResourceRepository } from "../../../../chain/resources";
import { createVaultPositionHandler } from "./route";

describe("vault position route", () => {
  it("returns only the authenticated wallet position from a read-only reader", async () => {
    const wallet = Wallet.createRandom();
    let id = 0;
    const ids = ["0191f6f8-cb6b-7f31-81ad-c497d7d90312", "0191f6f8-cb6b-7f31-81ad-c497d7d90313"];
    const auth = new WalletAuthService(new MemoryAuthStore(), {
      now: () => new Date("2026-08-26T13:40:00.000Z"), id: () => ids[id++]!,
      nonce: () => "0123456789abcdef01234567", sessionToken: () => "vault-position-session",
    });
    const challenge = await auth.issueChallenge(wallet.address, {
      requestId: "0191f6f8-cb6b-7f31-81ad-c497d7d90311",
      domain: "agent-market.test", uri: "https://agent-market.test",
    });
    const message = formatChallengeMessage(challenge);
    await auth.verifyChallenge(message, await wallet.signMessage(message));
    const resources = new MemoryChainResourceRepository([]);
    const account = await resources.createChainAccount(deriveAccountResourceId(wallet.address), wallet.address);
    const reader: VaultPositionReader = {
      async readPosition(address) {
        expect(address.toLowerCase()).toBe(wallet.address.toLowerCase());
        return {
          wallet: address.toLowerCase(), principalAtomic: "100", accruedAtomic: "6",
          checkpointAt: "1800000000", earnedAtomic: "9", rewardReserveAtomic: "1000",
          blockNumber: 100, checkedAt: "2026-08-26T13:40:00.000Z",
        };
      },
    };
    const response = await createVaultPositionHandler({
      auth, resources, reader, authOrigin: new URL("https://agent-market.test"),
    })(new Request("https://agent-market.test/api/chain/position", {
      method: "POST",
      headers: {
        origin: "https://agent-market.test", "content-type": "application/json",
        cookie: "__Host-agent_market_session=vault-position-session",
      },
      body: JSON.stringify({ resourceId: account.resourceId }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      position: { wallet: wallet.address.toLowerCase(), principalAtomic: "100", blockNumber: 100 },
    });
  });
});
