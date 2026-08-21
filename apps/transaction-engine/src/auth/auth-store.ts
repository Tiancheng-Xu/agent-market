import { SEPOLIA_CHAIN_ID, type WalletChallengeV1, type WalletSessionV1 } from "@agent-market/shared-contracts";
import postgres from "postgres";

export type StoredChallenge = Omit<WalletChallengeV1, "nonce"> & {
  nonceHash: string;
  consumedAt?: string;
};

export interface StoredSession {
  session: WalletSessionV1;
  sessionHash: string;
  revokedAt?: string;
}

export interface ConsumeChallengeInput {
  challengeId: string;
  nonceHash: string;
  consumedAt: string;
  session: StoredSession;
}

export interface AuthStore {
  createChallenge(challenge: StoredChallenge): Promise<void>;
  findChallenge(challengeId: string): Promise<StoredChallenge | null>;
  consumeChallengeAndCreateSession(input: ConsumeChallengeInput): Promise<boolean>;
  findActiveSession(sessionHash: string, now: string): Promise<WalletSessionV1 | null>;
  revokeSession(sessionHash: string, revokedAt: string): Promise<void>;
}

export class MemoryAuthStore implements AuthStore {
  private readonly challenges = new Map<string, StoredChallenge>();
  private readonly sessions = new Map<string, StoredSession>();

  async createChallenge(challenge: StoredChallenge): Promise<void> {
    if (this.challenges.has(challenge.challengeId)) throw new Error("AUTH_CHALLENGE_CONFLICT");
    this.challenges.set(challenge.challengeId, { ...challenge });
  }

  async findChallenge(challengeId: string): Promise<StoredChallenge | null> {
    const challenge = this.challenges.get(challengeId);
    return challenge ? { ...challenge } : null;
  }

  async consumeChallengeAndCreateSession(input: ConsumeChallengeInput): Promise<boolean> {
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge || challenge.consumedAt || challenge.nonceHash !== input.nonceHash) return false;
    challenge.consumedAt = input.consumedAt;
    this.sessions.set(input.session.sessionHash, {
      session: { ...input.session.session },
      sessionHash: input.session.sessionHash,
    });
    return true;
  }

  async findActiveSession(sessionHash: string, now: string): Promise<WalletSessionV1 | null> {
    const record = this.sessions.get(sessionHash);
    if (!record || record.revokedAt || record.session.expiresAt <= now) return null;
    return { ...record.session };
  }

  async revokeSession(sessionHash: string, revokedAt: string): Promise<void> {
    const record = this.sessions.get(sessionHash);
    if (record && !record.revokedAt) record.revokedAt = revokedAt;
  }
}

type PostgresClient = ReturnType<typeof postgres>;

interface ChallengeRow {
  id: string;
  request_id: string;
  wallet_address: string;
  chain_id: string | number;
  nonce_hash: string;
  domain: string;
  uri: string;
  issued_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
}

interface SessionRow {
  id: string;
  request_id: string;
  wallet_address: string;
  chain_id: string | number;
  issued_at: Date | string;
  expires_at: Date | string;
  recent_auth_at: Date | string;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

export function parsePersistedChainId(value: string | number): typeof SEPOLIA_CHAIN_ID {
  if (Number(value) !== SEPOLIA_CHAIN_ID) throw new Error("AUTH_PERSISTED_CHAIN_INVALID");
  return SEPOLIA_CHAIN_ID;
}

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly sql: PostgresClient) {}

  static connect(databaseUrl: string): PostgresAuthStore {
    return new PostgresAuthStore(postgres(databaseUrl, {
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    }));
  }

  async createChallenge(challenge: StoredChallenge): Promise<void> {
    await this.sql`
      INSERT INTO agent_market.wallet_challenges (
        id, request_id, wallet_address, chain_id, nonce_hash,
        domain, uri, issued_at, expires_at
      ) VALUES (
        ${challenge.challengeId}::uuid,
        ${challenge.requestId}::uuid,
        ${challenge.walletAddress},
        ${challenge.chainId},
        ${Buffer.from(challenge.nonceHash, "hex")},
        ${challenge.domain},
        ${challenge.uri},
        ${challenge.issuedAt}::timestamptz,
        ${challenge.expiresAt}::timestamptz
      )
    `;
  }

  async findChallenge(challengeId: string): Promise<StoredChallenge | null> {
    const rows = await this.sql<ChallengeRow[]>`
      SELECT id, request_id, wallet_address, chain_id,
             encode(nonce_hash, 'hex') AS nonce_hash,
             domain, uri, issued_at, expires_at, consumed_at
      FROM agent_market.wallet_challenges
      WHERE id = ${challengeId}::uuid
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      challengeId: row.id,
      requestId: row.request_id,
      walletAddress: row.wallet_address,
      chainId: parsePersistedChainId(row.chain_id),
      domain: row.domain,
      uri: row.uri,
      statement: "Sign in to Agent Market. This request does not submit a transaction or reimburse gas.",
      issuedAt: iso(row.issued_at),
      expiresAt: iso(row.expires_at),
      nonceHash: row.nonce_hash,
      ...(row.consumed_at ? { consumedAt: iso(row.consumed_at) } : {}),
    };
  }

  async consumeChallengeAndCreateSession(input: ConsumeChallengeInput): Promise<boolean> {
    return this.sql.begin(async (transaction) => {
      const consumed = await transaction`
        UPDATE agent_market.wallet_challenges
        SET consumed_at = ${input.consumedAt}::timestamptz
        WHERE id = ${input.challengeId}::uuid
          AND consumed_at IS NULL
          AND nonce_hash = ${Buffer.from(input.nonceHash, "hex")}
          AND expires_at > ${input.consumedAt}::timestamptz
        RETURNING id
      `;
      if (consumed.length !== 1) return false;
      const { session } = input.session;
      await transaction`
        INSERT INTO agent_market.wallet_sessions (
          id, request_id, wallet_address, chain_id, session_hash,
          issued_at, expires_at, recent_auth_at
        ) VALUES (
          ${session.sessionId}::uuid,
          ${session.requestId}::uuid,
          ${session.walletAddress},
          ${session.chainId},
          ${Buffer.from(input.session.sessionHash, "hex")},
          ${session.issuedAt}::timestamptz,
          ${session.expiresAt}::timestamptz,
          ${session.recentAuthAt}::timestamptz
        )
      `;
      return true;
    });
  }

  async findActiveSession(sessionHash: string, now: string): Promise<WalletSessionV1 | null> {
    const rows = await this.sql<SessionRow[]>`
      SELECT id, request_id, wallet_address, chain_id, issued_at, expires_at, recent_auth_at
      FROM agent_market.wallet_sessions
      WHERE session_hash = ${Buffer.from(sessionHash, "hex")}
        AND revoked_at IS NULL
        AND expires_at > ${now}::timestamptz
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      sessionId: row.id,
      requestId: row.request_id,
      walletAddress: row.wallet_address,
      chainId: parsePersistedChainId(row.chain_id),
      issuedAt: iso(row.issued_at),
      expiresAt: iso(row.expires_at),
      recentAuthAt: iso(row.recent_auth_at),
    };
  }

  async revokeSession(sessionHash: string, revokedAt: string): Promise<void> {
    await this.sql`
      UPDATE agent_market.wallet_sessions
      SET revoked_at = COALESCE(revoked_at, ${revokedAt}::timestamptz)
      WHERE session_hash = ${Buffer.from(sessionHash, "hex")}
    `;
  }
}
