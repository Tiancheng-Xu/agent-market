import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../../../../database/migrations/0016_l2_risk_context_reputation_v2.sql", import.meta.url),
);

describe("L2 risk context and Reputation V2 schema", () => {
  const sql = readFileSync(migrationPath, "utf8").toLowerCase();

  it("stores versioned risk context and authoritative runtime bindings", () => {
    expect(sql).toContain("create table if not exists task_risk_contexts");
    expect(sql).toContain("create unique index if not exists uq_task_risk_context_active");
    expect(sql).toContain("create table if not exists runtime_agent_bindings");
    expect(sql).toContain("create unique index if not exists uq_runtime_agent_binding_active");
  });

  it("stores immutable graph pricing facts and enforces exactly 10000 basis points", () => {
    expect(sql).toContain("create table if not exists task_graph_pricing_versions");
    expect(sql).toContain("create table if not exists task_graph_node_pricing_facts");
    expect(sql).toContain("expected_total_share_bps = 10000");
    expect(sql).toContain("task_graph_pricing_share_invalid");
    expect(sql).toContain("deferrable initially deferred");
  });

  it("requires every Reputation V2 field and supports multiple Agent orders per task", () => {
    expect(sql).toContain("create table if not exists reputation_v2_review_eligibilities");
    expect(sql).toContain("create table if not exists reputation_v2_reviews");
    expect(sql).toContain("communication_score numeric(7,6) not null");
    expect(sql).toContain("dispute_attribution text not null");
    expect(sql).toContain("order_value_atomic numeric(78,0) not null");
    expect(sql).toContain("unique (task_id, agent_id)");
    expect(sql).not.toMatch(/communication_score[^\n]*default|dispute_attribution[^\n]*default/);
  });

  it("does not store secrets or silently default missing authority data", () => {
    expect(sql).not.toMatch(/private_key|api_key|secret|credential/);
    expect(sql).not.toMatch(/declared_permissions[^\n]*default|duration_hours[^\n]*default|dependency_classes[^\n]*default/);
  });
});
