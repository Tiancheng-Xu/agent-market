import { PRIVATE_OR_SECRET } from "./public-content-safety.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, realpathSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { isAbsolute, resolve, sep, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const caseRoot = resolve(fileURLToPath(new URL("../apps/web/public/cases/agent-market/", import.meta.url)));
const document = JSON.parse(readFileSync(resolve(caseRoot, "evidence.json"), "utf8"));
const views = ["runtime", "githubActions", "preview", "sequence", "canary"];
const statuses = new Set(["implemented", "planned", "unavailable", "not_applicable", "unverified"]);
const stepFields = ["title", "purpose", "designReason", "scope", "expected", "risks", "observed", "proof"];

const privateMaterial = /\/Users\/|file:\/\/|codex:\/\/|BEGIN.{0,30}PRIVATE KEY|\u4f73\u8fbe/i;


function containsPrivateMaterial(value) {
  if (typeof value === "string") return PRIVATE_OR_SECRET.test(value) || privateMaterial.test(value);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, item]) =>
      containsPrivateMaterial(item) ||
      (typeof item === "string" && PRIVATE_OR_SECRET.test(key + ": " + item))
    );
  }
  return false;
}

function violations(value, root = caseRoot) {
  const errors = [];
  if (value.schemaVersion !== 2 || value.slug !== "agent-market") errors.push("identity/schema");
  if (!Array.isArray(value.proof) || !Array.isArray(value.assets)) errors.push("proof/assets arrays");
  for (const name of views) {
    const view = value.architecture?.[name];
    if (!view || !statuses.has(view.status)) { errors.push("view:" + name); continue; }
    if (name === "runtime" && view.status !== "implemented") errors.push("runtime required");
    if (view.status === "implemented") {
      const source = view.source;
      const target = typeof source === "string" ? resolve(root, source) : "";
      if (!source || isAbsolute(source) || !target.startsWith(root + sep)) {
        errors.push("case-relative source:" + name);
      } else if (!existsSync(target)) errors.push("missing source:" + name);
      else if (!realpathSync(target).startsWith(realpathSync(root) + sep)) {
        errors.push("case-relative source:" + name);
      } else if (containsPrivateMaterial(readFileSync(target, "utf8"))) errors.push("private material");
      if (!view.description?.trim()) errors.push("description:" + name);
    } else if (!view.note?.trim()) errors.push("note:" + name);
  }
  if (!Array.isArray(value.meaningfulSteps) || !value.meaningfulSteps.length) errors.push("meaningfulSteps");
  for (const step of value.meaningfulSteps ?? []) {
    for (const field of stepFields) {
      if (typeof step[field] !== "string" || !step[field].trim()) errors.push("step:" + field);
    }
  }
  if (containsPrivateMaterial(value)) errors.push("private material");
  return errors;
}

test("public Evidence declaration satisfies its scoped contract", () => {
  assert.deepEqual(violations(document), []);
  assert.deepEqual(Object.keys(document).sort(), ["schemaVersion", "slug", "proof", "assets", "architecture", "meaningfulSteps"].sort());
  assert.deepEqual(document.proof, []);
  assert.deepEqual(document.assets, []);
  assert.match(JSON.stringify(document.meaningfulSteps), /historical.*snapshot/i);
  assert.match(JSON.stringify(document.meaningfulSteps), /0a051dd496074ce11b650948d18113536ce4e7d1/);
});

test("runtime view is a tracked scoped Mermaid source with explicit unexercised boundaries", () => {
  const source = readFileSync(resolve(caseRoot, document.architecture.runtime.source), "utf8");
  assert.match(source, /^flowchart LR/);
  assert.match(source, /Existing Edge worker/);
  assert.match(source, /not exercised/);
});

test("implemented views cannot escape the public case directory", () => {
  const candidate = structuredClone(document);
  candidate.architecture.runtime.source = "../../outside.mmd";
  assert.ok(violations(candidate).includes("case-relative source:runtime"));
});

test("private local references and missing step proof are rejected", () => {
  const candidate = structuredClone(document);
  candidate.meaningfulSteps[0].proof = "file:///Users/example/private";
  assert.ok(violations(candidate).includes("private material"));
  candidate.meaningfulSteps[0].proof = "";
  assert.ok(violations(candidate).includes("step:proof"));
});

function withCaseFixture(run) {
  const temporary = mkdtempSync(join(tmpdir(), "agent-market-evidence-"));
  const root = join(temporary, "case");
  mkdirSync(join(root, "architecture"), { recursive: true });
  writeFileSync(join(root, "architecture/runtime.mmd"), "flowchart LR\n A --> B\n");
  try { run(root, temporary); }
  finally { rmSync(temporary, { recursive: true, force: true }); }
}

test("implemented sources reject a file symlink outside the case", () => {
  withCaseFixture((root, temporary) => {
    const outside = join(temporary, "outside.mmd");
    writeFileSync(outside, "flowchart LR\n A --> B\n");
    symlinkSync(outside, join(root, "architecture/linked.mmd"));
    const candidate = structuredClone(document);
    candidate.architecture.runtime.source = "architecture/linked.mmd";
    assert.ok(violations(candidate, root).includes("case-relative source:runtime"));
  });
});

test("implemented sources reject an intermediate directory symlink outside the case", () => {
  withCaseFixture((root, temporary) => {
    const outside = join(temporary, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "runtime.mmd"), "flowchart LR\n A --> B\n");
    symlinkSync(outside, join(root, "linked"), "dir");
    const candidate = structuredClone(document);
    candidate.architecture.runtime.source = "linked/runtime.mmd";
    assert.ok(violations(candidate, root).includes("case-relative source:runtime"));
  });
});

test("implemented Mermaid bodies use the same private-material gate as JSON", () => {
  withCaseFixture((root) => {
    assert.deepEqual(violations(document, root), []);
    for (const privateText of [
      "/Users/example/private",
      "file:///private/example",
      "codex://threads/example",
      "-----BEGIN SYNTHETIC PRIVATE KEY-----",
      "\u4f73\u8fbe",
    ]) {
      writeFileSync(join(root, "architecture/runtime.mmd"), "flowchart LR\n%% " + privateText + "\n");
      assert.ok(violations(document, root).includes("private material"), privateText);
    }
  });
});

const broaderPrivateFixtures = [
  ["linux-home", "/home/example/private/report.txt"],
  ["windows-home", "C:\\Users\\example\\private\\report.txt"],
  ["secret-assignment", "secret: synthetic_example_123"],
  ["password-assignment", "password = synthetic_example_123"],
  ["private-key-assignment", "private_key: synthetic_example_123"],
  ["api-key-assignment", "api_key = synthetic_example_123"],
  ["token-assignment", "token: synthetic_example_123"],
  ["account-identifier", "account 123456789012"],
];

for (const [name, privateText] of broaderPrivateFixtures) {
  test("JSON rejects established private marker: " + name, () => {
    const candidate = structuredClone(document);
    candidate.meaningfulSteps[0].proof = privateText;
    assert.ok(violations(candidate).includes("private material"));
  });
  test("Mermaid rejects established private marker: " + name, () => {
    withCaseFixture((root) => {
      writeFileSync(join(root, "architecture/runtime.mmd"), "flowchart LR\n%% " + privateText + "\n");
      assert.ok(violations(document, root).includes("private material"));
    });
  });
}

test("JSON credential fields cannot hide assignments behind serialized key quotes", () => {
  const candidate = structuredClone(document);
  candidate.meaningfulSteps[0].metadata = { token: "synthetic_example_123" };
  assert.ok(violations(candidate).includes("private material"));
});

test("public credential boundary prose and relative source paths remain allowed", () => {
  withCaseFixture((root) => {
    const candidate = structuredClone(document);
    candidate.meaningfulSteps[0].proof = "Provider tokens remain private; API key handling is server-side. architecture/runtime.mmd";
    writeFileSync(join(root, "architecture/runtime.mmd"), "flowchart LR\n A[Public Evidence] --> B[No credential values]\n");
    assert.deepEqual(violations(candidate, root), []);
  });
});
