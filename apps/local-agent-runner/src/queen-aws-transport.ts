import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { consumeQueenWorkflowEvent, QueenWorkflowEventSchema, queenEventOperationKey, type QueenWorkflowConsumerPorts, type QueenWorkflowEvent } from "./queen-workflow-event";

function topicParts(topicArn: string) {
  const match = /^arn:aws:sns:([a-z0-9-]+):(\d{12}):([A-Za-z0-9_-]+(?:\.fifo)?)$/u.exec(topicArn);
  if (!match) throw new Error("QUEEN_SNS_TOPIC_INVALID");
  return { region: match[1]!, account: match[2]!, fifo: match[3]!.endsWith(".fifo") };
}

export function createQueenSnsPublisher(client: SNSClient, topicArn: string) {
  const topic = topicParts(topicArn);
  return async (input: QueenWorkflowEvent, signal: AbortSignal) => {
    const event = QueenWorkflowEventSchema.parse(input);
    if (event.operationKey !== queenEventOperationKey(event)) throw new Error("QUEEN_EVENT_IDENTITY_INVALID");
    const message = JSON.stringify(event);
    if (Buffer.byteLength(message, "utf8") > 8192) throw new Error("QUEEN_EVENT_TOO_LARGE");
    const result = await client.send(new PublishCommand({
      TopicArn: topicArn, Message: message,
      MessageAttributes: { eventType: { DataType: "String", StringValue: event.eventType } },
      ...(topic.fifo ? { MessageGroupId: `${event.scopeId}:${event.taskId}`, MessageDeduplicationId: event.operationKey } : {}),
    }), { abortSignal: signal });
    if (!result.MessageId) throw new Error("QUEEN_SNS_RECEIPT_MISSING");
    return { messageId: result.MessageId };
  };
}

export async function consumeOneQueenSqsMessage(options: {
  client: SQSClient;
  queueUrl: string;
  topicArn: string;
  // Must verify queue policy/subscription configuration, not just trust envelope.TopicArn.
  assertQueuePolicy(): Promise<void>;
  authorizeAndResolve: QueenWorkflowConsumerPorts["authorizeAndResolve"];
  executeDurably: QueenWorkflowConsumerPorts["executeDurably"];
}) {
  const topic = topicParts(options.topicArn), url = new URL(options.queueUrl);
  if (url.protocol !== "https:" || url.hostname !== `sqs.${topic.region}.amazonaws.com`
    || url.username || url.password || url.search || url.hash
    || !new RegExp(`^/${topic.account}/[A-Za-z0-9_-]+(?:\\.fifo)?$`, "u").test(url.pathname)
    || url.pathname.endsWith(".fifo") !== topic.fifo) throw new Error("QUEEN_SQS_TARGET_INVALID");
  await options.assertQueuePolicy();
  const response = await options.client.send(new ReceiveMessageCommand({
    QueueUrl: options.queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 10, VisibilityTimeout: 120,
  }), { abortSignal: AbortSignal.timeout(15000) });
  const message = response.Messages?.[0];
  if (!message) return { received: false };
  if (!message.Body || !message.ReceiptHandle || Buffer.byteLength(message.Body, "utf8") > 16384) throw new Error("QUEEN_SQS_MESSAGE_INVALID");
  let envelope: Record<string, unknown>;
  try { envelope = JSON.parse(message.Body); } catch { throw new Error("QUEEN_SNS_ENVELOPE_INVALID"); }
  if (!envelope || envelope.Type !== "Notification" || envelope.TopicArn !== options.topicArn || typeof envelope.Message !== "string") {
    throw new Error("QUEEN_SNS_SOURCE_INVALID");
  }
  let leaseLost = false, renewing: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (renewing || leaseLost) return;
    renewing = options.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: options.queueUrl, ReceiptHandle: message.ReceiptHandle!, VisibilityTimeout: 120,
    }), { abortSignal: AbortSignal.timeout(10000) }).then(() => undefined).catch(() => { leaseLost = true; }).finally(() => { renewing = undefined; });
  }, 30000);
  try {
    const result = await consumeQueenWorkflowEvent(envelope.Message, {
      assertTrustedSource: options.assertQueuePolicy,
      authorizeAndResolve: options.authorizeAndResolve,
      executeDurably: options.executeDurably,
      deleteMessage: async () => {
        clearInterval(heartbeat);
        await renewing;
        if (leaseLost) throw new Error("QUEEN_SQS_LEASE_LOST");
        await options.client.send(new DeleteMessageCommand({ QueueUrl: options.queueUrl, ReceiptHandle: message.ReceiptHandle! }), { abortSignal: AbortSignal.timeout(10000) });
      },
    });
    return { received: true, ...result };
  } finally {
    clearInterval(heartbeat);
    await renewing;
  }
}
