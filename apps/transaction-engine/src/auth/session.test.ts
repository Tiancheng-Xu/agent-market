import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";

import { MemoryAuthStore } from "./auth-store";
import { formatChallengeMessage } from "./challenge";
import { WalletAuthService } from "./session";

const challengeId = "0191f6f8-cb6b-7f31-81ad-c497d7d90101";
const requestId = "0191f6f8-cb6b-7f31-81ad-c497d7d90102";
const sessionId = "0191f6f8-cb6b-7f31-81ad-c497d7d90103";

function fixture() {
  let now = new Date("2026-08-21T12:00:00.000Z");
  let nextId = 0;
  const ids = [challengeId, sessionId];
  const store = new MemoryAuthStore();
  const service = new WalletAuthService(store, {
    now: () => now,
    id: () => ids[nextId++]!,
    nonce: () => "0123456789abcdef01234567",
    sessionToken: () => "session-token-that-never-enters-the-body",
  });
  return { service, setNow(value: string) { now = new Date(value); } };
}

async function challenge(
  service: WalletAuthService,
  wallet: { address: string; signMessage(message: string): Promise<string> },
) {
  const issued = await service.issueChallenge(wallet.address, {
    requestId,
    domain: "agent-market.test",
    uri: "https://agent-market.test",
  });
  const message = formatChallengeMessage(issued);
  return { issued, message, signature: await wallet.signMessage(message) };
}

describe("wallet challenge and session", () => {
  it("verifies once, normalizes the wallet, and keeps the raw token outside the session", async () => {
    const wallet = Wallet.createRandom();
    const { service } = fixture();
    const signed = await challenge(service, wallet);
    const verified = await service.verifyChallenge(signed.message, signed.signature);
    expect(verified.session.walletAddress).toBe(wallet.address.toLowerCase());
    expect(verified.session).not.toHaveProperty("sessionToken");
    expect(verified.sessionToken).toBe("session-token-that-never-enters-the-body");
    await expect(service.verifyChallenge(signed.message, signed.signature)).rejects.toThrow("AUTH_CHALLENGE_CONSUMED");
  });

  it("rejects expired challenges", async () => {
    const wallet = Wallet.createRandom();
    const { service, setNow } = fixture();
    const signed = await challenge(service, wallet);
    setNow("2026-08-21T12:06:00.000Z");
    await expect(service.verifyChallenge(signed.message, signed.signature)).rejects.toThrow("AUTH_CHALLENGE_EXPIRED");
  });

  it("rejects invalid signatures and signatures from another wallet", async () => {
    const wallet = Wallet.createRandom();
    const otherWallet = Wallet.createRandom();
    const invalidFixture = fixture();
    const invalid = await challenge(invalidFixture.service, wallet);
    await expect(invalidFixture.service.verifyChallenge(invalid.message, "not-a-signature")).rejects.toThrow("AUTH_SIGNATURE_INVALID");

    const mismatchFixture = fixture();
    const mismatch = await challenge(mismatchFixture.service, wallet);
    await expect(mismatchFixture.service.verifyChallenge(
      mismatch.message,
      await otherWallet.signMessage(mismatch.message),
    )).rejects.toThrow("AUTH_WALLET_MISMATCH");
  });

  it.each([
    ["domain", "Domain: agent-market.test", "Domain: evil.test"],
    ["chain", "Chain ID: 11155111", "Chain ID: 1"],
    ["wallet", "Wallet: ", "Wallet: 0x0000000000000000000000000000000000000001#"],
  ])("rejects a %s mismatch", async (_name, from, to) => {
    const wallet = Wallet.createRandom();
    const { service } = fixture();
    const signed = await challenge(service, wallet);
    const tampered = from === "Wallet: "
      ? signed.message.replace(/^Wallet: .*$/m, to.slice(0, -1))
      : signed.message.replace(from, to);
    await expect(service.verifyChallenge(tampered, await wallet.signMessage(tampered))).rejects.toThrow(/AUTH_CHALLENGE/);
  });

  it("revokes sessions and enforces recent authentication", async () => {
    const wallet = Wallet.createRandom();
    const { service, setNow } = fixture();
    const signed = await challenge(service, wallet);
    const verified = await service.verifyChallenge(signed.message, signed.signature);
    expect(await service.authenticateSession(verified.sessionToken)).toEqual(verified.session);
    service.requireRecentAuth(verified.session);
    setNow("2026-08-21T12:06:00.000Z");
    expect(() => service.requireRecentAuth(verified.session)).toThrow("AUTH_RECENT_REQUIRED");
    expect(() => service.requireRecentAuth({ ...verified.session, recentAuthAt: "2026-08-21T12:07:00.000Z" })).toThrow("AUTH_RECENT_REQUIRED");
    await service.revokeSession(verified.sessionToken);
    await expect(service.authenticateSession(verified.sessionToken)).rejects.toThrow("AUTH_SESSION_INVALID");
  });

  it("rejects expired sessions", async () => {
    const wallet = Wallet.createRandom();
    const { service, setNow } = fixture();
    const signed = await challenge(service, wallet);
    const verified = await service.verifyChallenge(signed.message, signed.signature);
    setNow("2026-08-22T12:00:01.000Z");
    await expect(service.authenticateSession(verified.sessionToken)).rejects.toThrow("AUTH_SESSION_INVALID");
  });
});
