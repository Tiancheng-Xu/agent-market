import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";

type Expected = { queueArn: string; topicArn: string; deadLetterArn: string; maxReceiveCount: number };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("QUEEN_QUEUE_POLICY_INVALID");
  return value as Record<string, unknown>;
}
function parse(text: string | undefined) {
  try { return object(JSON.parse(text ?? "")); } catch { throw new Error("QUEEN_QUEUE_POLICY_INVALID"); }
}
const values = (value: unknown) => Array.isArray(value) ? value : [value];

export function verifyQueenQueuePolicy(attributes: Record<string, string>, expected: Expected): void {
  const arn = /^arn:aws:sqs:([a-z0-9-]+):(\d{12}):([A-Za-z0-9_-]+(?:\.fifo)?)$/u.exec(expected.queueArn);
  if (!arn || !expected.topicArn.startsWith(`arn:aws:sns:${arn[1]}:${arn[2]}:`)
    || !expected.deadLetterArn.startsWith(`arn:aws:sqs:${arn[1]}:${arn[2]}:`)
    || expected.deadLetterArn === expected.queueArn || attributes.QueueArn !== expected.queueArn
    || !Number.isInteger(expected.maxReceiveCount) || expected.maxReceiveCount < 1) {
    throw new Error("QUEEN_QUEUE_TARGET_MISMATCH");
  }
  const policy = parse(attributes.Policy);
  const statements = values(policy.Statement);
  let exactSender = false;
  for (const raw of statements) {
    const statement = object(raw);
    if (statement.Effect === "Deny") continue;
    if (statement.Effect !== "Allow" || statement.NotAction || statement.NotPrincipal || statement.NotResource) {
      throw new Error("QUEEN_QUEUE_POLICY_UNSUPPORTED");
    }
    // Deliberately accept only the minimal SNS resource-policy grant.
    // Account identity policies still require a separate least-privilege IAM audit.
    const actions = values(statement.Action), resources = values(statement.Resource);
    const principal = object(statement.Principal), condition = object(statement.Condition);
    const source = object(condition.ArnEquals);
    if (actions.length !== 1 || String(actions[0]).toLowerCase() !== "sqs:sendmessage"
      || resources.length !== 1 || resources[0] !== expected.queueArn
      || Object.keys(principal).length !== 1 || principal.Service !== "sns.amazonaws.com"
      || source["aws:SourceArn"] !== expected.topicArn) throw new Error("QUEEN_QUEUE_SENDER_TOO_BROAD");
    exactSender = true;
  }
  if (!exactSender) throw new Error("QUEEN_QUEUE_SNS_GRANT_MISSING");
  const redrive = parse(attributes.RedrivePolicy);
  if (redrive.deadLetterTargetArn !== expected.deadLetterArn
    || Number(redrive.maxReceiveCount) !== expected.maxReceiveCount) throw new Error("QUEEN_QUEUE_REDRIVE_MISMATCH");
}

export function createQueenQueuePolicyCheck(client: SQSClient, queueUrl: string, expected: Expected) {
  const arn = /^arn:aws:sqs:([a-z0-9-]+):(\d{12}):([A-Za-z0-9_-]+(?:\.fifo)?)$/u.exec(expected.queueArn);
  if (!arn || queueUrl !== `https://sqs.${arn[1]}.amazonaws.com/${arn[2]}/${arn[3]}`) {
    throw new Error("QUEEN_QUEUE_TARGET_MISMATCH");
  }
  return async () => {
    const response = await client.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl, AttributeNames: ["QueueArn", "Policy", "RedrivePolicy"],
    }), { abortSignal: AbortSignal.timeout(10000) });
    verifyQueenQueuePolicy(response.Attributes ?? {}, expected);
  };
}
