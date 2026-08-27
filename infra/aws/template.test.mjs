import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const template = readFileSync(here("./template.yaml"), "utf8");
const pauseScriptPath = here("../../scripts/aws/pause-agent-market.sh");
const prepareScriptPath = here("../../scripts/aws/prepare-agent-market-cluster-transition.sh");
const validateScriptPath = here("../../scripts/aws/validate-agent-market-cluster-transition.sh");
const pauseScript = readFileSync(pauseScriptPath, "utf8");
const prepareScript = readFileSync(prepareScriptPath, "utf8");
const validateScript = readFileSync(validateScriptPath, "utf8");
const migration = readFileSync(here("../../database/migrations/0006_t7_recovery.sql"), "utf8");

function resourceBlock(name) {
  const marker = `\n  ${name}:\n`;
  const start = template.indexOf(marker);
  assert.notEqual(start, -1, `resource ${name} must exist`);
  const bodyStart = start + marker.length;
  const following = template.slice(bodyStart);
  const next = following.search(/\n  [A-Za-z][A-Za-z0-9]+:\n/u);
  return following.slice(0, next === -1 ? undefined : next);
}

function inlinePython(resourceName) {
  const block = resourceBlock(resourceName);
  const marker = "      ZipFile: |\n";
  const start = block.indexOf(marker);
  assert.notEqual(start, -1, `${resourceName} must contain inline Python`);
  return block.slice(start + marker.length)
    .split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
}

function assertPythonCompiles(source, label) {
  const result = spawnSync("python3", ["-c", "import sys; compile(sys.stdin.read(), '<inline>', 'exec')"], {
    input: source,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${label} failed Python compilation: ${result.stderr}`);
}

function assertBashSyntax(path) {
  const result = spawnSync("bash", ["-n", path], { encoding: "utf8" });
  assert.equal(result.status, 0, `${path} failed bash -n: ${result.stderr}`);
}

test("executes fail-closed HMAC authentication before parsing and SNS publish", () => {
  const role = resourceBlock("IngestionRole");
  const fn = resourceBlock("IngestionFunction");
  const code = inlinePython("IngestionFunction");
  assert.match(role, /Action: secretsmanager:GetSecretValue\s*\n\s*Resource: !Ref IngestionAuthSecretArn/u);
  assert.match(fn, /AUTH_WINDOW_SECONDS: "300"/u);
  assert.ok(code.indexOf("if not authenticated(headers,raw)") < code.indexOf("payload=json.loads(raw)"));
  assert.ok(code.indexOf("if not authenticated(headers,raw)") < code.indexOf("sns.publish("));
  assert.match(code, /hmac\.compare_digest\(expected,signature\)/u);
  assert.match(code, /MessageGroupId="performance"/u);
  assert.ok(code.includes('except Exception: return response(503,{"error":"INGESTION_AUTH_UNAVAILABLE"})'));
  assertPythonCompiles(code, "ingestion inline code");
});

test("enforces one project task and durable ECS task identity before RunTask", () => {
  const fn = resourceBlock("DispatcherFunction");
  const mapping = resourceBlock("PerformanceConsumerMapping");
  const code = inlinePython("DispatcherFunction");
  assert.doesNotMatch(fn, /ReservedConcurrentExecutions:/u);
  assert.match(mapping, /BatchSize: 1/u);
  assert.match(mapping, /FunctionResponseTypes:\s*\n\s*- ReportBatchItemFailures/u);
  assert.match(mapping, /MaximumConcurrency: 2/u);
  assert.match(mapping, /AWS requires at least 2/u);
  assert.ok(code.includes('for desired in ("PENDING","RUNNING")'));
  assert.ok(code.indexOf("reconcile_existing_tasks()") < code.indexOf("ecs.run_task("));
  assert.match(code, /clientToken=request_id/u);
  assert.match(code, /parsed\.version != 7/u);
  assert.ok(code.includes('{"key":"Project","value":os.environ["PROJECT_NAME"]}'));
  assert.match(code, /HardDeadlineSeconds/u);
  assert.match(code, /for attempt in range\(3\)/u);
  assert.match(code, /ECS_STOP_WAIT_TIMEOUT/u);
  assert.doesNotMatch(code, /except Exception:\s*pass/u);
  assertPythonCompiles(code, "dispatcher inline code");
});

test("scopes ECS task control and replaces the broad execution managed policy", () => {
  const executionRole = resourceBlock("TaskExecutionRole");
  const dispatcherRole = resourceBlock("DispatcherRole");
  assert.doesNotMatch(executionRole, /AmazonECSTaskExecutionRolePolicy/u);
  assert.match(executionRole, /Action: ecr:GetAuthorizationToken\s*\n\s*Resource: "\*"/u);
  assert.match(executionRole, /ecr:BatchGetImage[\s\S]*Resource: !GetAtt AggregatorRepository\.Arn/u);
  assert.ok(executionRole.includes('Resource: !Sub ${AggregatorLogGroup.Arn}:*'));
  assert.match(dispatcherRole, /Action: ecs:ListTasks\s*\n\s*Resource: "\*"[\s\S]*ecs:cluster: !Ref SharedEcsClusterArn/u);
  assert.match(dispatcherRole, /ecs:DescribeTasks[\s\S]*ecs:StopTask/u);
  assert.ok(dispatcherRole.includes('task/${ClusterName}/*'));
  assert.match(dispatcherRole, /aws:ResourceTag\/Project: !Ref ProjectName/u);
  assert.match(dispatcherRole, /Action: ecs:TagResource[\s\S]*aws:RequestTag\/Project: !Ref ProjectName/u);
  assert.match(dispatcherRole, /iam:PassedToService: ecs-tasks\.amazonaws\.com/u);
});

test("requires an approved two-phase marker and provides executable fail-closed scripts", () => {
  const parameter = template.match(/  ClusterTransitionMarkerSha256:\n([\s\S]*?)\n  IngestionAuthSecretArn:/u);
  assert.ok(parameter);
  assert.match(parameter[1], /Type: AWS::SSM::Parameter::Value<String>/u);
  assert.doesNotMatch(parameter[1], /\n\s+Default:/u);
  assert.doesNotMatch(template, /Type:\s*AWS::ECS::Cluster/u);
  assert.match(prepareScript, /create-change-set/u);
  assert.match(prepareScript, /inject-agent-market-cluster-retain\.mjs/u);
  assert.doesNotMatch(prepareScript, /from "yaml"|parse\(|stringify\(/u);
  assert.match(prepareScript, /APPROVE_TOKEN/u);
  assert.match(prepareScript, /execute-change-set/u);
  assert.ok(prepareScript.indexOf("explicit approval token mismatch") < prepareScript.indexOf("execute-change-set"));
  assert.match(prepareScript, /describe-stack-resource/u);
  assert.match(prepareScript, /approval_hash.*review_hash/su);
  assert.match(validateScript, /final template hash mismatch/u);
  assertBashSyntax(prepareScriptPath);
  assertBashSyntax(validateScriptPath);
});

test("uses exact pause state restoration and fails closed without queue age", () => {
  assert.match(template, /Type: AWS::SSM::Parameter[\s\S]*Tier: Standard/u);
  assert.match(pauseScript, /priorIngestionConcurrency/u);
  assert.match(pauseScript, /priorDispatcherConcurrency/u);
  assert.match(pauseScript, /validate_resume_state/u);
  assert.match(pauseScript, /lifecycle state schema or ownership invalid/u);
  assert.match(pauseScript, /queue_has_messages_without_metric/u);
  assert.ok(pauseScript.includes('restore_concurrency "$DISPATCHER_FUNCTION"'));
  assert.ok(pauseScript.includes('restore_concurrency "$INGESTION_FUNCTION"'));
  assert.ok(pauseScript.includes('--started-by "$STARTED_BY"'));
  assert.doesNotMatch(pauseScript, /delete-stack|delete-cluster|SharedDatabase/u);
  assertBashSyntax(pauseScriptPath);
});

test("hardens the replay migration for expiring leases and body identity", () => {
  for (const column of ["attempt integer", "next_attempt_at timestamptz", "lease_token uuid", "lease_until timestamptz"]) {
    assert.match(migration, new RegExp(column, "u"));
  }
  assert.match(migration, /WHERE status IN \('pending', 'publishing', 'failed'\)/u);
  assert.match(migration, /event_body \? 'eventId'/u);
  assert.match(migration, /event_body \? 'requestId'/u);
  assert.match(migration, /CHECK \(status <> 'publishing' OR lease_until IS NOT NULL\)/u);
});

test("keeps shared foundations absent and workload cost bounded", () => {
  for (const forbidden of ["AWS::EC2::VPC", "AWS::EC2::NatGateway", "AWS::RDS::DBInstance", "AWS::ECS::Cluster", "AWS::ECS::Service"]) {
    assert.doesNotMatch(template, new RegExp(`Type:\\s*${forbidden.replaceAll("::", "\\:\\:")}\\s*(?:\\n|$)`));
  }
  assert.match(template, /MessageRetentionPeriod: 1209600/u);
  assert.match(template, /maxReceiveCount: 2/u);
  assert.match(template, /RetentionInDays: 7/u);
  assert.match(template, /PerformanceApiAccessLogGroup:[\s\S]*LogGroupName: !Sub \/aws\/apigateway\/\$\{ProjectName\}-performance[\s\S]*RetentionInDays: 7/u);
  assert.match(template, /AccessLogSettings:[\s\S]*DestinationArn: !GetAtt PerformanceApiAccessLogGroup\.Arn[\s\S]*"requestId"[\s\S]*"status"/u);
  assert.doesNotMatch(template, /AccessLogSettings:[\s\S]{0,500}(sourceIp|userAgent|requestBody)/u);
  assert.match(template, /Cpu: "256"/u);
  assert.match(template, /Memory: "512"/u);
  assert.match(template, /Volumes:\s*\n\s*- Name: tmp/u);
  assert.match(template, /ReadonlyRootFilesystem: true/u);
  assert.match(template, /MountPoints:[\s\S]*SourceVolume: tmp[\s\S]*ContainerPath: \/tmp[\s\S]*ReadOnly: false/u);
  assert.match(template, /Name: PYTHONDONTWRITEBYTECODE\s*\n\s*Value: "1"/u);
  assert.match(template, /assignPublicIp"?\s*:\s*"DISABLED"/u);
  assert.match(template, /DenyInsecureTransport[\s\S]*aws:SecureTransport: false/u);
  assert.match(template, /RedriveAllowPolicy:[\s\S]*redrivePermission: byQueue/u);
});
