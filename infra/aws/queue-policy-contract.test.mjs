import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const template = readFileSync(new URL("./template.yaml", import.meta.url), "utf8");
const queuePolicy = template.match(
  /  PerformanceQueuePolicy:\n[\s\S]*?(?=\n  PerformanceTopicPolicy:)/,
)?.[0];

test("SQS transport denials use one queue resource per statement", () => {
  assert.ok(queuePolicy, "PerformanceQueuePolicy must exist");
  assert.match(
    queuePolicy,
    /Sid: DenyInsecureTransportWorkQueue[\s\S]*?Resource: !GetAtt PerformanceWorkQueue\.Arn/,
  );
  assert.match(
    queuePolicy,
    /Sid: DenyInsecureTransportDeadLetterQueue[\s\S]*?Resource: !GetAtt PerformanceDeadLetterQueue\.Arn/,
  );
  assert.doesNotMatch(
    queuePolicy,
    /Sid: DenyInsecureTransport[\s\S]*?Resource:\s*\n\s+- !GetAtt PerformanceWorkQueue\.Arn\s*\n\s+- !GetAtt PerformanceDeadLetterQueue\.Arn/,
  );
});

test("a fixed FIFO group serializes dispatch without reserved concurrency", () => {
  assert.match(template, /MessageGroupId="performance"/);
  assert.doesNotMatch(template, /ReservedConcurrentExecutions:/);
  assert.match(template, /ScalingConfig:\n[\s\S]*?MaximumConcurrency: 2/);
});
