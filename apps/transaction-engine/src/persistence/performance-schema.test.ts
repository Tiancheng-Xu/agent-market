import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../../../../database/migrations/0002_performance_observability.sql", import.meta.url),
);
const renderMigrationPath = fileURLToPath(
  new URL("../../../../database/migrations/0010_performance_render_observability.sql", import.meta.url),
);

describe("performance observability schema", () => {
  const sql = readFileSync(migrationPath, "utf8").toLowerCase();

  it("persists one idempotent sample per request and aggregate run evidence", () => {
    expect(sql).toContain("create table performance_samples");
    expect(sql).toMatch(/request_id\s+uuid\s+not null\s+unique/);
    expect(sql).toContain("create table performance_runs");
    expect(sql).toContain("p50_lcp_ms");
    expect(sql).toContain("p75_lcp_ms");
    expect(sql).toContain("p95_lcp_ms");
    expect(sql).toContain("error_rate");
  });

  it("does not create fields for identity or raw navigation URLs", () => {
    expect(sql).not.toMatch(/wallet|cookie|authorization|query_string|full_url/);
  });

  it("adds bounded frame and hydration observability without identity fields", () => {
    expect(existsSync(renderMigrationPath)).toBe(true);
    if (!existsSync(renderMigrationPath)) return;
    const renderSql = readFileSync(renderMigrationPath, "utf8").toLowerCase();
    expect(renderSql).toContain("fps");
    expect(renderSql).toContain("dropped_frame_ratio");
    expect(renderSql).toContain("hydration_duration_ms");
    expect(renderSql).toContain("render_outcome");
    expect(renderSql).not.toMatch(/wallet|cookie|authorization|query_string|full_url|user_agent|ip_address/);
  });
});
