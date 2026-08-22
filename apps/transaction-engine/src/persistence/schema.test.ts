import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../../../../database/migrations/0001_agent_market_core.sql", import.meta.url),
);
const phase2MigrationPath = fileURLToPath(
  new URL("../../../../database/migrations/0003_phase2_lifecycle.sql", import.meta.url),
);
const reconciliationMigrationPath = fileURLToPath(
  new URL("../../../../database/migrations/0004_chain_reconciliation.sql", import.meta.url),
);

describe("PostgreSQL core schema", () => {
  const sql = readFileSync(migrationPath, "utf8").toLowerCase();
  const phase2Sql = readFileSync(phase2MigrationPath, "utf8").toLowerCase();
  const reconciliationSql = readFileSync(reconciliationMigrationPath, "utf8").toLowerCase();

  it("enables pgvector and defines the core marketplace records", () => {
    expect(sql).toContain("create extension if not exists vector");
    expect(sql).toContain("create table agents");
    expect(sql).toContain("create table agent_credentials");
    expect(sql).toContain("create table tasks");
    expect(sql).toContain("create table task_events");
    expect(sql).toContain("create table outbox_events");
  });

  it("adds idempotent chain reconciliation and public event projection fields", () => {
    expect(reconciliationSql).toContain("add column if not exists call_data");
    expect(reconciliationSql).toContain("add column if not exists expires_at");
    expect(reconciliationSql).toContain("add column if not exists block_hash");
    expect(reconciliationSql).toContain("add column if not exists event_name");
    expect(reconciliationSql).toContain("add column if not exists event_request_ref");
    expect(reconciliationSql).toContain("idx_chain_transactions_hash_status");
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

  it("adds wallet, transaction, matching, model, and replay lifecycle records", () => {
    expect(phase2Sql).toContain("create table if not exists wallet_challenges");
    expect(phase2Sql).toContain("create table if not exists wallet_sessions");
    expect(phase2Sql).toContain("create table if not exists idempotency_records");
    expect(phase2Sql).toContain("create table if not exists chain_transactions");
    expect(phase2Sql).toContain("create table if not exists consumed_events");
    expect(phase2Sql).toContain("create table if not exists match_candidates");
    expect(phase2Sql).toContain("create table if not exists match_feedback");
    expect(phase2Sql).toContain("create table if not exists model_versions");
    expect(phase2Sql).toContain("create table if not exists dlq_replay_audits");
  });

  it("keeps Sepolia and replay identities unique without plaintext credentials", () => {
    expect(phase2Sql).toContain("check (chain_id = 11155111)");
    expect(phase2Sql).toContain("unique (actor_wallet, command, resource_id, idempotency_key)");
    expect(phase2Sql).toContain("unique (original_event_id, idempotency_key)");
    expect(phase2Sql).toContain("unique (request_id, wallet_address, chain_id)");
    expect(phase2Sql).toContain("primary key (consumer, event_id)");
    expect(phase2Sql).toContain("status != 'confirmed'");
    expect(phase2Sql).toContain("expected_value_atomic >= 0");
    expect(phase2Sql).toContain("create table if not exists wallet_challenges");
    expect(phase2Sql).toContain("add column if not exists key_version");
    expect(sql).toContain("ciphertext");
    expect(phase2Sql).not.toMatch(/credential_plaintext|plaintext_secret|api_key\s+text/);
  });
});
