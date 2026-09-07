import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { AgentCandidate } from "@agent-market/shared-contracts";
import postgres from "postgres";
import { expect, it, vi } from "vitest";
import { recordQueenPlanningApproval } from "../../transaction-engine/src/application/queen-planning-approval";
import { requestQueenPlanning } from "../../transaction-engine/src/application/queen-planning-request";
import { createQueenDurablePlanning } from "./queen-durable-planning";
import { QueenWorkflowEventSchema } from "./queen-workflow-event";
import { createQueenDurableApproval } from "./queen-durable-approval";
import { createQueenPlanningApprovalAuthorization } from "./queen-planning-approval-authorization";

const databaseUrl = process.env.QUEEN_PLANNING_TEST_DATABASE_URL;
const candidate = (agentId: string, capabilities: string[]): AgentCandidate => ({
  agentId, displayName: agentId, capabilities, tags: [], provider: "qwen",
  ownership: "third-party/provider-api", selectableBy: "public-market", status: "online",
  costPer1kTokensUsd: 0.01, latencyMs: 100, qualityScore: 0.9,
  firstSeenAt: "2026-01-01T00:00:00.000Z", modelTag: agentId,
  modelDigest: "provider-managed", riskCodes: [],
});
const agents = [
  candidate("queen-test", ["plan"]),
  candidate("executor", ["completion"]),
  candidate("judge", ["judge"]),
  candidate("red-team", ["red_team"]),
  candidate("final-arbiter", ["final_arbitration"]),
];

it.skipIf(!databaseUrl)("resumes an approved checkpoint through all high-risk gates and rejects without execution", async () => {
  const url = new URL(databaseUrl!);
  if (url.hostname !== "127.0.0.1" || !/^\/agent_market_planning_test_[a-z0-9_]+$/u.test(url.pathname)) {
    throw new Error("EPHEMERAL_LOCAL_DATABASE_REQUIRED");
  }
  const sql = postgres(url.toString(), { max: 1 });
  const saver = PostgresSaver.fromConnString(url.toString(), { schema: "queen_approval_probe" });
  try {
    await sql`SELECT pg_advisory_lock(72420260906)`;
    const [schema] = await sql`SELECT to_regclass('agent_market.tasks') AS tasks`;
    if (!schema!.tasks) {
      for (const file of ["migrations/0001_agent_market_core.sql", "queen-runtime-scopes.sql", "queen-planning-requests.sql"]) {
        await sql.unsafe(await readFile(new URL(`../../../database/${file}`, import.meta.url), "utf8"));
      }
    }
    await sql`TRUNCATE queen_runtime_public.queen_outbox, queen_runtime_public.queen_operations,
      queen_runtime_public.queen_workflows, agent_market.queen_planning_requests,
      agent_market.tasks CASCADE`;
    await saver.setup();
    const owner = `0x${"a".repeat(40)}`;
    const prepare = async (approved: boolean) => {
      const taskId = randomUUID();
      await sql`INSERT INTO agent_market.tasks
        (id, publisher_wallet, title, description, budget_atomic, request_id)
        VALUES (${taskId}, ${owner}, 'Durable approval', 'High risk production task', 100, ${randomUUID()})`;
      const request = await requestQueenPlanning(sql, { taskId, actorWallet: owner, expectedTaskVersion: 1 });
      const [planOutbox] = await sql`SELECT event FROM queen_runtime_public.queen_outbox
        WHERE event ->> 'eventType' = 'task.requested' AND event ->> 'taskId' = ${taskId}`;
      const planEvent = QueenWorkflowEventSchema.parse(planOutbox!.event);
      await createQueenDurablePlanning({
        sql, authorizationSql: sql, checkpointer: saver, queenAgentId: "queen-test", agents,
      })(planEvent);
      const [planned] = await sql`SELECT snapshot FROM queen_runtime_public.queen_workflows
        WHERE task_id = ${taskId}`;
      const plannedSnapshot = planned!.snapshot as Record<string, any>;
      const plannedAssignments = new Map<string, Record<string, unknown>>(plannedSnapshot.assignments);
      for (const node of plannedSnapshot.graph.nodes.filter((item: Record<string, unknown>) => item.required)) {
        expect(plannedAssignments.get(String(node.nodeId))?.status).toBe("accepted");
      }
      await recordQueenPlanningApproval(sql, {
        requestId: request.requestId, taskId, actorWallet: owner, expectedTaskVersion: 1,
        graphRevision: 1, taskFingerprint: planEvent.taskFingerprint, approved,
      });
      const [approvalOutbox] = await sql`SELECT event FROM queen_runtime_public.queen_outbox
        WHERE event ->> 'eventType' = 'task.approval-recorded' AND event ->> 'taskId' = ${taskId}`;
      const [approvalRequest] = await sql`SELECT approval_payload FROM agent_market.queen_planning_requests
        WHERE id = ${request.requestId}`;
      expect(approvalRequest!.approval_payload.assignmentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
      return QueenWorkflowEventSchema.parse(approvalOutbox!.event);
    };
    const execute = vi.fn(async () => "output-ref");
    const judge = vi.fn(async () => "approved" as const);
    const redTeam = vi.fn(async () => "approved" as const);
    const finalize = vi.fn(async () => "final-ref");
    const ports = {
      authorize: vi.fn(async () => undefined),
      plan: vi.fn(async () => { throw new Error("PLANNING_MUST_NOT_REPEAT"); }),
      execute, judge, redTeam,
      repair: vi.fn(async () => "repair-ref"), finalize,
    };
    const rejectEvent = await prepare(false);
    const rejectResult = await createQueenDurableApproval({ sql, checkpointer: saver, ports })(rejectEvent);
    expect(rejectResult.status).toBe("rejected");
    expect(execute).not.toHaveBeenCalled();

    const approveEvent = await prepare(true);
    const approveResult = await createQueenDurableApproval({ sql, checkpointer: saver, ports })(approveEvent);
    expect(approveResult.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(redTeam).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(ports.plan).not.toHaveBeenCalled();

    const runId = randomUUID();
    await sql`UPDATE queen_runtime_public.queen_workflows
      SET snapshot = jsonb_set(
        jsonb_set(snapshot, '{graphConfirmedRevision}', to_jsonb(${approveEvent.graphRevision}::integer)),
        '{runId}', to_jsonb(${runId}::text)
      )
      WHERE task_id = ${approveEvent.taskId}`;
    await expect(createQueenPlanningApprovalAuthorization(sql)(approveEvent))
      .resolves.toMatchObject({ approved: true, graphRevision: approveEvent.graphRevision });

    const [workflow] = await sql`SELECT record_version, snapshot
      FROM queen_runtime_public.queen_workflows WHERE task_id = ${approveEvent.taskId}`;
    const currentSnapshot = workflow!.snapshot as Record<string, any>;
    const currentGraph = currentSnapshot.graph as Record<string, any>;
    const extendedSnapshot = {
      ...currentSnapshot,
      recordVersion: Number(workflow!.record_version) + 1,
      graph: {
        ...currentGraph,
        graphRevision: 2,
        nodes: [...currentGraph.nodes, {
          nodeId: "repair-execute-1-1", type: "repair", title: "System repair",
          dependencies: ["execute-1"], required: true, repairsNodeId: "execute-1",
          metadata: { systemAppended: true, attempt: 1 },
        }],
        edges: [...currentGraph.edges, { from: "execute-1", to: "repair-execute-1-1", condition: "needs_revision" }],
      },
      assignments: [...currentSnapshot.assignments, ["repair-execute-1-1", {
        nodeId: "repair-execute-1-1", selectedAgentId: "executor", status: "accepted",
        selectedBy: "queen", acceptedAt: "2026-09-07T00:00:00.000Z",
        override: false, riskCodes: [],
      }]],
    };
    await sql`UPDATE queen_runtime_public.queen_workflows
      SET record_version = ${extendedSnapshot.recordVersion}, graph_revision = 2,
        snapshot = ${sql.json(extendedSnapshot)}
      WHERE task_id = ${approveEvent.taskId}`;
    await expect(createQueenPlanningApprovalAuthorization(sql)(approveEvent))
      .resolves.toMatchObject({ approved: true, graphRevision: approveEvent.graphRevision });

    await sql`UPDATE queen_runtime_public.queen_workflows
      SET snapshot = jsonb_set(snapshot, '{runId}', to_jsonb('not-a-run-id'::text))
      WHERE task_id = ${approveEvent.taskId}`;
    await expect(createQueenPlanningApprovalAuthorization(sql)(approveEvent))
      .rejects.toThrow("QUEEN_APPROVAL_AUTHORIZATION_REJECTED");

    const assignmentTamperedSnapshot: Record<string, any> = structuredClone(extendedSnapshot);
    assignmentTamperedSnapshot.runId = runId;
    assignmentTamperedSnapshot.recordVersion += 1;
    const executeAssignment = assignmentTamperedSnapshot.assignments
      .find(([nodeId]: [string]) => nodeId === "execute-1");
    executeAssignment[1].selectedAgentId = "judge";
    await sql`UPDATE queen_runtime_public.queen_workflows
      SET record_version = ${assignmentTamperedSnapshot.recordVersion},
        snapshot = ${sql.json(assignmentTamperedSnapshot)}
      WHERE task_id = ${approveEvent.taskId}`;
    await expect(createQueenPlanningApprovalAuthorization(sql)(approveEvent))
      .rejects.toThrow("QUEEN_APPROVAL_PAYLOAD_MISMATCH");

    const tamperedSnapshot: Record<string, any> = structuredClone(extendedSnapshot);
    tamperedSnapshot.runId = runId;
    tamperedSnapshot.recordVersion += 1;
    tamperedSnapshot.graph.nodes[0].title = "Tampered approved node";
    await sql`UPDATE queen_runtime_public.queen_workflows
      SET record_version = ${tamperedSnapshot.recordVersion}, snapshot = ${sql.json(tamperedSnapshot)}
      WHERE task_id = ${approveEvent.taskId}`;
    await expect(createQueenPlanningApprovalAuthorization(sql)(approveEvent))
      .rejects.toThrow("QUEEN_APPROVAL_PAYLOAD_MISMATCH");
  } finally {
    await saver.end();
    await sql`SELECT pg_advisory_unlock(72420260906)`.catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
}, 30000);
