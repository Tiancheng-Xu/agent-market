import { expect, it } from "vitest";
import { verifyQueenQueuePolicy } from "./queen-queue-policy";
const expected = {
  queueArn: "arn:aws:sqs:us-east-1:000000000000:queen-test",
  topicArn: "arn:aws:sns:us-east-1:000000000000:queen-test",
  deadLetterArn: "arn:aws:sqs:us-east-1:000000000000:queen-test-dlq", maxReceiveCount: 5,
};
const grant = { Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage",
  Resource: expected.queueArn, Condition: { ArnEquals: { "aws:SourceArn": expected.topicArn } } };
const attributes = { QueueArn: expected.queueArn, Policy: JSON.stringify({ Statement: [grant] }),
  RedrivePolicy: JSON.stringify({ deadLetterTargetArn: expected.deadLetterArn, maxReceiveCount: "5" }) };
it("accepts exact SNS grant and expected consumer DLQ", () => {
  expect(() => verifyQueenQueuePolicy(attributes, expected)).not.toThrow();
});
it.each([
  { ...grant, Principal: "*" }, { ...grant, Action: "sqs:*" }, { ...grant, Resource: "*" },
  { ...grant, Condition: { ArnEquals: { "aws:SourceArn": "*" } } },
])("rejects broad sender grants", bad => {
  expect(() => verifyQueenQueuePolicy({ ...attributes, Policy: JSON.stringify({ Statement: [grant, bad] }) }, expected)).toThrow();
});
it("rejects a different DLQ and a missing policy", () => {
  expect(() => verifyQueenQueuePolicy({ ...attributes, RedrivePolicy: "{}" }, expected)).toThrow("QUEEN_QUEUE_REDRIVE_MISMATCH");
  expect(() => verifyQueenQueuePolicy({ ...attributes, Policy: "" }, expected)).toThrow("QUEEN_QUEUE_POLICY_INVALID");
});
