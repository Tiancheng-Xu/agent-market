import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { expect, it, vi } from "vitest";
import { SNSClient } from "@aws-sdk/client-sns";
import { SQSClient, GetQueueAttributesCommand, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";
import { createQueenAsyncWorker } from "./queen-async-worker";
import { QueenOperationLedger } from "./queen-operation-ledger";
import { queenEventOperationKey, type QueenWorkflowEvent } from "./queen-workflow-event";

const databaseUrl = process.env.QUEEN_CHECKPOINT_TEST_DATABASE_URL;
it.skipIf(!databaseUrl)("durably excludes concurrent and duplicate work and preserves uncertain outcomes", async () => {
  const url = new URL(databaseUrl!);
  if (url.hostname !== "127.0.0.1" || !/^\/agent_market_checkpoint_test_[a-z0-9_]+$/u.test(url.pathname)) throw new Error("EPHEMERAL_LOCAL_DATABASE_REQUIRED");
  const sql = postgres(url.toString(), { max: 1 });
  const ledger = new QueenOperationLedger(url.toString(), "queen_runtime_public");
  const restored = new QueenOperationLedger(url.toString(), "queen_runtime_public");
  try {
    await sql.unsafe(await readFile(new URL("../../../database/queen-runtime-scopes.sql", import.meta.url), "utf8"));
    const event: QueenWorkflowEvent = {
      schemaVersion: "queen-workflow-event.v1", eventId: "01900000-0000-7000-8000-000000000031",
      eventType: "task.requested", taskId: "01900000-0000-7000-8000-000000000031", scopeId: "01900000-0000-7000-8000-000000000032",
      graphRevision: 1, taskFingerprint: `sha256:${"a".repeat(64)}`, payloadRef: "01900000-0000-7000-8000-000000000033",
      payloadHash: `sha256:${"b".repeat(64)}`, operationKey: "", occurredAt: "2026-09-04T00:00:00Z", expiresAt: "2026-09-05T00:00:00Z",
    };
    event.operationKey = queenEventOperationKey(event);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const effect = vi.fn(async () => { entered(); await gate; });
    const first = ledger.execute(event, effect);
    await started;
    expect(await restored.execute(event, effect)).toBe("busy");
    release();
    expect(await first).toBe("committed");
    expect(await restored.execute(event, effect)).toBe("duplicate-committed");
    expect(effect).toHaveBeenCalledTimes(1);
    const next = { ...event, graphRevision: 2 };
    next.operationKey = queenEventOperationKey(next);
    const failed = vi.fn().mockRejectedValue(new Error("PROVIDER_RESULT_UNKNOWN"));
    expect(await ledger.execute(next, failed)).toBe("uncertain");
    expect(await restored.execute(next, failed)).toBe("uncertain");
    expect(failed).toHaveBeenCalledTimes(1);
    const stale = { ...event, graphRevision: 4 };
    stale.operationKey = queenEventOperationKey(stale);
    await sql`INSERT INTO queen_runtime_public.queen_operations
      (operation_key, payload_hash, task_id, scope_id, graph_revision, owner_token, status, updated_at)
      VALUES (${stale.operationKey}, ${stale.payloadHash}, ${stale.taskId}, ${stale.scopeId},
        ${stale.graphRevision}, ${"01900000-0000-7000-8000-000000000099"}, 'executing',
        clock_timestamp() - interval '10 minutes')`;
    const staleEffect = vi.fn().mockResolvedValue(undefined);
    expect(await restored.execute(stale, staleEffect)).toBe("uncertain");
    expect(staleEffect).not.toHaveBeenCalled();
    const [staleRow] = await sql`SELECT status FROM queen_runtime_public.queen_operations
      WHERE operation_key = ${stale.operationKey}`;
    expect(staleRow!.status).toBe("uncertain");
    const queued = { ...event, graphRevision: 3 };
    queued.operationKey = queenEventOperationKey(queued);
    const sns = new SNSClient({ region: "us-east-1" });
    const sqs = new SQSClient({ region: "us-east-1" });
    const topicArn = "arn:aws:sns:us-east-1:000000000000:queen-test";
    const queueArn = "arn:aws:sqs:us-east-1:000000000000:queen-test";
    const deadLetterArn = queueArn + "-dlq";
    const executeTask = vi.fn().mockResolvedValue(undefined);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-04T12:00:00Z"));
    const send = vi.spyOn(sqs, "send").mockImplementation(async command => {
      if (command instanceof GetQueueAttributesCommand) return { Attributes: {
        QueueArn: queueArn,
        Policy: JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage", Resource: queueArn, Condition: { ArnEquals: { "aws:SourceArn": topicArn } } }] }),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: deadLetterArn, maxReceiveCount: "5" }),
      } };
      if (command instanceof ReceiveMessageCommand) return { Messages: [{ ReceiptHandle: "local-test-handle", Body: JSON.stringify({ Type: "Notification", TopicArn: topicArn, Message: JSON.stringify(queued) }) }] };
      if (command instanceof DeleteMessageCommand) return {};
      throw new Error("UNEXPECTED_SQS_COMMAND");
    });
    try {
      const worker = createQueenAsyncWorker({ sql, ledger, sns, sqs, schema: "queen_runtime_public",
        queueUrl: "https://sqs.us-east-1.amazonaws.com/000000000000/queen-test", queueArn, topicArn, deadLetterArn, maxReceiveCount: 5,
        authorizeAndResolve: async () => undefined, executeTask,
      });
      expect(await worker.consumeOne()).toMatchObject({ received: true, outcome: "committed" });
      expect(await worker.consumeOne()).toMatchObject({ received: true, outcome: "duplicate-committed" });
      expect(executeTask).toHaveBeenCalledTimes(1);
      expect(send.mock.calls.filter(call => call[0] instanceof DeleteMessageCommand)).toHaveLength(2);
    } finally {
      clock.mockRestore(); send.mockRestore(); sns.destroy(); sqs.destroy();
    }
  } finally {
    await ledger.close(); await restored.close(); await sql.end({ timeout: 5 });
  }
}, 30000);
