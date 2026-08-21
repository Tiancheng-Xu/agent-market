import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import * as evidenceValidator from "./validate-evidence.mjs";

const { readEvidence, validateEvidence } = evidenceValidator;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function pngCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, payload = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4); length.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(pngCrc32(Buffer.concat([name, payload])));
  return Buffer.concat([length, name, payload, checksum]);
}
function minimalPng(idat = deflateSync(Buffer.from([0, 255, 0, 0, 255]))) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND")]);
}
const VALID_PNG = minimalPng();

test("accepts the canonical all-not-started ledger", () => {
  assert.deepEqual(validateEvidence(readEvidence()), []);
});

test("rejects verified requirements without external evidence", () => {
  const violations = validateEvidence({
    requirements: [{
      requirement_id: "REQ-AM-01",
      status: "VERIFIED",
      implementation_locations: ["packages/contracts/contracts/YDToken.sol"],
      test_evidence: [],
      deployment_evidence: [],
      transaction_evidence: [],
      last_verified_at: null,
      blockers: [],
    }],
  });

  assert.ok(violations.includes("verified-without-test:REQ-AM-01"));
  assert.ok(violations.includes("verified-without-external-evidence:REQ-AM-01"));
});

test("rejects private paths and duplicate requirement ids", () => {
  const document = readEvidence();
  document.requirements[0].implementation_locations = ["/Users/example/private.log"];
  document.requirements[1].requirement_id = "REQ-AM-01";
  const violations = validateEvidence(document);

  assert.ok(violations.includes("unsafe-evidence:REQ-AM-01:implementation_locations"));
  assert.ok(violations.includes("duplicate-requirement:REQ-AM-01"));
});

const requiredBundleFiles = [
  "README.md",
  "docs/architecture/adr/0001-defer-the-graph.md",
  "apps/web/src/pages/EvidencePage.tsx",
  "apps/web/public/architecture/system-context.svg",
  "apps/web/public/architecture/system-context.zh-CN.svg",
  "apps/web/public/architecture/request-sequence.svg",
  "apps/web/public/architecture/request-sequence.zh-CN.svg",
  "apps/web/public/architecture/full-delivery-chain.svg",
  "apps/web/public/architecture/full-delivery-chain.zh-CN.svg",
  "apps/web/public/evidence/real-proof.png",
];

function writeFixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-market-evidence-"));
  const items = [
    { id: "v1", phase: "v1", requirement: { en: "V1 proof", zh: "V1 证据" }, implementation: { en: "Existing deployment", zh: "已有部署" }, code: ["README.md"], evidence: ["apps/web/public/evidence/real-proof.png"], status: "verified-production" },
    { id: "v2-local", phase: "v2", requirement: { en: "Local gate", zh: "本地门禁" }, implementation: { en: "Local implementation", zh: "本地实现" }, code: ["apps/web/src/pages/EvidencePage.tsx"], evidence: ["README.md"], status: "verified-local" },
    { id: "v2-pending", phase: "v2", requirement: { en: "External gate", zh: "外部门禁" }, implementation: { en: "Not deployed", zh: "尚未部署" }, code: ["README.md"], evidence: [], status: "pending-external" },
    { id: "v2-deferred", phase: "v2", requirement: { en: "Deferred indexer", zh: "延期索引器" }, implementation: { en: "RPC first", zh: "先用 RPC" }, code: ["docs/architecture/adr/0001-defer-the-graph.md"], evidence: ["docs/architecture/adr/0001-defer-the-graph.md"], status: "deferred" },
  ];
  const document = {
    evidenceVersion: 2,
    project: "agent-market",
    snapshot: "phase2-local-validation",
    assets: {
      diagrams: [
        { en: "apps/web/public/architecture/system-context.svg", zh: "apps/web/public/architecture/system-context.zh-CN.svg" },
        { en: "apps/web/public/architecture/request-sequence.svg", zh: "apps/web/public/architecture/request-sequence.zh-CN.svg" },
        { en: "apps/web/public/architecture/full-delivery-chain.svg", zh: "apps/web/public/architecture/full-delivery-chain.zh-CN.svg" },
      ],
      screenshots: ["apps/web/public/evidence/real-proof.png"],
    },
    items,
    ...overrides,
  };
  const diagramSpecs = {
    "system-context": { width: 1600, height: 1240, actors: "browser|api|chain", lanes: "web|chain|delivery" },
    "request-sequence": { width: 1600, height: 1100, actors: "browser|api|chain", lanes: "browser|api|chain" },
    "full-delivery-chain": { width: 1600, height: 900, actors: "repository|actions|cloudflare", lanes: "local|external|deferred" },
  };
  for (const path of requiredBundleFiles) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    if (path.endsWith(".svg")) {
      const name = path.split("/").at(-1).replace(".zh-CN", "").replace(".svg", "");
      const spec = diagramSpecs[name];
      writeFileSync(absolute, `<svg width="${spec.width}" height="${spec.height}" viewBox="0 0 ${spec.width} ${spec.height}" data-actors="${spec.actors}" data-lanes="${spec.lanes}"><title>fixture</title></svg>`);
    } else if (path.endsWith("EvidencePage.tsx")) {
      writeFileSync(absolute, Object.entries(diagramSpecs).map(([file, spec]) => `{ file: "${file}", width: ${spec.width}, height: ${spec.height} }`).join("\n"));
    } else writeFileSync(absolute, path.endsWith(".png") ? VALID_PNG : "fixture\n");
  }
  const evidencePath = join(root, "docs/evidence/phase2-local-validation.json");
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(document, null, 2)}\n`);
  return { root, document };
}

test("validates the complete bilingual public Evidence bundle", (t) => {
  assert.equal(typeof evidenceValidator.validateEvidenceRepository, "function");
  const { root } = writeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(evidenceValidator.validateEvidenceRepository(root), []);
});

test("rejects missing bilingual diagrams and referenced screenshots", (t) => {
  const { root } = writeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  rmSync(join(root, "apps/web/public/architecture/system-context.zh-CN.svg"));
  rmSync(join(root, "apps/web/public/evidence/real-proof.png"));
  const violations = evidenceValidator.validateEvidenceRepository(root);
  assert.ok(violations.includes("required-artifact-missing:apps/web/public/architecture/system-context.zh-CN.svg"));
  assert.ok(violations.includes("referenced-asset-missing:apps/web/public/evidence/real-proof.png"));
});

test("rejects unsafe public content, absent statuses, and V2 production overclaim", (t) => {
  const { root, document } = writeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  document.items = document.items.filter((item) => item.status !== "deferred");
  document.items[1].code = ["/Users/example/private.txt"];
  document.items[1].implementation.en = "secret=not-for-publication";
  document.items[2].status = "verified-production";
  writeFileSync(join(root, "docs/evidence/phase2-local-validation.json"), `${JSON.stringify(document, null, 2)}\n`);
  const violations = evidenceValidator.validateEvidenceRepository(root);
  assert.ok(violations.some((value) => value.startsWith("unsafe-public-content:")));
  assert.ok(violations.includes("required-status-missing:deferred"));
  assert.ok(violations.includes("phase2-external-overclaim:v2-pending"));
});

test("rejects a text file renamed as PNG", (t) => {
  const { root } = writeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "apps/web/public/evidence/real-proof.png"), "not a png\n");
  assert.ok(evidenceValidator.validateEvidenceRepository(root).some((value) => value.includes("invalid-png:apps/web/public/evidence/real-proof.png")));
});

test("rejects truncated, CRC-corrupt, and zlib-undecodable PNG structures", (t) => {
  const { root } = writeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "apps/web/public/evidence/real-proof.png");
  writeFileSync(path, VALID_PNG.subarray(0, VALID_PNG.length - 9));
  assert.ok(evidenceValidator.validateEvidenceRepository(root).some((value) => value.includes("invalid-png:apps/web/public/evidence/real-proof.png")));
  const corrupt = Buffer.from(VALID_PNG);
  const idatType = corrupt.indexOf(Buffer.from("IDAT", "ascii"));
  corrupt[idatType + 4] ^= 0xff;
  writeFileSync(path, corrupt);
  assert.ok(evidenceValidator.validateEvidenceRepository(root).some((value) => value.includes("crc-invalid-IDAT")));
  writeFileSync(path, minimalPng(Buffer.alloc(16, 0xff)));
  assert.ok(evidenceValidator.validateEvidenceRepository(root).some((value) => value.includes("idat-undecodable")));
});

test("rejects architecture dimension, actor, and lane drift across languages and page declarations", (t) => {
  const { root } = writeFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "apps/web/public/architecture/system-context.svg"), '<svg width="1600" height="1050" viewBox="0 0 1600 1050" data-actors="browser|api|chain" data-lanes="web|chain|delivery" />');
  writeFileSync(join(root, "apps/web/public/architecture/request-sequence.zh-CN.svg"), '<svg width="1600" height="1100" viewBox="0 0 1600 1100" data-actors="browser|missing-lane" data-lanes="browser|api|chain" />');
  writeFileSync(join(root, "apps/web/public/architecture/full-delivery-chain.zh-CN.svg"), '<svg width="1600" height="900" viewBox="0 0 1600 900" data-actors="repository|actions|cloudflare" data-lanes="local|external" />');
  const violations = evidenceValidator.validateEvidenceRepository(root);
  assert.ok(violations.includes("diagram-dimensions-mismatch:system-context"));
  assert.ok(violations.includes("diagram-actors-mismatch:request-sequence"));
  assert.ok(violations.includes("diagram-lanes-mismatch:full-delivery-chain"));
});
