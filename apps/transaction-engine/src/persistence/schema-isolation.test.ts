import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migration = (name: string) => readFileSync(fileURLToPath(
  new URL(`../../../../database/migrations/${name}`, import.meta.url),
), "utf8").toLowerCase();

describe("shared PostgreSQL isolation", () => {
  it("creates and selects the Agent Market schema before core tables", () => {
    const sql = migration("0001_agent_market_core.sql");
    expect(sql).toContain("create schema if not exists agent_market");
    expect(sql.indexOf("set local search_path to agent_market, public"))
      .toBeLessThan(sql.indexOf("create table agents"));
  });

  it("selects the Agent Market schema before performance tables", () => {
    const sql = migration("0002_performance_observability.sql");
    expect(sql).toContain("create schema if not exists agent_market");
    expect(sql).toContain("set local search_path to agent_market, public");
    expect(sql.indexOf("set local search_path to agent_market, public"))
      .toBeLessThan(sql.indexOf("create table performance_samples"));
  });
});
