import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

function migration(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../database/migrations/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("PostgreSQL phase 2 migration", () => {
  it("upgrades the V1 schema and can be safely applied again", async () => {
    const database = new PGlite();
    const pgliteCore = migration("0001_agent_market_core.sql")
      .replace("CREATE EXTENSION IF NOT EXISTS vector;", "")
      .replace("embedding vector(384)", "embedding text");
    await database.exec(pgliteCore);
    await database.exec(migration("0002_performance_observability.sql"));
    await database.exec(migration("0003_phase2_lifecycle.sql"));
    await database.exec(migration("0003_phase2_lifecycle.sql"));
    await database.exec(migration("0004_chain_reconciliation.sql"));
    await database.exec(migration("0004_chain_reconciliation.sql"));

    const tables = await database.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'agent_market'
      ORDER BY table_name
    `);
    const names = tables.rows.map(({ table_name }) => table_name);
    expect(names).toContain("wallet_challenges");
    expect(names).toContain("wallet_sessions");
    expect(names).toContain("chain_transactions");
    expect(names).toContain("model_versions");

    await expect(database.exec(`
      INSERT INTO agent_market.wallet_challenges (
        id, request_id, wallet_address, chain_id, nonce_hash,
        domain, uri, issued_at, expires_at
      ) VALUES (
        '0191f6f8-cb6b-7f31-81ad-c497d7d90101',
        '0191f6f8-cb6b-7f31-81ad-c497d7d90102',
        '0xAA11111111111111111111111111111111111111',
        11155111, decode('12', 'hex'), 'example.test', 'https://example.test',
        now(), now() + interval '5 minutes'
      )
    `)).rejects.toThrow();

    await database.close();
  });
});
