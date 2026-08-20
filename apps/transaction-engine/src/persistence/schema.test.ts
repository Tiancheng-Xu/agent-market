import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../../../../database/migrations/0001_agent_market_core.sql", import.meta.url),
);

describe("PostgreSQL core schema", () => {
  const sql = readFileSync(migrationPath, "utf8").toLowerCase();

  it("enables pgvector and defines the core marketplace records", () => {
    expect(sql).toContain("create extension if not exists vector");
    expect(sql).toContain("create table agents");
    expect(sql).toContain("create table agent_credentials");
    expect(sql).toContain("create table tasks");
    expect(sql).toContain("create table task_events");
    expect(sql).toContain("create table outbox_events");
  });

  it("stores only encrypted credential envelope fields", () => {
    expect(sql).toContain("ciphertext bytea not null");
    expect(sql).toContain("authentication_tag bytea not null");
    expect(sql).toContain("key_reference text not null");
    expect(sql).not.toMatch(/credential_plaintext|plaintext_secret|api_key\s+text/);
  });

  it("enforces request idempotency and pending outbox lookup", () => {
    expect(sql).toMatch(/request_id\s+uuid\s+not null\s+unique/);
    expect(sql).toContain("unique (task_id, request_id)");
    expect(sql).toContain("idx_outbox_events_pending");
  });
});
