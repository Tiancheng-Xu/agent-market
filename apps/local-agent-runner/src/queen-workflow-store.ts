import postgres, { type JSONValue, type Sql } from "postgres";

import type { NodeAssignment, TaskGraph } from "@agent-market/shared-contracts";
import { QueenWorkflowEventSchema, queenEventOperationKey, type QueenWorkflowEvent } from "./queen-workflow-event";

export type QueenWorkflowSnapshot = {
  taskId: string;
  recordVersion: number;
  requirement: string;
  queenAgentId: string;
  graph: TaskGraph;
  assignments: Array<[string, NodeAssignment]>;
  outputs: Array<[string, { executorAgentId: string; output: string; outputId: string }]>;
  judgments: Array<[string, { nodeId: string; judgeAgentId: string; verdict: string; score: number; redTeamRequired: boolean; status: string }]>;
  finalArbitration: { taskId: string; finalArbiterAgentId: string; verdict: string; finalOutput: string } | null;
  learningRecords: Array<{ memoryRecordId: string; summary: string }>;
  systemNodeIds: Array<[string, string]>;
  graphConfirmedRevision: number | null;
  runId: string | null;
  updatedAt: string;
  operationResults?: Array<[string, { agentId: string; result: Record<string, unknown> }]>;
};

export interface QueenWorkflowStore {
  load(taskId: string): Promise<QueenWorkflowSnapshot | null>;
  save(snapshot: QueenWorkflowSnapshot, expectedRecordVersion: number): Promise<void>;
}

export class MemoryQueenWorkflowStore implements QueenWorkflowStore {
  private readonly records = new Map<string, QueenWorkflowSnapshot>();

  async load(taskId: string): Promise<QueenWorkflowSnapshot | null> {
    const snapshot = this.records.get(taskId);
    return snapshot ? structuredClone(snapshot) : null;
  }

  async save(snapshot: QueenWorkflowSnapshot, expectedRecordVersion: number): Promise<void> {
    const existing = this.records.get(snapshot.taskId);
    const actualVersion = existing?.recordVersion ?? 0;
    if (actualVersion !== expectedRecordVersion || snapshot.recordVersion !== expectedRecordVersion + 1) {
      throw new Error("QUEEN_WORKFLOW_VERSION_CONFLICT");
    }
    this.records.set(snapshot.taskId, structuredClone(snapshot));
  }
}

type WorkflowRow = { record_version: number; snapshot: QueenWorkflowSnapshot };

const jsonSnapshot = (snapshot: QueenWorkflowSnapshot): JSONValue =>
  JSON.parse(JSON.stringify(snapshot)) as JSONValue;

export class PostgresQueenWorkflowStore implements QueenWorkflowStore {
  private readonly tableName: string;
  constructor(private readonly sql: Sql, schema = "agent_market") {
    if (!["agent_market", "queen_runtime_public", "queen_runtime_owner"].includes(schema)) {
      throw new Error("QUEEN_WORKFLOW_SCHEMA_INVALID");
    }
    this.tableName = `"${schema}"."queen_workflows"`;
  }

  static connect(databaseUrl: string, schema = "agent_market"): PostgresQueenWorkflowStore {
    return new PostgresQueenWorkflowStore(postgres(databaseUrl, { max: 5, prepare: false }), schema);
  }

  async assertReady(): Promise<void> {
    await this.sql`SELECT record_version, snapshot FROM ${this.sql.unsafe(this.tableName)} LIMIT 0`;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async load(taskId: string): Promise<QueenWorkflowSnapshot | null> {
    const rows = await this.sql<WorkflowRow[]>`
      SELECT record_version, snapshot
      FROM ${this.sql.unsafe(this.tableName)}
      WHERE task_id = ${taskId}
      LIMIT 1
    `;
    return rows[0]?.snapshot ?? null;
  }

  async save(snapshot: QueenWorkflowSnapshot, expectedRecordVersion: number, outboxEvent?: QueenWorkflowEvent): Promise<void> {
    if (snapshot.recordVersion !== expectedRecordVersion + 1) throw new Error("QUEEN_WORKFLOW_VERSION_CONFLICT");
    const event = outboxEvent === undefined ? undefined : QueenWorkflowEventSchema.parse(outboxEvent);
    if (event && (event.taskId !== snapshot.taskId || event.graphRevision !== snapshot.graph.graphRevision
      || event.operationKey !== queenEventOperationKey(event))) throw new Error("QUEEN_OUTBOX_IDENTITY_INVALID");
    const changed = await this.sql.begin(async (tx) => {
      if (event) {
        const outboxTable = this.tableName.replace('"queen_workflows"', '"queen_outbox"');
        await tx`
          INSERT INTO ${tx.unsafe(outboxTable)} (event_id, operation_key, event, status)
          VALUES (${event.eventId}, ${event.operationKey}, ${tx.json(JSON.parse(JSON.stringify(event)) as JSONValue)}, 'pending')
        `;
      }
      if (expectedRecordVersion === 0) {
        const inserted = await tx`
          INSERT INTO ${tx.unsafe(this.tableName)} (
            task_id, record_version, graph_revision, run_id, snapshot, updated_at
          ) VALUES (
            ${snapshot.taskId}, ${snapshot.recordVersion}, ${snapshot.graph.graphRevision},
            ${snapshot.runId}, ${tx.json(jsonSnapshot(snapshot))}, ${snapshot.updatedAt}
          )
          ON CONFLICT (task_id) DO NOTHING
          RETURNING task_id
        `;
        if (inserted.count !== 1) throw new Error("QUEEN_WORKFLOW_VERSION_CONFLICT");
        return inserted.count;
      }
      const updated = await tx`
        UPDATE ${tx.unsafe(this.tableName)}
        SET record_version = ${snapshot.recordVersion},
            graph_revision = ${snapshot.graph.graphRevision},
            run_id = ${snapshot.runId},
            snapshot = ${tx.json(jsonSnapshot(snapshot))},
            updated_at = ${snapshot.updatedAt}
        WHERE task_id = ${snapshot.taskId}
          AND record_version = ${expectedRecordVersion}
        RETURNING task_id
      `;
      if (updated.count !== 1) throw new Error("QUEEN_WORKFLOW_VERSION_CONFLICT");
      return updated.count;
    });
    if (changed !== 1) throw new Error("QUEEN_WORKFLOW_VERSION_CONFLICT");
  }
}
