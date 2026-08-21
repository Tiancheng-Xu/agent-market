import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sourceScript = new URL("./deploy-agent-market.sh", import.meta.url);
const digest = `sha256:${"a".repeat(64)}`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function fixture({ replaceAfterValidation = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-market-deploy-"));
  mkdirSync(join(root, "scripts/aws"), { recursive: true });
  mkdirSync(join(root, "infra/aws"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  copyFileSync(sourceScript, join(root, "scripts/aws/deploy-agent-market.sh"));
  chmodSync(join(root, "scripts/aws/deploy-agent-market.sh"), 0o755);
  const template = "Resources: {}\n";
  writeFileSync(join(root, "infra/aws/template.yaml"), template);
  const approvedHash = sha256(template);
  writeFileSync(join(root, "scripts/aws/validate-agent-market-cluster-transition.sh"), `#!/usr/bin/env bash\n${replaceAfterValidation ? "printf 'Resources: {Injected: true}\\n' > infra/aws/template.yaml\n" : ""}printf '%s\\n' '{"markerParameterName":"/marker","markerSha256":"marker-hash","expectedResolvedValue":"marker-hash","finalTemplateSha256":"${approvedHash}"}'\n`);
  chmodSync(join(root, "scripts/aws/validate-agent-market-cluster-transition.sh"), 0o755);
  writeFileSync(join(root, "bin/aws"), `#!/usr/bin/env bash\nif [[ "$*" == *"ssm get-parameter"* ]]; then printf '%s\\n' marker-hash; else printf '%s\\n' "$*" >> "${join(root, "aws.log")}"; fi\n`);
  chmodSync(join(root, "bin/aws"), 0o755);
  return { root, approvedHash };
}

function run(root, extra = []) {
  return spawnSync("bash", ["scripts/aws/deploy-agent-market.sh", "agent-market", "arn:aws:ecs:us-east-1:123456789012:cluster/shared", digest, "us-east-1", ...extra], {
    cwd: root,
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
    encoding: "utf8",
  });
}

test("rejects duplicate critical deployment arguments before any CloudFormation call", () => {
  const { root } = fixture();
  try {
    const result = run(root, ["--template-file", "unapproved.yaml"]);
    assert.equal(result.status, 64);
    assert.equal(readFileSync(join(root, "aws.log"), { encoding: "utf8", flag: "a+" }), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects a template replaced after approval and deploys only a read-only frozen copy", () => {
  const replaced = fixture({ replaceAfterValidation: true });
  try {
    const result = run(replaced.root);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(replaced.root, "aws.log"), { encoding: "utf8", flag: "a+" }), "");
  } finally { rmSync(replaced.root, { recursive: true, force: true }); }

  const stable = fixture();
  try {
    const result = run(stable.root);
    assert.equal(result.status, 0, result.stderr);
    const command = readFileSync(join(stable.root, "aws.log"), "utf8");
    assert.doesNotMatch(command, /infra\/aws\/template\.yaml/u);
    const match = command.match(/--template-file ([^ ]+)/u);
    assert.ok(match);
    assert.match(match[1], /agent-market-template\./u);
  } finally { rmSync(stable.root, { recursive: true, force: true }); }
});
