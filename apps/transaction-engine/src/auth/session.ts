import { randomBytes } from "node:crypto";

import { WalletSessionV1Schema, type WalletChallengeV1, type WalletSessionV1 } from "@agent-market/shared-contracts";
import { getAddress, verifyMessage } from "ethers";
import { v7 as uuidv7 } from "uuid";

import type { AuthStore } from "./auth-store";
import {
  formatChallengeMessage,
  hashSecret,
  issueChallenge,
  parseChallengeMessage,
  type ChallengeDependencies,
  type ChallengeRequestContext,
} from "./challenge";

export const AUTH_COOKIE_NAME = "__Host-agent_market_session";
export const RECENT_AUTH_WINDOW_MS = 5 * 60_000;

export class AuthError extends Error {
  constructor(readonly code: string, readonly status = 401) {
    super(code);
  }
}

export interface VerifiedWalletSession {
  session: WalletSessionV1;
  sessionToken: string;
}

export interface SessionDependencies extends ChallengeDependencies {
  sessionToken(): string;
}

const defaultDependencies: SessionDependencies = {
  now: () => new Date(),
  id: () => uuidv7(),
  nonce: () => randomBytes(24).toString("base64url"),
  sessionToken: () => randomBytes(32).toString("base64url"),
};

function sameChallenge(stored: Awaited<ReturnType<AuthStore["findChallenge"]>>, parsed: WalletChallengeV1): boolean {
  return stored !== null
    && stored.challengeId === parsed.challengeId
    && stored.requestId === parsed.requestId
    && stored.walletAddress === parsed.walletAddress
    && stored.chainId === parsed.chainId
    && stored.domain === parsed.domain
    && stored.uri === parsed.uri
    && stored.statement === parsed.statement
    && stored.issuedAt === parsed.issuedAt
    && stored.expiresAt === parsed.expiresAt
    && stored.nonceHash === hashSecret(parsed.nonce);
}

export class WalletAuthService {
  constructor(
    private readonly store: AuthStore,
    private readonly dependencies: SessionDependencies = defaultDependencies,
  ) {}

  async issueChallenge(address: string, context: ChallengeRequestContext): Promise<WalletChallengeV1> {
    return issueChallenge(this.store, address, context, this.dependencies);
  }

  async verifyChallenge(message: string, signature: string): Promise<VerifiedWalletSession> {
    let parsed: WalletChallengeV1;
    try {
      parsed = parseChallengeMessage(message);
    } catch {
      throw new AuthError("AUTH_CHALLENGE_MESSAGE_INVALID", 400);
    }
    const stored = await this.store.findChallenge(parsed.challengeId);
    if (!stored || !sameChallenge(stored, parsed) || formatChallengeMessage(parsed) !== message) {
      throw new AuthError("AUTH_CHALLENGE_MISMATCH");
    }
    if (stored.consumedAt) throw new AuthError("AUTH_CHALLENGE_CONSUMED");
    const now = this.dependencies.now();
    if (Date.parse(parsed.expiresAt) <= now.getTime()) throw new AuthError("AUTH_CHALLENGE_EXPIRED");
    let recovered: string;
    try {
      recovered = getAddress(verifyMessage(message, signature)).toLowerCase();
    } catch {
      throw new AuthError("AUTH_SIGNATURE_INVALID");
    }
    if (recovered !== parsed.walletAddress) throw new AuthError("AUTH_WALLET_MISMATCH");
    const sessionToken = this.dependencies.sessionToken();
    const session = WalletSessionV1Schema.parse({
      sessionId: this.dependencies.id(),
      requestId: parsed.requestId,
      walletAddress: parsed.walletAddress,
      chainId: parsed.chainId,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
      recentAuthAt: now.toISOString(),
    });
    const consumed = await this.store.consumeChallengeAndCreateSession({
      challengeId: parsed.challengeId,
      nonceHash: hashSecret(parsed.nonce),
      consumedAt: now.toISOString(),
      session: { session, sessionHash: hashSecret(sessionToken) },
    });
    if (!consumed) throw new AuthError("AUTH_CHALLENGE_CONSUMED");
    return { session, sessionToken };
  }

  async authenticateSession(sessionToken: string): Promise<WalletSessionV1> {
    const session = await this.store.findActiveSession(hashSecret(sessionToken), this.dependencies.now().toISOString());
    if (!session) throw new AuthError("AUTH_SESSION_INVALID");
    return session;
  }

  async revokeSession(sessionToken: string): Promise<void> {
    await this.store.revokeSession(hashSecret(sessionToken), this.dependencies.now().toISOString());
  }

  requireRecentAuth(session: WalletSessionV1): void {
    const age = this.dependencies.now().getTime() - Date.parse(session.recentAuthAt);
    if (!Number.isFinite(age) || age < 0 || age > RECENT_AUTH_WINDOW_MS) {
      throw new AuthError("AUTH_RECENT_REQUIRED", 403);
    }
  }
}

export function serializeSessionCookie(token: string, maxAgeSeconds = 24 * 60 * 60): string {
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export function readSessionCookie(headers: Headers): string | null {
  const cookies = headers.get("cookie")?.split(";") ?? [];
  for (const cookie of cookies) {
    const [name, ...value] = cookie.trim().split("=");
    if (name === AUTH_COOKIE_NAME) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}
