import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { expect, it, vi } from "vitest";
import type { AgentCandidate } from "@agent-market/shared-contracts";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { SQSClient, GetQueueAttributesCommand, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { QueenOperationLedger } from "./queen-operation-ledger";
import { requestQueenPlanning } from "../../transaction-engine/src/application/queen-planning-request";
import { recordQueenPlanningApproval } from "../../transaction-engine/src/application/queen-planning-approval";
import { createQueenPlanningAuthorization } from "./queen-planning-authorization";
import { QueenWorkflowEventSchema, queenEventOperationKey } from "./queen-workflow-event";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createQueenDurablePlanning } from "./queen-durable-planning";
import { createQueenOrchestratorPorts } from "./queen-orchestrator-ports";
import { PostgresQueenWorkflowStore } from "./queen-workflow-store";

const candidate = (agentId: string, capabilities: string[]): AgentCandidate => ({
  agentId, displayName: agentId, capabilities, tags: [], provider: "qwen",
  ownership: "third-party/provider-api", selectableBy: "public-market", status: "online",
  costPer1kTokensUsd: 0.01, latencyMs: 100, qualityScore: 0.9,
  firstSeenAt: "2026-01-01T00:00:00.000Z", modelTag: agentId,
  modelDigest: "provider-managed", riskCodes: [],
});

const databaseUrl = process.env.QUEEN_PLANNING_TEST_DATABASE_URL;
it.skipIf(!databaseUrl)("resolves authentic producer events and rejects tampering, changed tasks and revoked grants", async () => {
  const url = new URL(databaseUrl!);
  if (url.hostname !== "127.0.0.1" || !/^\/agent_market_planning_test_[a-z0-9_]+$/u.test(url.pathname)) {
    throw new Error("EPHEMERAL_LOCAL_DATABASE_REQUIRED");
  }
  const sql = postgres(url.toString(), { max: 1 });
  const saver = PostgresSaver.fromConnString(url.toString(), { schema: "queen_planning_probe" });
  const ledger = new QueenOperationLedger(url.toString(), "queen_runtime_public");
  const sns = new SNSClient({ region: "us-east-1" });
  const sqs = new SQSClient({ region: "us-east-1" });
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
    const taskId = randomUUID();
    const wallet = `0x${"a".repeat(40)}`;
    await sql`INSERT INTO agent_market.tasks
      (id, publisher_wallet, title, description, budget_atomic, request_id)
      VALUES (${taskId}, ${wallet}, 'Plan', 'Move production funds with strict review', 100, ${randomUUID()})`;
    await requestQueenPlanning(sql, { taskId, actorWallet: wallet, expectedTaskVersion: 1 });
    const [outbox] = await sql`SELECT event FROM queen_runtime_public.queen_outbox`;
    const event = QueenWorkflowEventSchema.parse(outbox!.event);
    const resolve = createQueenPlanningAuthorization(sql);
    expect((await resolve(event)).description).toBe("Move production funds with strict review");
    await saver.setup();
    const workerModule = await import("./queen-async-worker");
    expect(workerModule.createQueenWorkflowWorker).toBeTypeOf("function");
    const topicArn = "arn:aws:sns:us-east-1:000000000000:queen-test";
    const queueArn = "arn:aws:sqs:us-east-1:000000000000:queen-test";
    const deadLetterArn = queueArn + "-dlq";
    let publishedMessage: string | undefined;
    let deleted = 0;
    vi.spyOn(sns, "send").mockImplementation(async command => {
      if (!(command instanceof PublishCommand)) throw new Error("UNEXPECTED_SNS_COMMAND");
      expect(command.input.TopicArn).toBe(topicArn);
      publishedMessage = command.input.Message;
      return { MessageId: "local-publish-receipt" };
    });
    vi.spyOn(sqs, "send").mockImplementation(async command => {
      if (command instanceof GetQueueAttributesCommand) return { Attributes: {
        QueueArn: queueArn,
        Policy: JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn, Condition: { ArnEquals: { "aws:SourceArn": topicArn } } }] }),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: deadLetterArn, maxReceiveCount: "5" }),
      } };
      if (command instanceof ReceiveMessageCommand) {
        if (!publishedMessage) throw new Error("OUTBOX_NOT_PUBLISHED");
        return { Messages: [{ ReceiptHandle: "local-receipt", Body: JSON.stringify({ Type: "Notification", TopicArn: topicArn, Message: publishedMessage }) }] };
      }
      if (command instanceof DeleteMessageCommand) {
        expect(command.input.ReceiptHandle).toBe("local-receipt");
        const currentEvent = QueenWorkflowEventSchema.parse(JSON.parse(publishedMessage!));
        const [operation] = await sql`SELECT status FROM queen_runtime_public.queen_operations WHERE operation_key = ${currentEvent.operationKey}`;
        expect(operation!.status).toBe("committed");
        const [plan] = await sql`SELECT snapshot FROM queen_runtime_public.queen_workflows WHERE task_id = ${taskId}`;
        if (currentEvent.eventType === "task.requested") {
          expect(plan!.snapshot.runId).toBeNull();
        } else {
          expect(plan!.snapshot.runId).toMatch(/^[0-9a-f-]{36}$/u);
          expect(plan!.snapshot.judgments[0][1].verdict).toBe("approved");
          expect(plan!.snapshot.finalArbitration.finalOutput).toBe("verdict: approved\napproved final output");
        }
        deleted += 1;
        return {};
      }
      throw new Error("UNEXPECTED_SQS_COMMAND");
    });
    const agents = [
      { ...candidate("queen-alias", ["completion", "judge", "red_team", "final_arbitration"]),
        modelTag: " QUEEN-ROUTER-V1 ", costPer1kTokensUsd: 0, latencyMs: 1, qualityScore: 1 },
      ...["a", "b", "c", "d"].map((suffix, index) => ({
        ...candidate(`top-${suffix}`, ["completion", "judge", "red_team", "final_arbitration"]),
        costPer1kTokensUsd: index / 1000, latencyMs: index + 2, qualityScore: 1 - index / 100,
      })),
      candidate("queen-router-v1", ["plan", "completion"]),
      candidate("executor", ["completion"]),
      candidate("judge", ["judge"]),
      candidate("red-team", ["red_team"]),
      candidate("final-arbiter", ["final_arbitration"]),
    ];
    const options = {
      sql, authorizationSql: sql, checkpointer: saver, queenAgentId: "queen-router-v1", agents,
    };
    let judgment = 0;
    const executeAgentText = vi.fn(async ({ role }: { role: string; operationKey: string }) => {
      if (role === "executor") return "first output";
      if (role === "judge") return ++judgment === 1
        ? "verdict: needs_revision\nscore: 0.40"
        : "verdict: approved\nscore: 0.95";
      if (role === "repair") return "repaired output";
      if (role === "red_team") return "verdict: approved\nfindings: no blocking issue";
      if (role === "final_arbiter") return "verdict: approved\napproved final output";
      throw new Error("UNEXPECTED_ROLE");
    });
    const ports = createQueenOrchestratorPorts({
      agents,
      queenAgentId: "queen-router-v1",
      workflowStore: new PostgresQueenWorkflowStore(sql, "queen_runtime_public"),
      executeAgentText,
    });
    const worker = workerModule.createQueenWorkflowWorker({ ...options, ledger, sns, sqs, ports,
      queueUrl: "https://sqs.us-east-1.amazonaws.com/000000000000/queen-test",
      queueArn, topicArn, deadLetterArn, maxReceiveCount: 5,
    });
    await worker.publishPending();
    expect(QueenWorkflowEventSchema.parse(JSON.parse(publishedMessage!))).toEqual(event);
    expect(await worker.consumeOne()).toMatchObject({ received: true, outcome: "committed" });
    expect(await worker.consumeOne()).toMatchObject({ received: true, outcome: "duplicate-committed" });
    expect(deleted).toBe(2);
    const [firstPlan] = await sql`SELECT record_version, snapshot FROM queen_runtime_public.queen_workflows WHERE task_id = ${taskId}`;
    expect(firstPlan!.snapshot.runId).toBeNull();
    expect(firstPlan!.snapshot.graphConfirmedRevision).toBeNull();
    const assignmentByNode = new Map<string, { selectedAgentId: string }>(
      firstPlan!.snapshot.assignments as Array<[string, { selectedAgentId: string }]>,
    );
    const independentAgentIds = firstPlan!.snapshot.graph.nodes
      .filter((node: { type: string }) => ["execute", "judge", "red_team", "synthesize"].includes(node.type))
      .map((node: { nodeId: string }) => {
        const assignment = assignmentByNode.get(node.nodeId);
        if (!assignment) throw new Error("MISSING_PREAPPROVED_ASSIGNMENT");
        return assignment.selectedAgentId;
      });
    expect(new Set(independentAgentIds).size).toBe(independentAgentIds.length);
    expect(independentAgentIds).not.toContain("queen-alias");
    const independentModelTags = independentAgentIds.map((agentId: string) => {
      const agent = agents.find(candidate => candidate.agentId === agentId);
      if (!agent) throw new Error("MISSING_PREAPPROVED_AGENT");
      return agent.modelTag.trim().toLowerCase();
    });
    expect(new Set(independentModelTags).size).toBe(independentModelTags.length);
    // Reconstruct before approval, preserving only PostgreSQL state.
    await createQueenDurablePlanning(options)(event);
    const [secondPlan] = await sql`SELECT record_version FROM queen_runtime_public.queen_workflows WHERE task_id = ${taskId}`;
    expect(secondPlan!.record_version).toBe(firstPlan!.record_version);
    const approval = await recordQueenPlanningApproval(sql, {
      requestId: event.payloadRef, taskId, actorWallet: wallet, expectedTaskVersion: 1,
      graphRevision: event.graphRevision, taskFingerprint: event.taskFingerprint, approved: true,
    });
    expect(approval.duplicate).toBe(false);
    publishedMessage = undefined;
    await worker.publishPending();
    const approvalEvent = QueenWorkflowEventSchema.parse(JSON.parse(publishedMessage!));
    expect(approvalEvent.eventType).toBe("task.approval-recorded");
    expect(await worker.consumeOne()).toMatchObject({ received: true, outcome: "committed" });
    expect(await worker.consumeOne()).toMatchObject({ received: true, outcome: "duplicate-committed" });
    expect(executeAgentText.mock.calls.map(([request]) => request.role)).toEqual([
      "executor", "judge", "repair", "judge", "red_team", "final_arbiter",
    ]);
    expect(executeAgentText.mock.calls.map(([request]) => request.operationKey.split(":").at(-2))).toEqual([
      "execute", "judge", "repair", "judge", "red_team", "finalize",
    ]);
    expect(deleted).toBe(4);
    const [approvedOperation] = await sql`
      SELECT status FROM queen_runtime_public.queen_operations
      WHERE operation_key = ${approvalEvent.operationKey}
    `;
    expect(approvedOperation!.status).toBe("committed");
    const [completedWorkflow] = await sql`
      SELECT snapshot FROM queen_runtime_public.queen_workflows WHERE task_id = ${taskId}
    `;
    expect(completedWorkflow!.snapshot.outputs[0][1].output).toBe("repaired output");
    expect(completedWorkflow!.snapshot.graph.graphRevision).toBeGreaterThan(event.graphRevision);
    const finalNode = firstPlan!.snapshot.graph.nodes.find((node: { type: string }) => node.type === "synthesize");
    const approvedFinalAgentId = finalNode ? assignmentByNode.get(finalNode.nodeId)?.selectedAgentId : undefined;
    expect(approvedFinalAgentId).toBeTypeOf("string");
    expect(completedWorkflow!.snapshot.finalArbitration.finalArbiterAgentId).toBe(approvedFinalAgentId);
    const forged = { ...event, scopeId: randomUUID() };
    forged.operationKey = queenEventOperationKey(forged);
    await expect(resolve(forged)).rejects.toThrow("QUEEN_PLANNING_EVENT_MISMATCH");
    await sql`UPDATE agent_market.tasks SET description = 'Changed input' WHERE id = ${taskId}`;
    await expect(resolve(event)).rejects.toThrow("QUEEN_PLANNING_PAYLOAD_MISMATCH");
    await sql`UPDATE agent_market.tasks SET description = 'Move production funds with strict review', version = 2 WHERE id = ${taskId}`;
    await expect(resolve(event)).rejects.toThrow("QUEEN_PLANNING_AUTHORIZATION_REJECTED");
    await sql`UPDATE agent_market.tasks SET version = 1 WHERE id = ${taskId}`;
    await sql`UPDATE agent_market.queen_planning_requests SET status = 'revoked'`;
    await expect(resolve(event)).rejects.toThrow("QUEEN_PLANNING_AUTHORIZATION_REJECTED");
    await sql`UPDATE agent_market.queen_planning_requests SET status = 'requested', expires_at = clock_timestamp() - interval '1 second'`;
    await expect(resolve(event)).rejects.toThrow("QUEEN_PLANNING_AUTHORIZATION_REJECTED");
  } finally {
    vi.restoreAllMocks(); sns.destroy(); sqs.destroy();
    await ledger.close(); await saver.end();
    await sql`SELECT pg_advisory_unlock(72420260906)`.catch(() => undefined);
    await sql.end({ timeout: 5 });
  }
}, 30000);
