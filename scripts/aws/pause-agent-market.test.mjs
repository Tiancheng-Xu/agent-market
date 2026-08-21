import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const sourceScript = new URL("./pause-agent-market.sh", import.meta.url);
const fakeAws = new URL("./test-fixtures/fake-pause-aws.cjs", import.meta.url);
const initialState = () => ({
  mapping: "Enabled", ingestionConcurrency: 3, dispatcherConcurrency: 1,
  parameter: null, version: 0, mutations: [], failKey: null, failed: false,
});

function fixture(state = initialState()) {
  const root = mkdtempSync(join(tmpdir(), "agent-market-pause-"));
  mkdirSync(join(root, "scripts/aws"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  copyFileSync(sourceScript, join(root, "scripts/aws/pause-agent-market.sh"));
  copyFileSync(fakeAws, join(root, "bin/aws"));
  chmodSync(join(root, "scripts/aws/pause-agent-market.sh"), 0o755);
  chmodSync(join(root, "bin/aws"), 0o755);
  const statePath = join(root, "state.json");
  writeFileSync(statePath, JSON.stringify(state));
  return { root, statePath };
}

function run(root, statePath, action) {
  return spawnSync("bash", ["scripts/aws/pause-agent-market.sh", action, "agent-market", "us-east-1"], {
    cwd: root,
    env: { ...process.env, PATH: join(root, "bin") + ":" + process.env.PATH, FAKE_AWS_STATE: statePath },
    encoding: "utf8",
  });
}
const readState = (path) => JSON.parse(readFileSync(path, "utf8"));

test("continues idempotently after one injected failure at every AWS mutation", () => {
  const baseline = fixture();
  let mutationKeys;
  try {
    const paused = run(baseline.root, baseline.statePath, "pause");
    if (paused.status !== 0) throw new Error(paused.stderr + JSON.stringify(readState(baseline.statePath)));
    const resumed = run(baseline.root, baseline.statePath, "resume");
    if (resumed.status !== 0) throw new Error(resumed.stderr + JSON.stringify(readState(baseline.statePath)));
    mutationKeys = [...new Set(readState(baseline.statePath).mutations)];
    assert.ok(mutationKeys.length >= 10);
  } finally { rmSync(baseline.root, { recursive: true, force: true }); }

  for (const failKey of mutationKeys) {
    const current = fixture({ ...initialState(), failKey });
    try {
      const isResume = failKey.includes("resuming") || failKey.includes("resumed")
        || failKey === "lambda:concurrency:ingestion:3"
        || failKey === "lambda:concurrency:dispatcher:1"
        || failKey === "lambda:mapping:true";
      if (isResume) assert.equal(run(current.root, current.statePath, "pause").status, 0, failKey);
      const action = isResume ? "resume" : "pause";
      assert.notEqual(run(current.root, current.statePath, action).status, 0, failKey);
      assert.equal(run(current.root, current.statePath, action).status, 0, failKey);
      if (!isResume) assert.equal(run(current.root, current.statePath, "resume").status, 0, failKey);
      const state = readState(current.statePath);
      assert.equal(state.mapping, "Enabled", failKey);
      assert.equal(state.ingestionConcurrency, 3, failKey);
      assert.equal(state.dispatcherConcurrency, 1, failKey);
      assert.equal(JSON.parse(state.parameter).state, "resumed", failKey);
    } finally { rmSync(current.root, { recursive: true, force: true }); }
  }
});

test("detects an SSM version race and continues from the written idempotent step", () => {
  const current = fixture({
    ...initialState(),
    versionConflictKey: "ssm:pausing:mapping_disabled",
    versionConflicted: false,
  });
  try {
    assert.notEqual(run(current.root, current.statePath, "pause").status, 0);
    assert.equal(run(current.root, current.statePath, "pause").status, 0);
    assert.equal(run(current.root, current.statePath, "resume").status, 0);
    const state = readState(current.statePath);
    assert.equal(state.mapping, "Enabled");
    assert.equal(state.ingestionConcurrency, 3);
    assert.equal(state.dispatcherConcurrency, 1);
    assert.equal(JSON.parse(state.parameter).state, "resumed");
  } finally { rmSync(current.root, { recursive: true, force: true }); }
});

test("rejects every dispatcher snapshot except integer one before any mutation", () => {
  for (const dispatcherConcurrency of ["unreserved", 0, 2]) {
    const current = fixture({ ...initialState(), dispatcherConcurrency });
    try {
      const result = run(current.root, current.statePath, "pause");
      assert.notEqual(result.status, 0, String(dispatcherConcurrency));
      const state = readState(current.statePath);
      assert.deepEqual(state.mutations, [], String(dispatcherConcurrency));
      assert.equal(state.parameter, null, String(dispatcherConcurrency));
      assert.equal(state.mapping, "Enabled", String(dispatcherConcurrency));
      assert.equal(state.ingestionConcurrency, 3, String(dispatcherConcurrency));
      assert.equal(state.dispatcherConcurrency, dispatcherConcurrency, String(dispatcherConcurrency));
    } finally { rmSync(current.root, { recursive: true, force: true }); }
  }
});
