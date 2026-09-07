import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";
import { afterEach, expect, it, vi } from "vitest";
import { createQueenSnsPublisher, consumeOneQueenSqsMessage } from "./queen-aws-transport";
import { queenEventOperationKey, type QueenWorkflowEvent } from "./queen-workflow-event";

afterEach(() => vi.restoreAllMocks());
const region = "us-east-1", topicArn = "arn:aws:sns:us-east-1:000000000000:queen-test";
const queueUrl = "https://sqs.us-east-1.amazonaws.com/000000000000/queen-test";
it("publishes the validated event with an SNS command without making network calls", async () => {
  const client = new SNSClient({ region });
  const send = vi.spyOn(client, "send").mockImplementation(async () => ({ MessageId: "mock-receipt" }));
  const event: QueenWorkflowEvent = {
    schemaVersion: "queen-workflow-event.v1", eventId: "01900000-0000-7000-8000-000000000051",
    eventType: "task.requested", taskId: "01900000-0000-7000-8000-000000000051", scopeId: "01900000-0000-7000-8000-000000000052",
    graphRevision: 1, taskFingerprint: `sha256:${"a".repeat(64)}`, payloadRef: "01900000-0000-7000-8000-000000000053",
    payloadHash: `sha256:${"b".repeat(64)}`, operationKey: "", occurredAt: "2026-09-04T00:00:00Z", expiresAt: "2026-09-05T00:00:00Z",
  };
  event.operationKey = queenEventOperationKey(event);
  await expect(createQueenSnsPublisher(client, topicArn)(event, AbortSignal.timeout(1000))).resolves.toEqual({ messageId: "mock-receipt" });
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PublishCommand);
  expect(JSON.parse((send.mock.calls[0]?.[0] as PublishCommand).input.Message!)).toEqual(event);
  client.destroy();
});
it("requires policy verification before receiving SQS messages", async () => {
  const client = new SQSClient({ region });
  const send = vi.spyOn(client, "send").mockImplementation(async () => ({}));
  await expect(consumeOneQueenSqsMessage({ client, queueUrl, topicArn,
    assertQueuePolicy: async () => { throw new Error("POLICY_NOT_VERIFIED"); },
    authorizeAndResolve: vi.fn(), executeDurably: vi.fn(),
  })).rejects.toThrow("POLICY_NOT_VERIFIED");
  expect(send).not.toHaveBeenCalled(); client.destroy();
});
it("rejects mismatched SNS topics without executing or deleting the message", async () => {
  const client = new SQSClient({ region });
  const send = vi.spyOn(client, "send").mockImplementation(async () => ({ Messages: [{ ReceiptHandle: "test-handle", Body: JSON.stringify({ Type: "Notification", TopicArn: topicArn + "-other", Message: "{}" }) }] }));
  const executeDurably = vi.fn();
  await expect(consumeOneQueenSqsMessage({ client, queueUrl, topicArn,
    assertQueuePolicy: async () => undefined, authorizeAndResolve: vi.fn(), executeDurably,
  })).rejects.toThrow("QUEEN_SNS_SOURCE_INVALID");
  expect(send).toHaveBeenCalledTimes(1); expect(executeDurably).not.toHaveBeenCalled(); client.destroy();
});
