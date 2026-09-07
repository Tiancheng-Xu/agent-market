import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { RequiredWorkflowStages, TaskGraphSchema } from "@agent-market/shared-contracts";
import { expect, it } from "vitest";
import { requestQueenPlanning } from "./queen-planning-request";
import { recordQueenPlanningApproval } from "./queen-planning-approval";

const databaseUrl = process.env.QUEEN_PLANNING_TEST_DATABASE_URL;

it.skipIf(!databaseUrl)("records only the publisher's current planning approval atomically with one resume event", async () => {
  const url = new URL(databaseUrl!);
  if (url.hostname !== "127.0.0.1" || !/^\/agent_market_planning_test_[a-z0-9_]+$/u.test(url.pathname)) {
    throw new Error("EPHEMERAL_LOCAL_DATABASE_REQUIRED");
  }
  const sql = postgres(url.toString(), { max: 1 });
  try {
    for (const file of ["migrations/0001_agent_market_core.sql", "queen-runtime-scopes.sql", "queen-planning-requests.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../../database/${file}`, import.meta.url), "utf8"));
    }
    const taskId = randomUUID();
    const owner = `0x${"a".repeat(40)}`;
    await sql`INSERT INTO agent_market.tasks
      (id, publisher_wallet, title, description, budget_atomic, request_id)
      VALUES (${taskId}, ${owner}, 'Approve plan', 'Private task', 100, ${randomUUID()})`;
    const requested = await requestQueenPlanning(sql, { taskId, actorWallet: owner, expectedTaskVersion: 1 });
    const [planning] = await sql`SELECT event FROM agent_market.queen_planning_requests WHERE id = ${requested.requestId}`;
    const fingerprint = String(planning!.event.taskFingerprint);
    const graph = TaskGraphSchema.parse({
      taskId, graphRevision: 1, requiredStages: [...RequiredWorkflowStages],
      riskLevel: "low", startPolicy: "auto",
      nodes: [
        { nodeId: "plan-1", type: "plan", title: "Plan", dependencies: [], required: true },
        { nodeId: "deliver-1", type: "deliver", title: "Deliver", dependencies: ["plan-1"], required: true },
      ],
      edges: [{ from: "plan-1", to: "deliver-1" }],
      rescuePolicy: { mode: "auto", visibleToUser: false, evidenceVisible: true },
    });
    const acceptedAt = "2026-09-07T00:00:00.000Z";
    const assignments = graph.nodes.map((node) => [node.nodeId, {
      nodeId: node.nodeId, selectedAgentId: `${node.nodeId}-agent`, status: "accepted",
      selectedBy: "queen", acceptedAt, override: false, riskCodes: [],
    }]);
    await sql`INSERT INTO queen_runtime_public.queen_workflows
      (task_id, record_version, graph_revision, snapshot, updated_at)
      VALUES (${taskId}, 1, 1, ${sql.json(JSON.parse(JSON.stringify({
        taskId, recordVersion: 1, graph, assignments,
        graphConfirmedRevision: null, runId: null,
      })))}, clock_timestamp())`;
    const input = { requestId: requested.requestId, taskId, actorWallet: owner,
      expectedTaskVersion: 1, graphRevision: 1, taskFingerprint: fingerprint, approved: true };

    await expect(recordQueenPlanningApproval(sql, { ...input, actorWallet: `0x${"b".repeat(40)}` }))
      .rejects.toThrow("QUEEN_TASK_UNAVAILABLE");
    await expect(recordQueenPlanningApproval(sql, { ...input, graphRevision: 2 }))
      .rejects.toThrow("QUEEN_APPROVAL_VERSION_MISMATCH");
    await expect(recordQueenPlanningApproval(sql, { ...input, taskFingerprint: `sha256:${"f".repeat(64)}` }))
      .rejects.toThrow("QUEEN_APPROVAL_VERSION_MISMATCH");

    const first = await recordQueenPlanningApproval(sql, input);
    const [approval] = await sql`SELECT approval_payload FROM agent_market.queen_planning_requests
      WHERE id = ${requested.requestId}`;
    expect(approval!.approval_payload.assignmentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const duplicate = await recordQueenPlanningApproval(sql, input);
    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect(await sql`SELECT event_id FROM queen_runtime_public.queen_outbox`).toHaveLength(2);
    await expect(recordQueenPlanningApproval(sql, { ...input, approved: false }))
      .rejects.toThrow("QUEEN_APPROVAL_DECISION_CONFLICT");

    const failedTaskId = randomUUID();
    await sql`INSERT INTO agent_market.tasks
      (id, publisher_wallet, title, description, budget_atomic, request_id)
      VALUES (${failedTaskId}, ${owner}, 'Rollback', 'Private task', 100, ${randomUUID()})`;
    const failedRequest = await requestQueenPlanning(sql, { taskId: failedTaskId, actorWallet: owner, expectedTaskVersion: 1 });
    const [failedPlanning] = await sql`SELECT event FROM agent_market.queen_planning_requests WHERE id = ${failedRequest.requestId}`;
    await sql`INSERT INTO queen_runtime_public.queen_workflows
      (task_id, record_version, graph_revision, snapshot, updated_at)
      VALUES (${failedTaskId}, 1, 1, ${sql.json(JSON.parse(JSON.stringify({
        taskId: failedTaskId, recordVersion: 1,
        graph: { ...graph, taskId: failedTaskId }, assignments,
        graphConfirmedRevision: null, runId: null,
      })))}, clock_timestamp())`;
    await sql.unsafe(`ALTER TABLE queen_runtime_public.queen_outbox ADD CONSTRAINT reject_approval_event
      CHECK ((event ->> 'eventType') <> 'task.approval-recorded') NOT VALID`);
    await expect(recordQueenPlanningApproval(sql, { ...input, requestId: failedRequest.requestId,
      taskId: failedTaskId, taskFingerprint: String(failedPlanning!.event.taskFingerprint) })).rejects.toThrow();
    const [rolledBack] = await sql`SELECT approval_event FROM agent_market.queen_planning_requests WHERE id = ${failedRequest.requestId}`;
    expect(rolledBack!.approval_event).toBeNull();
  } finally {
    await sql.unsafe("ALTER TABLE queen_runtime_public.queen_outbox DROP CONSTRAINT IF EXISTS reject_approval_event")
      .catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
}, 30000);
