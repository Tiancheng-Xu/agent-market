import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";

import { applyOrderCommand, type OrderSnapshot } from "@agent-market/shared-contracts";
import { orderSnapshotFromDatabase, PostgresOrderStore } from "./postgres-order-store.js";

const publisher = "0x1111111111111111111111111111111111111111";
const primaryAgentId = "22222222-2222-4222-8222-222222222222";
const secondaryAgentId = "33333333-3333-4333-8333-333333333333";

function recordingSql(assignments: Array<Record<string, unknown>>) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  let begins = 0;
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    queries.push({ text, values });
    if (text.includes("SELECT version")) return [{ version: 4 }];
    if (text.includes("SELECT payload_fingerprint")) return [];
    if (text.includes("UPDATE agent_market.tasks")) return [{ id: "11111111-1111-4111-8111-111111111111" }];
    if (text.includes("task_graph_node_pricing_facts")) return assignments;
    return [];
  }) as unknown as Sql;
  Object.assign(tag, {
    begin: async (callback: (transaction: Sql) => Promise<unknown>) => {
      begins += 1;
      return callback(tag);
    },
    json: (value: unknown) => value,
  });
  return { sql: tag, queries, begins: () => begins };
}

const submittedOrder: OrderSnapshot = {
  id: "11111111-1111-4111-8111-111111111111",
  publisherWallet: publisher,
  agentId: primaryAgentId,
  agentWallet: "0x2222222222222222222222222222222222222222",
  title: "Accept Team delivery",
  budgetAtomic: "1000",
  status: "submitted",
  version: 4,
  artifacts: [{
    id: "44444444-4444-4444-8444-444444444444",
    uri: "https://example.com/team-delivery.json",
    contentHash: `sha256:${"b".repeat(64)}`,
    mediaType: "application/json",
    sizeBytes: 128,
    submittedAt: "2026-09-01T11:59:00.000Z",
  }],
  reviewEligible: false,
  manualReview: null,
  updatedAt: "2026-09-01T12:00:00.000Z",
};

const accepted = () => applyOrderCommand(submittedOrder, {
  type: "accept_delivery",
  requestId: "55555555-5555-4555-8555-555555555555",
  idempotencyKey: "accept-team-delivery",
  actorWallet: publisher,
  occurredAt: "2026-09-01T12:01:00.000Z",
});

describe("orderSnapshotFromDatabase", () => {
  it("maps the exact agent id, artifacts, and manual-review context", () => {
    const snapshot = orderSnapshotFromDatabase({
      id: "11111111-1111-4111-8111-111111111111",
      publisher_wallet: "0x1111111111111111111111111111111111111111",
      agent_id: "22222222-2222-4222-8222-222222222222",
      agent_wallet: "0x2222222222222222222222222222222222222222",
      title: "Review release evidence",
      budget_atomic: "1000",
      status: "manual_review",
      version: 4,
      manual_review_from_status: "submitted",
      manual_review_reason_code: "CHAIN_CONFIRMATION_UNKNOWN",
      updated_at: new Date("2026-08-31T12:00:00.000Z"),
      review_eligible: false,
      artifacts: [{
        id: "33333333-3333-4333-8333-333333333333",
        uri: "https://example.com/evidence.json",
        content_hash: `sha256:${"a".repeat(64)}`,
        media_type: "application/json",
        size_bytes: 512,
        submitted_at: "2026-08-31T11:59:00.000Z",
      }],
    });

    expect(snapshot.agentId).toBe("22222222-2222-4222-8222-222222222222");
    expect(snapshot.artifacts[0]?.contentHash).toBe(`sha256:${"a".repeat(64)}`);
    expect(snapshot.manualReview).toEqual({
      previousStatus: "submitted",
      reasonCode: "CHAIN_CONFIRMATION_UNKNOWN",
      openedAt: "2026-08-31T12:00:00.000Z",
    });
  });

  it("creates one Reputation V2 eligibility per authoritative Team agent without legacy duplication", async () => {
    const database = recordingSql([
      { market_agent_id: primaryAgentId, runtime_agent_id: "runtime-primary", fact_binding_id: "66666666-6666-4666-8666-666666666666", binding_id: "66666666-6666-4666-8666-666666666666", binding_runtime_agent_id: "runtime-primary", binding_market_agent_id: primaryAgentId, binding_status: "active", agent_owner_wallet: "0x2222222222222222222222222222222222222222", agent_status: "published" },
      { market_agent_id: primaryAgentId, runtime_agent_id: "runtime-primary", fact_binding_id: "66666666-6666-4666-8666-666666666666", binding_id: "66666666-6666-4666-8666-666666666666", binding_runtime_agent_id: "runtime-primary", binding_market_agent_id: primaryAgentId, binding_status: "active", agent_owner_wallet: "0x2222222222222222222222222222222222222222", agent_status: "published" },
      { market_agent_id: secondaryAgentId, runtime_agent_id: "runtime-secondary", fact_binding_id: "77777777-7777-4777-8777-777777777777", binding_id: "77777777-7777-4777-8777-777777777777", binding_runtime_agent_id: "runtime-secondary", binding_market_agent_id: secondaryAgentId, binding_status: "active", agent_owner_wallet: "0x3333333333333333333333333333333333333333", agent_status: "published" },
    ]);
    const result = accepted();

    await new PostgresOrderStore(database.sql).commit({
      expectedVersion: submittedOrder.version,
      fingerprint: "team-accept-fingerprint",
      idempotencyKey: "accept-team-delivery",
      ...result,
    });

    const inserts = database.queries.filter((query) => query.text.includes("INSERT INTO agent_market.reputation_v2_review_eligibilities"));
    expect(database.begins()).toBe(1);
    expect(inserts).toHaveLength(2);
    expect(inserts.flatMap((query) => query.values)).toEqual(expect.arrayContaining([primaryAgentId, secondaryAgentId]));
  });

  it("creates one legacy-Agent Reputation V2 eligibility when no Team assignment exists", async () => {
    const database = recordingSql([]);
    const result = accepted();

    await new PostgresOrderStore(database.sql).commit({
      expectedVersion: submittedOrder.version,
      fingerprint: "legacy-accept-fingerprint",
      idempotencyKey: "accept-team-delivery",
      ...result,
    });

    const inserts = database.queries.filter((query) => query.text.includes("INSERT INTO agent_market.reputation_v2_review_eligibilities"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.values).toContain(primaryAgentId);
  });
});
