import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import { PostgresAuthStore, type StoredChallenge, type StoredSession } from "./auth-store";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const destructiveSentinel = "agent-market-ephemeral-only";
const requestId = "0191f6f8-cb6b-7f31-81ad-c497d7d90102";
const walletAddress = "0xaa11111111111111111111111111111111111111";

function migration(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../database/migrations/${name}`, import.meta.url)), "utf8")
    .replace(/^\s*BEGIN;\s*$/gimu, "")
    .replace(/^\s*COMMIT;\s*$/gimu, "");
}

function assertDedicatedLocalTestDatabase(value: string): void {
  const url = new URL(value);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (process.env.TEST_DATABASE_DESTRUCTIVE !== destructiveSentinel
    || !localHosts.has(url.hostname)
    || !/^agent_market_auth_test_[a-z0-9_]+$/u.test(databaseName)) {
    throw new Error("UNSAFE_TEST_DATABASE");
  }
}

function challenge(id: string, nonceHash: string, expiresAt = "2026-08-21T12:10:00.000Z"): StoredChallenge {
  return {
    challengeId: id,
    requestId,
    walletAddress,
    chainId: 11155111,
    nonceHash,
    domain: "agent-market.test",
    uri: "https://agent-market.test",
    statement: "Sign in to Agent Market. This request does not submit a transaction or reimburse gas.",
    issuedAt: "2026-08-21T12:00:00.000Z",
    expiresAt,
  };
}

function session(id: string, hash: string, sessionRequestId = requestId): StoredSession {
  return {
    sessionHash: hash,
    session: {
      sessionId: id,
      requestId: sessionRequestId,
      walletAddress,
      chainId: 11155111,
      issuedAt: "2026-08-21T12:01:00.000Z",
      expiresAt: "2026-08-22T12:01:00.000Z",
      recentAuthAt: "2026-08-21T12:01:00.000Z",
    },
  };
}

integration.sequential("PostgreSQL auth store", () => {
  it("enforces one concurrent winner, rollback, expiry, hash-only state, and revocation", async () => {
    assertDedicatedLocalTestDatabase(databaseUrl!);
    const sql = postgres(databaseUrl!, { max: 4, prepare: false });
    try {
      const core = migration("0001_agent_market_core.sql")
        .replace("CREATE EXTENSION IF NOT EXISTS vector;", "")
        .replace("embedding vector(384)", "embedding double precision[]");
      await sql.unsafe(core);
      await sql.unsafe(migration("0002_performance_observability.sql"));
      await sql.unsafe(migration("0003_phase2_lifecycle.sql"));
      const store = new PostgresAuthStore(sql);

      const nonceHash = "11".repeat(32);
      await store.createChallenge(challenge("0191f6f8-cb6b-7f31-81ad-c497d7d90101", nonceHash));
      const results = await Promise.all([
        store.consumeChallengeAndCreateSession({
          challengeId: "0191f6f8-cb6b-7f31-81ad-c497d7d90101", nonceHash,
          consumedAt: "2026-08-21T12:01:00.000Z", session: session("0191f6f8-cb6b-7f31-81ad-c497d7d90103", "22".repeat(32)),
        }),
        store.consumeChallengeAndCreateSession({
          challengeId: "0191f6f8-cb6b-7f31-81ad-c497d7d90101", nonceHash,
          consumedAt: "2026-08-21T12:01:00.000Z", session: session("0191f6f8-cb6b-7f31-81ad-c497d7d90104", "33".repeat(32)),
        }),
      ]);
      const activeHash = results[0] ? "22".repeat(32) : "33".repeat(32);
      expect([...results].sort()).toEqual([false, true]);

      const rollbackId = "0191f6f8-cb6b-7f31-81ad-c497d7d90105";
      const rollbackRequestId = "0191f6f8-cb6b-7f31-81ad-c497d7d90106";
      await store.createChallenge({ ...challenge(rollbackId, "44".repeat(32)), requestId: rollbackRequestId });
      await expect(store.consumeChallengeAndCreateSession({
        challengeId: rollbackId, nonceHash: "44".repeat(32), consumedAt: "2026-08-21T12:01:00.000Z",
        session: session("0191f6f8-cb6b-7f31-81ad-c497d7d90107", "55".repeat(32), requestId),
      })).rejects.toThrow();
      const afterRollback = await store.findChallenge(rollbackId);
      expect(afterRollback?.consumedAt).toBeUndefined();

      const expiredId = "0191f6f8-cb6b-7f31-81ad-c497d7d90108";
      const expiredRequestId = "0191f6f8-cb6b-7f31-81ad-c497d7d90109";
      await store.createChallenge({ ...challenge(expiredId, "66".repeat(32), "2026-08-21T12:02:00.000Z"), requestId: expiredRequestId });
      expect(await store.consumeChallengeAndCreateSession({
        challengeId: expiredId, nonceHash: "66".repeat(32), consumedAt: "2026-08-21T12:03:00.000Z",
        session: { ...session("0191f6f8-cb6b-7f31-81ad-c497d7d90110", "77".repeat(32), expiredRequestId) },
      })).toBe(false);

      expect(await store.findActiveSession(activeHash, "2026-08-21T12:02:00.000Z")).not.toBeNull();
      await store.revokeSession(activeHash, "2026-08-21T12:03:00.000Z");
      expect(await store.findActiveSession(activeHash, "2026-08-21T12:04:00.000Z")).toBeNull();
      const hashes = await sql<{ session_hash: string }[]>`SELECT encode(session_hash, 'hex') AS session_hash FROM agent_market.wallet_sessions`;
      expect(hashes.map((row) => row.session_hash)).not.toContain("raw-session-token");
    } finally {
      await sql.unsafe("DROP SCHEMA IF EXISTS agent_market CASCADE");
      await sql.end({ timeout: 5 });
    }
  }, 30_000);
});
