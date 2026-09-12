import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

function migration(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../database/migrations/${name}`, import.meta.url)), "utf8");
}

describe("V3 arbitration review migration", () => {
  it("stores one current review identity and complete resolution expectations", async () => {
    const database = new PGlite();
    const core = migration("0001_agent_market_core.sql").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace("embedding vector(384)", "embedding text");
    await database.exec(core);
    for (const name of ["0003_phase2_lifecycle.sql", "0004_chain_reconciliation.sql", "0008_chain_account_resources.sql", "0009_v3_workflow_transactions.sql", "0025_v3_arbitration_reviews.sql"]) await database.exec(migration(name));

    const columns = await database.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'agent_market' AND table_name = 'chain_arbitration_reviews'`);
    expect(columns.rows.map(row => row.column_name)).toEqual(expect.arrayContaining([
      "resource_id", "resource_revision", "reviewer_wallet", "outcome", "args", "review_hash", "expires_at", "superseded_at",
    ]));
    const transactionColumns = await database.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'agent_market' AND table_name = 'chain_transactions'`);
    expect(transactionColumns.rows.map(row => row.column_name)).toEqual(expect.arrayContaining([
      "expected_resource_revision", "expected_review_id", "expected_review_hash", "expected_review_expires_at",
    ]));
    await database.close();
  });
});
