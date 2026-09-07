import { randomUUID } from "node:crypto";

import {
  OrderEventSchema,
  OrderSnapshotSchema,
  type OrderEvent,
  type OrderSnapshot,
} from "@agent-market/shared-contracts";
import type { Sql } from "postgres";

import type { OrderStore, StoredOrderResult } from "./order-service.js";

type DatabaseRow = Record<string, unknown>;

const iso = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  throw new Error("ORDER_DATABASE_TIMESTAMP_INVALID");
};

const artifactFromRow = (value: unknown) => {
  const row = value as DatabaseRow;
  return {
    id: String(row.id),
    uri: String(row.uri),
    contentHash: String(row.content_hash),
    mediaType: String(row.media_type),
    sizeBytes: Number(row.size_bytes),
    submittedAt: iso(row.submitted_at),
  };
};

export function orderSnapshotFromDatabase(row: DatabaseRow): OrderSnapshot {
  const updatedAt = iso(row.updated_at);
  const artifacts = Array.isArray(row.artifacts) ? row.artifacts.map(artifactFromRow) : [];
  const manualReview = row.status === "manual_review"
    ? {
        previousStatus: String(row.manual_review_from_status),
        reasonCode: String(row.manual_review_reason_code),
        openedAt: updatedAt,
      }
    : null;

  return OrderSnapshotSchema.parse({
    id: row.id,
    publisherWallet: row.publisher_wallet,
    agentId: row.agent_id ?? null,
    agentWallet: row.agent_wallet ?? null,
    title: row.title,
    budgetAtomic: String(row.budget_atomic),
    status: row.status,
    version: Number(row.version),
    artifacts,
    reviewEligible: Boolean(row.review_eligible),
    manualReview,
    updatedAt,
  });
}

export class PostgresOrderStore implements OrderStore {
  constructor(private readonly sql: Sql) {}

  async find(orderId: string): Promise<OrderSnapshot | null> {
    const rows = await this.sql<DatabaseRow[]>`
      SELECT
        task.id,
        task.publisher_wallet,
        task.agent_id,
        agent.owner_wallet AS agent_wallet,
        task.title,
        task.budget_atomic::text AS budget_atomic,
        task.status,
        task.version,
        task.manual_review_from_status,
        task.manual_review_reason_code,
        task.updated_at,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'id', artifact.id,
              'uri', artifact.uri,
              'content_hash', artifact.content_hash,
              'media_type', artifact.media_type,
              'size_bytes', artifact.size_bytes,
              'submitted_at', artifact.submitted_at
            ) ORDER BY artifact.submitted_at
          ) FILTER (WHERE artifact.id IS NOT NULL),
          '[]'::jsonb
        ) AS artifacts,
        EXISTS (
          SELECT 1
          FROM agent_market.order_review_eligibilities eligibility
          WHERE eligibility.task_id = task.id
            AND eligibility.status = 'available'
        ) AS review_eligible
      FROM agent_market.tasks task
      LEFT JOIN agent_market.agents agent ON agent.id = task.agent_id
      LEFT JOIN agent_market.order_artifacts artifact ON artifact.task_id = task.id
      WHERE task.id = ${orderId}
      GROUP BY task.id, agent.owner_wallet
    `;
    return rows[0] ? orderSnapshotFromDatabase(rows[0]) : null;
  }

  async findResult(orderId: string, idempotencyKey: string): Promise<StoredOrderResult | null> {
    const rows = await this.sql<DatabaseRow[]>`
      SELECT payload_fingerprint, response_snapshot, response_event
      FROM agent_market.order_action_idempotency
      WHERE task_id = ${orderId}
        AND idempotency_key = ${idempotencyKey}
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      fingerprint: String(row.payload_fingerprint),
      snapshot: OrderSnapshotSchema.parse(row.response_snapshot),
      event: OrderEventSchema.parse(row.response_event),
    };
  }

  async commit(input: {
    expectedVersion: number;
    fingerprint: string;
    idempotencyKey: string;
    snapshot: OrderSnapshot;
    event: OrderEvent;
  }): Promise<void> {
    const snapshot = OrderSnapshotSchema.parse(input.snapshot);
    const event = OrderEventSchema.parse(input.event);

    await this.sql.begin(async (transaction) => {
      const currentRows = await transaction<DatabaseRow[]>`
        SELECT version
        FROM agent_market.tasks
        WHERE id = ${snapshot.id}
        FOR UPDATE
      `;
      const current = currentRows[0];
      if (!current) throw new Error("ORDER_NOT_FOUND");

      const idempotencyRows = await transaction<DatabaseRow[]>`
        SELECT payload_fingerprint
        FROM agent_market.order_action_idempotency
        WHERE task_id = ${snapshot.id}
          AND idempotency_key = ${input.idempotencyKey}
      `;
      const existing = idempotencyRows[0];
      if (existing) {
        if (existing.payload_fingerprint !== input.fingerprint) throw new Error("ORDER_IDEMPOTENCY_CONFLICT");
        return;
      }
      if (Number(current.version) !== input.expectedVersion) throw new Error("ORDER_VERSION_CONFLICT");

      const latestArtifact = snapshot.artifacts.at(-1) ?? null;
      const updated = await transaction<DatabaseRow[]>`
        UPDATE agent_market.tasks
        SET
          status = ${snapshot.status},
          agent_id = ${snapshot.agentId},
          delivery_uri = COALESCE(${latestArtifact?.uri ?? null}, delivery_uri),
          accepted_at = CASE
            WHEN ${event.action} = 'accept_delivery' THEN ${event.occurredAt}::timestamptz
            ELSE accepted_at
          END,
          manual_review_from_status = ${snapshot.manualReview?.previousStatus ?? null},
          manual_review_reason_code = ${snapshot.manualReview?.reasonCode ?? null},
          version = ${snapshot.version},
          updated_at = ${snapshot.updatedAt}::timestamptz
        WHERE id = ${snapshot.id}
          AND version = ${input.expectedVersion}
        RETURNING id
      `;
      if (!updated[0]) throw new Error("ORDER_VERSION_CONFLICT");

      for (const artifact of snapshot.artifacts) {
        await transaction`
          INSERT INTO agent_market.order_artifacts (
            id, task_id, uri, content_hash, media_type, size_bytes, submitted_at
          ) VALUES (
            ${artifact.id}, ${snapshot.id}, ${artifact.uri}, ${artifact.contentHash},
            ${artifact.mediaType}, ${artifact.sizeBytes}, ${artifact.submittedAt}::timestamptz
          )
          ON CONFLICT (task_id, content_hash) DO NOTHING
        `;
      }

      if (event.action === "accept_delivery" && snapshot.reviewEligible && snapshot.agentId) {
        await transaction`
          INSERT INTO agent_market.order_review_eligibilities (
            task_id, agent_id, publisher_wallet, status, granted_at
          ) VALUES (
            ${snapshot.id}, ${snapshot.agentId}, ${snapshot.publisherWallet}, 'available', ${event.occurredAt}::timestamptz
          )
          ON CONFLICT (task_id) DO UPDATE SET
            agent_id = EXCLUDED.agent_id,
            publisher_wallet = EXCLUDED.publisher_wallet,
            status = 'available',
            granted_at = EXCLUDED.granted_at,
            consumed_at = NULL
        `;
      }

      if (event.action === "accept_delivery" && snapshot.reviewEligible) {
        const assignmentRows = await transaction<DatabaseRow[]>`
          SELECT
            fact.market_agent_id,
            fact.runtime_agent_id,
            fact.binding_id AS fact_binding_id,
            binding.id AS binding_id,
            binding.runtime_agent_id AS binding_runtime_agent_id,
            binding.market_agent_id AS binding_market_agent_id,
            binding.status AS binding_status,
            agent.owner_wallet AS agent_owner_wallet,
            agent.status AS agent_status
          FROM agent_market.task_graph_node_pricing_facts fact
          JOIN agent_market.queen_workflows workflow
            ON workflow.task_id = fact.task_id
            AND workflow.graph_revision = fact.graph_revision
          LEFT JOIN agent_market.runtime_agent_bindings binding ON binding.id = fact.binding_id
          LEFT JOIN agent_market.agents agent ON agent.id = fact.market_agent_id
          WHERE fact.task_id = ${snapshot.id}
          ORDER BY fact.market_agent_id, fact.node_id
        `;
        const teamAgents = new Map<string, string>();
        for (const row of assignmentRows) {
          const agentId = String(row.market_agent_id ?? "");
          const ownerWallet = String(row.agent_owner_wallet ?? "").toLowerCase();
          if (
            !agentId
            || String(row.fact_binding_id ?? "") !== String(row.binding_id ?? "")
            || String(row.runtime_agent_id ?? "") !== String(row.binding_runtime_agent_id ?? "")
            || agentId !== String(row.binding_market_agent_id ?? "")
            || row.binding_status !== "active"
            || row.agent_status !== "published"
            || !/^0x[0-9a-f]{40}$/u.test(ownerWallet)
          ) {
            throw new Error("REPUTATION_V2_TEAM_AUTHORITY_CONFLICT");
          }
          const existingOwner = teamAgents.get(agentId);
          if (existingOwner && existingOwner !== ownerWallet) {
            throw new Error("REPUTATION_V2_TEAM_AUTHORITY_CONFLICT");
          }
          teamAgents.set(agentId, ownerWallet);
        }
        if (teamAgents.size === 0 && snapshot.agentId && snapshot.agentWallet) {
          teamAgents.set(snapshot.agentId, snapshot.agentWallet.toLowerCase());
        }

        for (const [agentId, ownerWallet] of teamAgents) {
          const eligibilityOrderId = assignmentRows.length === 0 && agentId === snapshot.agentId
            ? snapshot.id
            : randomUUID();
          await transaction`
            INSERT INTO agent_market.reputation_v2_review_eligibilities (
              order_id, task_id, agent_id, publisher_wallet, agent_owner_wallet,
              order_value_atomic, policy_version, status, granted_at
            ) VALUES (
              ${eligibilityOrderId}, ${snapshot.id}, ${agentId}, ${snapshot.publisherWallet}, ${ownerWallet},
              ${snapshot.budgetAtomic}::numeric, 'reputation-v2', 'available', ${event.occurredAt}::timestamptz
            )
            ON CONFLICT (task_id, agent_id) DO NOTHING
          `;
        }
      }

      await transaction`
        INSERT INTO agent_market.task_events (
          task_id, request_id, event_type, actor_wallet, payload, created_at
        ) VALUES (
          ${snapshot.id}, ${event.requestId}, ${event.action}, ${event.actorWallet},
          ${transaction.json({ from: event.from, to: event.to, version: event.version })},
          ${event.occurredAt}::timestamptz
        )
      `;

      await transaction`
        INSERT INTO agent_market.outbox_events (
          id, aggregate_type, aggregate_id, event_type, request_id, topic, payload, created_at
        ) VALUES (
          ${randomUUID()}, 'order', ${snapshot.id}, ${event.action}, ${event.requestId},
          'agent-market.order.events', ${transaction.json(event)}, ${event.occurredAt}::timestamptz
        )
      `;

      await transaction`
        INSERT INTO agent_market.order_action_idempotency (
          task_id, idempotency_key, payload_fingerprint, request_id, response_snapshot, response_event
        ) VALUES (
          ${snapshot.id}, ${input.idempotencyKey}, ${input.fingerprint}, ${event.requestId},
          ${transaction.json(snapshot)}, ${transaction.json(event)}
        )
      `;
    });
  }
}
