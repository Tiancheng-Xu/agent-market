import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");
const template = read("infra/aws/template.yaml");
const pause = read("scripts/aws/pause-agent-market.sh");
const prepare = read("scripts/aws/prepare-agent-market-cluster-transition.sh");
const deploy = read("scripts/aws/deploy-agent-market.sh");
const validator = read("scripts/aws/validate-agent-market-cluster-transition.sh");
const migration = read("database/migrations/0006_t7_recovery.sql");
const postgresLedger = read("apps/transaction-engine/src/recovery/postgres-replay-ledger.ts");
const replay = read("apps/transaction-engine/src/recovery/replay.ts");
const repositoryPolicy = read("scripts/validate-repository.mjs");
const workflow = read(".github/workflows/repository-policy.yml");
const evidence = JSON.parse(read(".tc-flow/reviews/T7.test-evidence.json"));

test("FIFO ingestion deduplicates a canonical UUIDv7 request and reuses it as the ECS token", () => {
  assert.match(template, /FifoTopic:\s*true/);
  assert.match(template, /FifoQueue:\s*true/g);
  assert.match(template, /MessageDeduplicationId=payload\["requestId"\]/);
  assert.match(template, /MessageGroupId="performance"/);
  assert.match(template, /parsed\.version != 7/);
  assert.match(template, /str\(parsed\) != value\["requestId"\]/);
  assert.match(template, /clientToken=request_id/);
  assert.doesNotMatch(template, /clientToken=message_id/);
});

test("cluster marker resolves through SSM and images are immutable digests", () => {
  assert.match(template, /ClusterTransitionMarkerSha256:\n\s+Type:\s+AWS::SSM::Parameter::Value<String>/);
  assert.match(template, /ImageTagMutability:\s+IMMUTABLE/);
  assert.match(template, /AggregatorImageDigest:/);
  assert.match(template, /AllowedPattern:\s+'\^sha256:\[a-f0-9\]\{64\}\$'/);
  assert.match(template, /RepositoryUri\}\@\$\{AggregatorImageDigest\}/);
  assert.doesNotMatch(template, /AggregatorImageTag|:latest/);
});

test("pause owns, deduplicates, stops, and drains PENDING plus RUNNING tasks", () => {
  assert.match(pause, /for desired_status in PENDING RUNNING/);
  assert.match(pause, /sort -u/);
  assert.match(pause, /--include TAGS/);
  assert.match(pause, /\.startedBy == \$started_by/);
  assert.match(pause, /\.tags.*Project/s);
  assert.match(pause, /aws_cli ecs stop-task/);
  assert.match(pause, /wait_for_project_tasks_to_clear/);
});

test("resume completes strict preflight before any mutation", () => {
  assert.match(pause, /validate_lifecycle_state/);
  assert.match(pause, /snapshotHash/);
  assert.match(pause, /priorDispatcherConcurrency \| type == "number".*priorDispatcherConcurrency == 1/s);
  assert.match(pause, /queue_has_messages_without_metric/);
  const resume = pause.slice(pause.indexOf('[[ -n "$state" ]] || { echo "pause state missing"'));
  const validate = resume.indexOf('validate_lifecycle_state "$state"');
  const firstMutation = resume.indexOf('advance_state resuming resume_started');
  assert.ok(validate >= 0 && validate < firstMutation);
  assert.match(pause, /cas_state/);
  assert.match(pause, /mapping_disabled.*ingestion_stopped.*dispatcher_stopped.*tasks_drained/s);
});

test("replay outbox is cryptographically tied to the parent identity and body", () => {
  assert.match(migration, /UNIQUE\s*\(\s*original_event_id,\s*original_request_id,\s*publisher_idempotency_key,\s*original_body_hash\s*\)/s);
  assert.match(migration, /FOREIGN KEY\s*\(\s*original_event_id,\s*original_request_id,\s*publisher_idempotency_key,\s*original_body_hash\s*\)/s);
  assert.match(migration, /original_body_hash text NOT NULL/);
  assert.match(postgresLedger, /transaction\.json\(input\.original\.body\)/);
  assert.match(postgresLedger, /input\.bodyHash/);
  assert.match(postgresLedger, /hashCanonicalJson\(row\.event_body\).*row\.original_body_hash/s);
  assert.match(replay, /hashCanonicalJson\(lease\.event\.body\).*lease\.bodyHash/s);
  assert.match(replay, /export type JSONValue/);
  assert.match(replay, /body:\s*JSONObject/);
  assert.doesNotMatch(postgresLedger, /as\s+(?:unknown|any|postgres\.JSONValue)/);
});

test("transition approval closes the change-set review TOCTOU window", () => {
  assert.match(prepare, /approval-change-set\.json/);
  assert.match(prepare, /describe-change-set/);
  assert.match(prepare, /changeSetReviewSha256/);
  assert.match(prepare, /validate_change_set_scope/);
  assert.match(prepare, /LogicalResourceId == "DispatcherFunction"/);
  assert.match(prepare, /ResourceType == "AWS::Lambda::Function"/);
  assert.match(prepare, /Replacement == "False"/);
  assert.match(prepare, /CausingEntity == "PerformanceCluster\.Arn"/);
  assert.match(prepare, /RequiresRecreation == "Never"/);
  assert.match(prepare, /approval_hash.*review_hash/s);
  assert.match(validator, /markerParameterName/);
});

test("the only supported final deploy path validates and compares marker hashes", () => {
  const validatorIndex = deploy.indexOf("validate-agent-market-cluster-transition.sh");
  const deployIndex = deploy.lastIndexOf("cloudformation deploy");
  assert.ok(validatorIndex >= 0 && validatorIndex < deployIndex);
  assert.match(deploy, /expectedResolvedValue/);
  assert.match(deploy, /markerSha256/);
  assert.match(deploy, /ClusterTransitionMarkerSha256=/);
  assert.match(deploy, /approved_final_template_sha256/);
  assert.match(deploy, /INGESTION_AUTH_SECRET_ARN/);
  assert.match(deploy, /secret:agent-market\/performance\/ingestion-hmac-/);
  assert.match(deploy, /IngestionAuthSecretArn="\$INGESTION_AUTH_SECRET_ARN"/);
  assert.match(deploy, /mktemp -d.*agent-market-template/s);
  assert.doesNotMatch(deploy, /"\$@"/);
  assert.match(repositoryPolicy, /AWS_DEPLOY_GATES/);
  assert.match(repositoryPolicy, /create-change-set/);
  assert.match(repositoryPolicy, /commandMatches/);
  assert.match(workflow, /uses:\s*Tiancheng-Xu\/\.github\/\.github\/workflows\/verify-repository-policy\.yml@main/);
});

test("T7 evidence records real PostgreSQL verification without claiming AWS", () => {
  assert.equal(evidence.externalActions.aws, false);
  assert.equal(evidence.externalActions.deploy, false);
  assert.ok(evidence.verifiedLocal.some(({ summary }) => /T7 PostgreSQL.*3\/3/.test(summary ?? "")));
  assert.ok(evidence.verifiedLocal.some(({ summary }) => /Auth.*1\/1.*Chain.*1\/1.*matcher pgvector.*pass/i.test(summary ?? "")));
  assert.ok(evidence.notVerified.some((claim) => /No AWS API was called/.test(claim)));
});
