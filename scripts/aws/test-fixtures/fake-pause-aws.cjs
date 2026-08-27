#!/usr/bin/env node
const fs = require("node:fs");
const statePath = process.env.FAKE_AWS_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const raw = process.argv.slice(2);
const args = [];
for (let i = 0; i < raw.length; i += 1) {
  if (raw[i] === "--region") { i += 1; continue; }
  if (raw[i] === "--no-cli-pager") continue;
  args.push(raw[i]);
}
const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const outputText = args.includes("--output") && option("--output") === "text";
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const mutate = (key, fn) => {
  state.mutations.push(key);
  if (state.failKey === key && !state.failed) { state.failed = true; save(); process.exit(75); }
  fn(); save();
};
const service = args[0], action = args[1];
if (service === "cloudformation" && action === "describe-stacks") {
  const query = option("--query") || "";
  const value = query.includes("Ingestion") ? "ingestion" :
    query.includes("DispatcherFunction") ? "dispatcher" :
    query.includes("Mapping") || query.includes("EventSource") ? "mapping" :
    query.includes("Queue") ? "https://sqs.us-east-1.amazonaws.com/123/queue.fifo" :
    query.includes("State") || query.includes("Parameter") ? "/agent-market/pause" :
    query.includes("StartedBy") ? "agent-market-performance-dispatcher" :
    query.includes("Cluster") ? "arn:aws:ecs:us-east-1:123:cluster/shared" : "unknown";
  if (outputText) process.stdout.write(value + "\n");
  else process.stdout.write(JSON.stringify({ Stacks: [{ Outputs: [
    { OutputKey: "ProjectName", OutputValue: "agent-market" },
    { OutputKey: "SharedEcsClusterArn", OutputValue: "arn:aws:ecs:us-east-1:123:cluster/shared" },
    { OutputKey: "TaskStartedBy", OutputValue: "agent-market-performance-dispatcher" },
    { OutputKey: "IngestionFunctionName", OutputValue: "ingestion" },
    { OutputKey: "DispatcherFunctionName", OutputValue: "dispatcher" },
    { OutputKey: "DispatcherEventSourceMappingUuid", OutputValue: "mapping" },
    { OutputKey: "ConsumerMappingUuid", OutputValue: "mapping" },
    { OutputKey: "WorkQueueUrl", OutputValue: "https://sqs.us-east-1.amazonaws.com/123/queue.fifo" },
    { OutputKey: "PauseStateParameterName", OutputValue: "/agent-market/pause" },
    { OutputKey: "LifecycleStateParameterName", OutputValue: "/agent-market/pause" },
    { OutputKey: "PerformanceClusterArn", OutputValue: "arn:aws:ecs:us-east-1:123:cluster/shared" },
    { OutputKey: "PerformanceIngestionFunctionName", OutputValue: "ingestion" },
    { OutputKey: "PerformanceDispatcherFunctionName", OutputValue: "dispatcher" },
    { OutputKey: "PerformanceDispatcherEventSourceMappingUuid", OutputValue: "mapping" },
    { OutputKey: "PerformanceWorkQueueUrl", OutputValue: "https://sqs.us-east-1.amazonaws.com/123/queue.fifo" },
    { OutputKey: "PerformancePauseStateParameterName", OutputValue: "/agent-market/pause" },
  ] }] }));
  process.exit(0);
}
if (service === "lambda" && action === "get-function-concurrency") {
  const value = option("--function-name") === "ingestion" ? state.ingestionConcurrency : state.dispatcherConcurrency;
  process.stdout.write(outputText ? String(value) + "\n" : value === "unreserved" ? "" : JSON.stringify({ ReservedConcurrentExecutions: value }));
  process.exit(0);
}
if (service === "lambda" && action === "get-event-source-mapping") {
  process.stdout.write(outputText ? state.mapping + "\n" : JSON.stringify({ State: state.mapping }));
  process.exit(0);
}
if (service === "lambda" && action === "put-function-concurrency") {
  const fn = option("--function-name"), value = Number(option("--reserved-concurrent-executions"));
  mutate("lambda:concurrency:" + fn + ":" + value, () => {
    if (fn === "ingestion") state.ingestionConcurrency = value; else state.dispatcherConcurrency = value;
  });
  process.stdout.write("{}");
  process.exit(0);
}
if (service === "lambda" && action === "delete-function-concurrency") {
  const fn = option("--function-name");
  mutate("lambda:concurrency:" + fn + ":unreserved", () => {
    if (fn === "ingestion") state.ingestionConcurrency = "unreserved"; else state.dispatcherConcurrency = "unreserved";
  });
  process.stdout.write("{}");
  process.exit(0);
}
if (service === "lambda" && action === "update-event-source-mapping") {
  const enabled = option("--enabled") === "true";
  mutate("lambda:mapping:" + enabled, () => { state.mapping = enabled ? "Enabled" : "Disabled"; });
  process.stdout.write("{}");
  process.exit(0);
}
if (service === "ecs" && action === "list-tasks") {
  if (!outputText) process.stdout.write(JSON.stringify({ taskArns: [] }));
  process.exit(0);
}
if (service === "ecs" && action === "describe-tasks") {
  process.stdout.write(JSON.stringify({ tasks: [], failures: [] }));
  process.exit(0);
}
if (service === "ecs" && action === "list-tags-for-resource") {
  process.stdout.write(JSON.stringify({ tags: [] }));
  process.exit(0);
}
if (service === "ecs" && action === "stop-task") {
  mutate("ecs:stop:" + option("--task"), () => {});
  process.stdout.write("{}");
  process.exit(0);
}
if (service === "cloudwatch") {
  process.stdout.write(outputText ? "0\n" : JSON.stringify({ Datapoints: [{ Maximum: 0 }] }));
  process.exit(0);
}
if (service === "sqs") {
  process.stdout.write(outputText ? "0\n" : JSON.stringify({ Attributes: { ApproximateNumberOfMessages: "0", ApproximateNumberOfMessagesNotVisible: "0" } }));
  process.exit(0);
}
if (service === "ssm" && action === "get-parameter") {
  if (state.parameter === null) process.exit(254);
  process.stdout.write(JSON.stringify({ Parameter: { Value: state.parameter, Version: state.version } }));
  process.exit(0);
}
if (service === "ssm" && action === "put-parameter") {
  const value = option("--value");
  let parsed;
  try { parsed = JSON.parse(value); } catch { parsed = { state: "unknown", step: "unknown" }; }
  const key = "ssm:" + parsed.state + ":" + parsed.step;
  if (state.versionConflictKey === key && state.versionConflicted !== true) {
    state.version += 1;
    state.versionConflicted = true;
  }
  mutate(key, () => { state.parameter = value; state.version += 1; });
  process.stdout.write(JSON.stringify({ Version: state.version }));
  process.exit(0);
}
process.stderr.write("unsupported fake aws call: " + args.join(" ") + "\n");
process.exit(64);
