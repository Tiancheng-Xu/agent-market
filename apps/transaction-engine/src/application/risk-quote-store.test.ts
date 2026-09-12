import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import type { Sql, TransactionSql } from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import type { OrderCommand, OrderSnapshot, RiskQuote } from "@agent-market/shared-contracts";
import { MemoryOrderStore, OrderService } from "./order-service";
import {
  MemoryRiskQuoteStore,
  PostgresRiskQuoteStore,
  type IssueRiskQuoteInput,
} from "./risk-quote-store";

const publisher = "0x1111111111111111111111111111111111111111";
const agentA = "0x2222222222222222222222222222222222222222";
const agentB = "0x3333333333333333333333333333333333333333";
const taskId = "11111111-1111-4111-8111-111111111111";
const fingerprintA = `sha256:${"a".repeat(64)}`;
const fingerprintB = `sha256:${"b".repeat(64)}`;
const assetId = `eip155:11155111/erc20:0x${"5".repeat(40)}`;
const now = "2026-09-01T12:00:00.000Z";
const future = "2026-09-01T13:00:00.000Z";
const migrationSql = readFileSync(
  fileURLToPath(new URL("../../../../database/migrations/0015_l2_risk_pricing.sql", import.meta.url)),
  "utf8",
);

const quote = (overrides: Partial<RiskQuote> = {}): RiskQuote => ({
  schemaVersion: 2,
  assetId,
  phase: "preliminary",
  policyVersion: "risk-v1",
  taskFingerprint: fingerprintA,
  riskScore: 40,
  riskTier: "R2",
  depositRateBps: 1_000,
  serviceFeeBps: 600,
  manualReviewRequired: false,
  reasonCodes: ["task_complexity"],
  P: "1000",
  A: "100",
  B: "60",
  publisherTotal: "1160",
  agentTeamDeposit: "100",
  agentAllocations: [],
  expiresAt: future,
  ...overrides,
});

const preliminary = (overrides: Partial<IssueRiskQuoteInput> = {}): IssueRiskQuoteInput => ({
  taskId,
  publisherWallet: publisher,
  dagRevision: 0,
  assignments: [],
  quote: quote(),
  createdAt: now,
  ...overrides,
});

const finalQuote = (overrides: Partial<IssueRiskQuoteInput> = {}): IssueRiskQuoteInput => preliminary({
  dagRevision: 2,
  assignments: [
    { agentId: "agent-a", agentWallet: agentA },
    { agentId: "agent-b", agentWallet: agentB },
  ],
  quote: quote({
    phase: "final",
    agentAllocations: [
      { agentId: "agent-a", amountAtomic: "60" },
      { agentId: "agent-b", amountAtomic: "40" },
    ],
  }),
  ...overrides,
});

describe("MemoryRiskQuoteStore", () => {
  it("creates immutable versions and supersedes on task, DAG, assignment, or policy changes", async () => {
    const store = new MemoryRiskQuoteStore();
    const first = await store.issue(preliminary());
    const unchanged = await store.issue(preliminary());
    expect(unchanged.id).toBe(first.id);

    const changedTask = await store.issue(preliminary({
      quote: quote({ taskFingerprint: fingerprintB }),
    }));
    const changedDag = await store.issue(finalQuote());
    const changedAssignments = await store.issue(finalQuote({
      assignments: [{ agentId: "agent-a", agentWallet: agentA }],
      quote: quote({
        phase: "final",
        agentAllocations: [{ agentId: "agent-a", amountAtomic: "100" }],
      }),
    }));
    const changedPolicy = await store.issue(finalQuote({
      quote: quote({
        phase: "final",
        policyVersion: "risk-v2",
        agentAllocations: [
          { agentId: "agent-a", amountAtomic: "60" },
          { agentId: "agent-b", amountAtomic: "40" },
        ],
      }),
    }));

    expect([first.version, changedTask.version, changedDag.version, changedAssignments.version, changedPolicy.version])
      .toEqual([1, 2, 3, 4, 5]);
    expect((await store.find(first.id))?.status).toBe("superseded");
    expect((await store.find(changedPolicy.id))?.status).toBe("active");
  });

  it("requires only publisher acknowledgement for a current preliminary quote", async () => {
    const store = new MemoryRiskQuoteStore();
    const issued = await store.issue(preliminary());
    expect((await store.evaluatePreliminary({
      taskId,
      quoteId: issued.id,
      taskFingerprint: fingerprintA,
      evaluatedAt: now,
    })).code).toBe("RISK_QUOTE_PUBLISHER_CONFIRMATION_REQUIRED");

    await store.confirm({
      quoteId: issued.id,
      quoteHash: issued.basisFingerprint,
      actorType: "publisher",
      actorWallet: publisher,
      taskFingerprint: fingerprintA,
      confirmedAt: now,
    });
    expect((await store.evaluatePreliminary({
      taskId,
      quoteId: issued.id,
      taskFingerprint: fingerprintA,
      evaluatedAt: now,
    })).status).toBe("ready");
  });

  it("requires platform approval before an R5 preliminary quote can enter matching", async () => {
    const store = new MemoryRiskQuoteStore();
    const issued = await store.issue(preliminary({
      quote: quote({
        riskScore: 81,
        riskTier: "R5",
        depositRateBps: 4_000,
        manualReviewRequired: true,
        A: "400",
        publisherTotal: "1460",
        agentTeamDeposit: "400",
      }),
    }));
    await store.confirm({
      quoteId: issued.id,
      quoteHash: issued.basisFingerprint,
      actorType: "publisher",
      actorWallet: publisher,
      taskFingerprint: fingerprintA,
      confirmedAt: now,
    });
    expect((await store.evaluatePreliminary({
      taskId,
      quoteId: issued.id,
      taskFingerprint: fingerprintA,
      evaluatedAt: now,
    })).code).toBe("RISK_QUOTE_MANUAL_APPROVAL_REQUIRED");
    await store.approveManual({
      quoteId: issued.id,
      approvedAt: now,
      approvedBy: "operator:four-eyes",
      approverRole: "platform_operator",
    });
    expect((await store.evaluatePreliminary({
      taskId,
      quoteId: issued.id,
      taskFingerprint: fingerprintA,
      evaluatedAt: now,
    })).status).toBe("ready");
  });

  it("requires publisher and every unique assigned Agent on the same final quote", async () => {
    const store = new MemoryRiskQuoteStore();
    const issued = await store.issue(finalQuote());
    await store.confirm({ quoteId: issued.id, quoteHash: issued.basisFingerprint, actorType: "publisher", actorWallet: publisher, taskFingerprint: fingerprintA, confirmedAt: now });
    await store.confirm({ quoteId: issued.id, quoteHash: issued.basisFingerprint, actorType: "agent", actorWallet: agentA, agentId: "agent-a", taskFingerprint: fingerprintA, confirmedAt: now });
    expect((await store.evaluateFunding({ taskId, quoteId: issued.id, taskFingerprint: fingerprintA, evaluatedAt: now })).code)
      .toBe("RISK_QUOTE_AGENT_CONFIRMATIONS_REQUIRED");

    await store.confirm({ quoteId: issued.id, quoteHash: issued.basisFingerprint, actorType: "agent", actorWallet: agentB, agentId: "agent-b", taskFingerprint: fingerprintA, confirmedAt: now });
    expect((await store.evaluateFunding({ taskId, quoteId: issued.id, taskFingerprint: fingerprintA, evaluatedAt: now })).status)
      .toBe("ready");
    await expect(store.confirm({ quoteId: issued.id, quoteHash: issued.basisFingerprint, actorType: "agent", actorWallet: agentB, agentId: "agent-b", taskFingerprint: fingerprintA, confirmedAt: now }))
      .rejects.toThrow("RISK_QUOTE_CONFIRMATION_DUPLICATE");
  });

  it("routes expired/stale quotes to manual review and requires independent R5 approval", async () => {
    const store = new MemoryRiskQuoteStore();
    const issued = await store.issue(finalQuote({
      quote: quote({
        phase: "final",
        riskScore: 90,
        riskTier: "R5",
        depositRateBps: 4_000,
        manualReviewRequired: true,
        A: "400",
        publisherTotal: "1460",
        agentTeamDeposit: "400",
        agentAllocations: [
          { agentId: "agent-a", amountAtomic: "240" },
          { agentId: "agent-b", amountAtomic: "160" },
        ],
      }),
    }));
    expect((await store.evaluateFunding({ taskId, quoteId: issued.id, taskFingerprint: fingerprintB, evaluatedAt: now })).status)
      .toBe("manual_review");
    expect((await store.evaluateFunding({ taskId, quoteId: issued.id, taskFingerprint: fingerprintA, evaluatedAt: future })).status)
      .toBe("manual_review");
    await expect(store.approveManual({ quoteId: issued.id, approvedAt: now, approvedBy: "risk-assessor", approverRole: "risk_assessor" }))
      .rejects.toThrow("RISK_QUOTE_MANUAL_APPROVER_FORBIDDEN");
    await expect(store.approveManual({ quoteId: issued.id, approvedAt: now, approvedBy: agentA, approverRole: "agent" }))
      .rejects.toThrow("RISK_QUOTE_MANUAL_APPROVER_FORBIDDEN");
    await store.approveManual({ quoteId: issued.id, approvedAt: now, approvedBy: "operator:four-eyes", approverRole: "platform_operator" });
    expect((await store.find(issued.id))?.manualApprovedBy).toBe("operator:four-eyes");
  });
});

describe("OrderService risk quote gates", () => {
  const order: OrderSnapshot = {
    id: taskId,
    publisherWallet: publisher,
    agentId: null,
    agentWallet: null,
    title: "Verify the handoff",
    budgetAtomic: "1000",
    status: "open",
    version: 1,
    artifacts: [],
    reviewEligible: false,
    manualReview: null,
    updatedAt: now,
  };
  type CommandInput<T = OrderCommand> = T extends OrderCommand
    ? Omit<T, "requestId" | "idempotencyKey" | "occurredAt">
    : never;
  const command = <T extends CommandInput>(value: T): OrderCommand => ({
    ...value,
    requestId: crypto.randomUUID(),
    idempotencyKey: `risk-gate-${crypto.randomUUID()}`,
    occurredAt: now,
  }) as OrderCommand;

  it("gates matching on preliminary acknowledgement and funding on all final confirmations", async () => {
    const quotes = new MemoryRiskQuoteStore();
    const orders = new MemoryOrderStore([order]);
    const service = new OrderService(orders, quotes);
    const pre = await quotes.issue(preliminary());
    await expect(service.execute(taskId, command({ type: "start_matching", actorWallet: null, quoteId: pre.id, taskFingerprint: fingerprintA })))
      .rejects.toThrow("RISK_QUOTE_PUBLISHER_CONFIRMATION_REQUIRED");
    await quotes.confirm({ quoteId: pre.id, quoteHash: pre.basisFingerprint, actorType: "publisher", actorWallet: publisher, taskFingerprint: fingerprintA, confirmedAt: now });
    const matching = await service.execute(taskId, command({ type: "start_matching", actorWallet: null, quoteId: pre.id, taskFingerprint: fingerprintA }));
    expect(matching.snapshot.status).toBe("matching");

    const assigned = await service.execute(taskId, command({ type: "assign_agent", actorWallet: null, agentId: "33333333-3333-4333-8333-333333333333", agentWallet: agentA }));
    const final = await quotes.issue(finalQuote());
    await quotes.confirm({ quoteId: final.id, quoteHash: final.basisFingerprint, actorType: "publisher", actorWallet: publisher, taskFingerprint: fingerprintA, confirmedAt: now });
    await quotes.confirm({ quoteId: final.id, quoteHash: final.basisFingerprint, actorType: "agent", actorWallet: agentA, agentId: "agent-a", taskFingerprint: fingerprintA, confirmedAt: now });
    await quotes.confirm({ quoteId: final.id, quoteHash: final.basisFingerprint, actorType: "agent", actorWallet: agentB, agentId: "agent-b", taskFingerprint: fingerprintA, confirmedAt: now });
    const pending = await service.execute(taskId, command({ type: "mark_funding_pending", actorWallet: publisher, quoteId: final.id, taskFingerprint: fingerprintA }));
    expect([assigned.snapshot.status, pending.snapshot.status]).toEqual(["assigned", "funding_pending"]);
  });

  it("moves uncertain quote/funding state to manual review without initiating another payment", async () => {
    const quotes = new MemoryRiskQuoteStore();
    const assigned = { ...order, status: "assigned" as const, agentId: "33333333-3333-4333-8333-333333333333", agentWallet: agentA };
    const service = new OrderService(new MemoryOrderStore([assigned]), quotes);
    const final = await quotes.issue(finalQuote());
    const result = await service.execute(taskId, command({ type: "mark_funding_pending", actorWallet: publisher, quoteId: final.id, taskFingerprint: fingerprintB }));
    expect(result.snapshot).toMatchObject({ status: "manual_review", manualReview: { reasonCode: "risk_quote_fingerprint_mismatch" } });
    expect(result.event.action).toBe("mark_manual_review");
  });
});

describe("PostgresRiskQuoteStore SQL ordering", () => {
  it("declares the supersede foreign key as explicitly deferrable", () => {
    expect(migrationSql).toMatch(
      /CONSTRAINT fk_risk_quotes_superseded_by\s+FOREIGN KEY \(superseded_by\)[\s\S]*?DEFERRABLE INITIALLY IMMEDIATE/u,
    );
  });

  it("defers the supersede foreign key before replacing the active quote", async () => {
    const statements: string[] = [];
    const transaction = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join("?").replace(/\s+/gu, " ").trim();
        statements.push(statement);
        if (statement.startsWith("SELECT publisher_wallet")) return [{ publisher_wallet: publisher }];
        if (statement.startsWith("SELECT id, quote_version, basis_fingerprint")) {
          return [{
            id: "22222222-2222-4222-8222-222222222222",
            quote_version: 1,
            basis_fingerprint: `sha256:${"f".repeat(64)}`,
          }];
        }
        if (statement.startsWith("SELECT COALESCE(MAX(quote_version)")) return [{ next_version: 2 }];
        if (statement.startsWith("SELECT quote.*, task.publisher_wallet")) {
          return [{
            id: values[0],
            task_id: taskId,
            publisher_wallet: publisher,
            quote_version: 2,
            dag_revision: 0,
            quote_payload: quote({ taskFingerprint: fingerprintB }),
            basis_fingerprint: `sha256:${"e".repeat(64)}`,
            status: "active",
            superseded_by: null,
            superseded_at: null,
            manual_approved_at: null,
            manual_approved_by: null,
            created_at: now,
          }];
        }
        return [];
      },
      { json: (value: unknown) => value },
    );
    const sql = {
      begin: async (callback: (tx: TransactionSql) => Promise<unknown>) => callback(transaction as unknown as TransactionSql),
    } as unknown as Sql;
    const store = new PostgresRiskQuoteStore(sql);

    await store.issue(preliminary({ quote: quote({ taskFingerprint: fingerprintB }) }));

    const deferred = statements.findIndex((statement) => statement.startsWith("SET CONSTRAINTS agent_market.fk_risk_quotes_superseded_by DEFERRED"));
    const superseded = statements.findIndex((statement) => statement.startsWith("UPDATE agent_market.risk_quotes"));
    const inserted = statements.findIndex((statement) => statement.startsWith("INSERT INTO agent_market.risk_quotes"));
    expect([deferred, superseded, inserted]).toEqual([3, 4, 5]);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const sql = databaseUrl ? postgres(databaseUrl, { max: 1 }) : null;

function assertDedicatedLocalTestDatabase(value: string): void {
  const url = new URL(value);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)
    || !/^agent_market_risk_quote_test_[a-z0-9_]+$/u.test(databaseName)) {
    throw new Error("UNSAFE_TEST_DATABASE");
  }
}

describe.skipIf(!sql)("PostgresRiskQuoteStore integration (requires TEST_DATABASE_URL)", () => {
  afterAll(async () => { await sql?.end(); });
  it("atomically requotes with one active version and fresh confirmations", async () => {
    assertDedicatedLocalTestDatabase(databaseUrl!);
    const fixtureTaskId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const store = new PostgresRiskQuoteStore(sql!);
    await sql!`
      INSERT INTO agent_market.tasks (
        id, publisher_wallet, title, description, requirements,
        budget_atomic, status, request_id
      ) VALUES (
        ${fixtureTaskId}, ${publisher}, 'Risk quote integration fixture',
        'Verifies atomic supersede ordering', ARRAY[]::text[],
        1000, 'open', ${requestId}
      )
    `;
    try {
      const first = await store.issue(preliminary({ taskId: fixtureTaskId }));
      await store.confirm({
        quoteId: first.id,
        quoteHash: first.basisFingerprint,
        actorType: "publisher",
        actorWallet: publisher,
        taskFingerprint: fingerprintA,
        confirmedAt: now,
      });
      const second = await store.issue(preliminary({
        taskId: fixtureTaskId,
        quote: quote({ taskFingerprint: fingerprintB, expiresAt: "2026-09-01T14:00:00.000Z" }),
        createdAt: "2026-09-01T12:05:00.000Z",
      }));

      const versions = await sql!<{
        id: string;
        quote_version: number;
        status: string;
        superseded_by: string | null;
      }[]>`
        SELECT id::text, quote_version, status, superseded_by::text
        FROM agent_market.risk_quotes
        WHERE task_id = ${fixtureTaskId}
        ORDER BY quote_version
      `;
      expect(versions).toEqual([
        { id: first.id, quote_version: 1, status: "superseded", superseded_by: second.id },
        { id: second.id, quote_version: 2, status: "active", superseded_by: null },
      ]);
      expect(await store.evaluatePreliminary({
        taskId: fixtureTaskId,
        quoteId: second.id,
        taskFingerprint: fingerprintB,
        evaluatedAt: "2026-09-01T12:06:00.000Z",
      })).toMatchObject({ status: "blocked", code: "RISK_QUOTE_PUBLISHER_CONFIRMATION_REQUIRED" });
    } finally {
      await sql!`DELETE FROM agent_market.tasks WHERE id = ${fixtureTaskId}`;
    }
  });
});
