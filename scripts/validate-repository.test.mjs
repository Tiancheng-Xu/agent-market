import assert from "node:assert/strict";
import test from "node:test";

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateAwsDeployPolicy, validateRepository } from "./validate-repository.mjs";

test("requires every architecture runtime directory", () => {
	const violations = validateRepository(process.cwd());
	assert.deepEqual(violations, []);
});

test("verification workflows use Node 24 action runtimes and never deploy", () => {
  const workflows = [
    ".github/workflows/aws-performance-verify.yml",
    ".github/workflows/verify.yml",
  ].map((path) => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(workflows, /actions\/checkout@v4|actions\/setup-node@v4|actions\/setup-go@v5|actions\/setup-python@v5|pnpm\/action-setup@v4/);
  assert.match(workflows, /actions\/checkout@v5/);
  assert.match(workflows, /actions\/setup-node@v5/);
  assert.match(workflows, /actions\/setup-go@v6/);
  assert.match(workflows, /actions\/setup-python@v6/);
  assert.equal([...workflows.matchAll(/actions\/setup-node@v5[\s\S]{0,160}?package-manager-cache:\s*false/g)].length, 2);
  assert.doesNotMatch(workflows, /\b(?:deploy|wrangler deploy|terraform apply)\b/i);
});

test("rejects bare AWS deploy commands outside the mandatory gate", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-market-policy-"));
  try {
    mkdirSync(join(root, "scripts/aws"), { recursive: true });
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, "scripts/aws/unsafe.sh"), "aws cloudformation deploy --stack-name unsafe\n");
    assert.deepEqual(validateAwsDeployPolicy(root), ["aws-deploy-command-outside-gate:scripts/aws/unsafe.sh:1"]);
    rmSync(join(root, "scripts/aws/unsafe.sh"));
    writeFileSync(join(root, "scripts/aws/deploy-agent-market.sh"), "aws cloudformation deploy --stack-name gated\n");
    assert.deepEqual(validateAwsDeployPolicy(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects multiline and programmatic CloudFormation mutations outside exact gates", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-market-policy-bypass-"));
  try {
    mkdirSync(join(root, "scripts/aws"), { recursive: true });
    mkdirSync(join(root, "tools"), { recursive: true });
    writeFileSync(join(root, "scripts/aws/multiline.sh"), "aws \\\n+ cloudformation deploy --stack-name unsafe\n");
    writeFileSync(join(root, "tools/deploy.mjs"), "execFileSync('aws', ['cloudformation', 'execute-change-set', '--change-set-name', 'unsafe']);\n");
    writeFileSync(join(root, "tools/deploy.py"), "subprocess.run(['aws', 'cloudformation', 'update-stack', '--stack-name', 'unsafe'])\n");
    writeFileSync(join(root, "Makefile"), "deploy:\n\taws cloudformation create-change-set --stack-name unsafe\n");
    assert.deepEqual(validateAwsDeployPolicy(root), [
      "aws-deploy-command-outside-gate:scripts/aws/multiline.sh:1",
      "aws-execute-change-set-command-outside-gate:tools/deploy.mjs:1",
      "aws-update-stack-command-outside-gate:tools/deploy.py:1",
      "aws-create-change-set-command-outside-gate:Makefile:2",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores comments and test fixtures while preserving exact production allowlists", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-market-policy-fixture-"));
  try {
    mkdirSync(join(root, "scripts/aws"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "scripts/aws/deploy-agent-market.sh"), "aws cloudformation deploy --stack-name approved\n");
    writeFileSync(join(root, "scripts/aws/prepare-agent-market-cluster-transition.sh"), "aws cloudformation create-change-set --stack-name approved\naws cloudformation execute-change-set --stack-name approved\n");
    writeFileSync(join(root, "tests/policy.test.mjs"), "const fixture = ['aws', 'cloudformation', 'deploy'];\n");
    writeFileSync(join(root, "scripts/aws/comment.py"), "# aws cloudformation update-stack --stack-name ignored\n");
    assert.deepEqual(validateAwsDeployPolicy(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finds CloudFormation actions after ordered global and service options", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-market-policy-options-"));
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "tools"), { recursive: true });
    writeFileSync(join(root, "scripts/options.sh"), [
      "aws --profile prod --region us-east-1 --endpoint-url https://example.invalid --ca-bundle ca.pem --cli-connect-timeout 10 --cli-read-timeout 30 --output json --query Stacks --no-cli-pager --no-paginate --cli-auto-prompt --no-cli-auto-prompt cloudformation --endpoint-url https://example.invalid --region us-east-1 --profile prod deploy --stack-name unsafe",
      "aws --region us-east-1 cloudformation --endpoint-url https://example.invalid --cli-read-timeout 30 --profile prod update-stack --stack-name unsafe",
    ].join("\n"));
    writeFileSync(join(root, "tools/options.mjs"), [
      "execFileSync('aws', ['--profile', 'prod', '--region', 'us-east-1', '--endpoint-url', 'https://example.invalid', '--ca-bundle', 'ca.pem', '--cli-connect-timeout', '10', '--cli-read-timeout', '30', '--output', 'json', '--query', 'Stacks', '--no-cli-pager', '--no-paginate', '--cli-auto-prompt', '--no-cli-auto-prompt', 'cloudformation', '--endpoint-url', 'https://example.invalid', '--region', 'us-east-1', 'create-change-set']);",
      "spawnSync('aws', ['--no-cli-pager', 'cloudformation', '--region', 'us-east-1', '--profile', 'prod', '--cli-read-timeout', '30', 'execute-change-set']);",
    ].join("\n"));
    assert.deepEqual(validateAwsDeployPolicy(root), [
      "aws-deploy-command-outside-gate:scripts/options.sh:1",
      "aws-update-stack-command-outside-gate:scripts/options.sh:2",
      "aws-create-change-set-command-outside-gate:tools/options.mjs:1",
      "aws-execute-change-set-command-outside-gate:tools/options.mjs:2",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("documents dynamic CloudFormation command construction as a scanner residual", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-market-policy-dynamic-"));
  try {
    mkdirSync(join(root, "tools"), { recursive: true });
    writeFileSync(join(root, "tools/dynamic.mjs"), "execFileSync('aws', ['cloud' + 'formation', 'de' + 'ploy']);\n");
    assert.deepEqual(validateAwsDeployPolicy(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports unknown options before a static CloudFormation action", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-market-policy-unknown-option-"));
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "tools"), { recursive: true });
    writeFileSync(join(root, "scripts/unknown.sh"), "aws --future-global value cloudformation deploy --stack-name unsafe\n");
    writeFileSync(join(root, "tools/unknown.mjs"), "execFileSync('aws', ['cloudformation', '--future-service', 'value', 'execute-change-set']);\n");
    assert.deepEqual(validateAwsDeployPolicy(root), [
      "aws-cloudformation-unknown-option:scripts/unknown.sh:1:--future-global",
      "aws-cloudformation-unknown-option:tools/unknown.mjs:1:--future-service",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
