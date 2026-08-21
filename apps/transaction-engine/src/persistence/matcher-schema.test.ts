import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const sql = readFileSync(fileURLToPath(
  new URL("../../../../database/migrations/0005_matcher_profile.sql", import.meta.url),
), "utf8").toLowerCase();

describe("matcher profile schema", () => {
  it("adds task embeddings, bounded agent features, and a partial HNSW recall index", () => {
    expect(sql).toContain("add column if not exists embedding vector(384)");
    expect(sql).toContain("add column if not exists available boolean");
    expect(sql).toContain("add column if not exists minimum_budget_atomic");
    expect(sql).toContain("quality_score between 0 and 1");
    expect(sql).toContain("reliability_score between 0 and 1");
    expect(sql).toContain("price_score between 0 and 1");
    expect(sql).toContain("freshness_score between 0 and 1");
    expect(sql).toContain("using hnsw (embedding vector_cosine_ops)");
  });

  it("keeps database task states aligned with the phase 2 domain lifecycle", () => {
    for (const status of ["funding_pending", "funded", "disputed", "settled", "refunded"]) {
      expect(sql).toContain(`'${status}'`);
    }
  });
});
