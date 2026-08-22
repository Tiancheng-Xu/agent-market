import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { parse } from "yaml";

export const EVIDENCE_STATUSES = new Set([
  "NOT_STARTED",
  "IMPLEMENTING",
  "IMPLEMENTED_UNVERIFIED",
  "VERIFIED",
  "BLOCKED",
]);

const REQUIRED_IDS = Array.from({ length: 15 }, (_, index) =>
  `REQ-AM-${String(index + 1).padStart(2, "0")}`,
);
const LIST_FIELDS = [
  "implementation_locations",
  "test_evidence",
  "deployment_evidence",
  "transaction_evidence",
  "blockers",
];
const UNSAFE_VALUE = /(?:^\/Users\/|file:\/\/|private[_-]?key|secret|password|api[_-]?key|0x0{16,}|PLACEHOLDER)/i;
export const PUBLIC_EVIDENCE_STATUSES = new Set(["verified-local", "verified-production", "pending-external", "deferred"]);
const V2_PRODUCTION_RECORDS = new Map([
  ["V2-CLOUDFLARE-ACTIONS", "docs/evidence/deployment/2026-08-21-cloudflare-pages-v2-production.json"],
  ["V2-SEPOLIA-READBACK", "docs/evidence/deployment/2026-08-21-sepolia-public-readback.json"],
]);
const REQUIRED_PUBLIC_ARTIFACTS = [
  "README.md", "docs/evidence/phase2-local-validation.json", "docs/architecture/adr/0001-defer-the-graph.md", "apps/web/src/pages/EvidencePage.tsx",
  "apps/web/public/architecture/system-context.svg", "apps/web/public/architecture/system-context.zh-CN.svg",
  "apps/web/public/architecture/request-sequence.svg", "apps/web/public/architecture/request-sequence.zh-CN.svg",
  "apps/web/public/architecture/full-delivery-chain.svg", "apps/web/public/architecture/full-delivery-chain.zh-CN.svg",
];
const PRIVATE_OR_SECRET = /(?:\/Users\/|\/home\/[^/\s]+\/|[A-Za-z]:\\Users\\|file:\/\/|\b\d{12}\b|(?:secret|password|private[_-]?key|api[_-]?key|token)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{8,})/i;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_DEPTHS = new Map([[0, new Set([1, 2, 4, 8, 16])], [2, new Set([8, 16])], [3, new Set([1, 2, 4, 8])], [4, new Set([8, 16])], [6, new Set([8, 16])]]);
const PNG_CHANNELS = new Map([[0, 1], [2, 3], [3, 1], [4, 2], [6, 4]]);

let crcTable;
function crc32(buffer) {
  crcTable ??= Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngPasses(width, height, interlace) {
  const patterns = interlace === 0 ? [[0, 0, 1, 1]] : [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
  return patterns.map(([x, y, dx, dy]) => ({
    width: width <= x ? 0 : Math.ceil((width - x) / dx),
    height: height <= y ? 0 : Math.ceil((height - y) / dy),
  })).filter((pass) => pass.width > 0 && pass.height > 0);
}

function validatePngBytes(data) {
  if (data.length < 67) return "file-too-short";
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) return "signature-invalid";
  let offset = 8; let ihdr; let sawIdat = false; let sawIend = false; const compressed = [];
  while (offset < data.length) {
    if (offset + 12 > data.length) return "chunk-truncated";
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (length > data.length || end > data.length) return "chunk-length-invalid";
    const typeBuffer = data.subarray(offset + 4, offset + 8);
    const type = typeBuffer.toString("ascii");
    const payload = data.subarray(offset + 8, offset + 8 + length);
    if (crc32(Buffer.concat([typeBuffer, payload])) !== data.readUInt32BE(offset + 8 + length)) return `crc-invalid-${type}`;
    if (offset === 8 && type !== "IHDR") return "ihdr-not-first";
    if (type === "IHDR") {
      if (ihdr !== undefined || length !== 13) return "ihdr-invalid";
      ihdr = { width: payload.readUInt32BE(0), height: payload.readUInt32BE(4), depth: payload[8], color: payload[9], compression: payload[10], filter: payload[11], interlace: payload[12] };
      if (ihdr.width === 0 || ihdr.height === 0 || ihdr.width > 32768 || ihdr.height > 32768) return "dimensions-invalid";
      if (!PNG_DEPTHS.get(ihdr.color)?.has(ihdr.depth)) return "color-depth-invalid";
      if (ihdr.compression !== 0 || ihdr.filter !== 0 || (ihdr.interlace !== 0 && ihdr.interlace !== 1)) return "ihdr-method-invalid";
    } else if (type === "IDAT") {
      if (ihdr === undefined || sawIend) return "idat-order-invalid";
      sawIdat = true; compressed.push(payload);
    } else if (type === "IEND") {
      if (length !== 0 || !sawIdat) return "iend-invalid";
      sawIend = true; offset = end; break;
    }
    offset = end;
  }
  if (ihdr === undefined || !sawIdat || !sawIend || offset !== data.length) return "png-structure-incomplete";
  let decoded;
  try { decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: 512 * 1024 * 1024 }); } catch { return "idat-undecodable"; }
  const channels = PNG_CHANNELS.get(ihdr.color);
  let cursor = 0;
  for (const pass of pngPasses(ihdr.width, ihdr.height, ihdr.interlace)) {
    const rowBytes = Math.ceil(pass.width * channels * ihdr.depth / 8);
    for (let row = 0; row < pass.height; row += 1) {
      if (cursor >= decoded.length || decoded[cursor] > 4) return "scanline-filter-invalid";
      cursor += rowBytes + 1;
    }
  }
  return cursor === decoded.length ? null : "scanline-length-invalid";
}

export function validatePngFile(path) {
  try { return validatePngBytes(readFileSync(path)); } catch { return "file-unreadable"; }
}

function validRepositoryValue(value) {
  return typeof value === "string" && value.length > 0 && !isAbsolute(value) && !UNSAFE_VALUE.test(value);
}

export function validateEvidence(document) {
  const violations = [];
  if (!document || !Array.isArray(document.requirements)) {
    return ["requirements-missing"];
  }

  const seen = new Set();
  for (const requirement of document.requirements) {
    const id = requirement?.requirement_id;
    if (typeof id !== "string") {
      violations.push("requirement-id-invalid");
      continue;
    }
    if (seen.has(id)) violations.push(`duplicate-requirement:${id}`);
    seen.add(id);
    if (!REQUIRED_IDS.includes(id)) violations.push(`unknown-requirement:${id}`);
    if (!EVIDENCE_STATUSES.has(requirement.status)) violations.push(`invalid-status:${id}`);

    for (const field of LIST_FIELDS) {
      const values = requirement[field];
      if (!Array.isArray(values)) {
        violations.push(`invalid-list:${id}:${field}`);
        continue;
      }
      for (const value of values) {
        if (!validRepositoryValue(value)) violations.push(`unsafe-evidence:${id}:${field}`);
      }
    }

    if (requirement.status === "VERIFIED") {
      if (requirement.implementation_locations?.length === 0) violations.push(`verified-without-implementation:${id}`);
      if (requirement.test_evidence?.length === 0) violations.push(`verified-without-test:${id}`);
      if (!requirement.last_verified_at) violations.push(`verified-without-date:${id}`);
      if ((requirement.deployment_evidence?.length ?? 0) === 0 && (requirement.transaction_evidence?.length ?? 0) === 0) {
        violations.push(`verified-without-external-evidence:${id}`);
      }
    }
  }

  for (const id of REQUIRED_IDS) {
    if (!seen.has(id)) violations.push(`missing-requirement:${id}`);
  }
  if (document.requirements.length !== REQUIRED_IDS.length) {
    violations.push(`requirement-count:${document.requirements.length}`);
  }
  return violations;
}

export function readEvidence(path = "docs/evidence/requirements.yaml") {
  return parse(readFileSync(path, "utf8"));
}

function stringsIn(value, location = "root", output = []) {
  if (typeof value === "string") output.push([location, value]);
  else if (Array.isArray(value)) value.forEach((item, index) => stringsIn(item, `${location}[${index}]`, output));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => stringsIn(item, `${location}.${key}`, output));
  return output;
}

function readSvgContract(path) {
  const source = readFileSync(path, "utf8");
  const root = source.match(/<svg\b([^>]*)>/)?.[1];
  if (root === undefined) return null;
  const attribute = (name) => root.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
  const width = Number(attribute("width")); const height = Number(attribute("height"));
  const viewBox = attribute("viewBox")?.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || viewBox?.length !== 4 || viewBox.some((value) => !Number.isFinite(value))) return null;
  if (viewBox[0] !== 0 || viewBox[1] !== 0 || viewBox[2] !== width || viewBox[3] !== height) return null;
  return { width, height, actors: attribute("data-actors"), lanes: attribute("data-lanes") };
}

function validateV2ProductionRecord(root, item, violations) {
  const recordPath = V2_PRODUCTION_RECORDS.get(item.id);
  if (recordPath === undefined) { violations.push(`phase2-external-overclaim:${item.id}`); return; }
  if (!item.evidence.includes(recordPath)) violations.push(`phase2-production-record-missing:${item.id}`);
  const absolute = resolve(root, recordPath);
  if (!existsSync(absolute)) return;
  let record;
  try { record = JSON.parse(readFileSync(absolute, "utf8")); } catch { violations.push(`phase2-production-record-invalid:${item.id}`); return; }
  let valid = false;
  if (item.id === "V2-CLOUDFLARE-ACTIONS") {
    const routes = new Map((record.httpReadback ?? []).map((entry) => [entry.path, entry.status]));
    const actions = record.githubActions ?? [];
    const screenshot = record.browserReadback?.screenshot;
    valid = record.project === "agent-market" && record.status === "verified-production" && record.cloudflare?.project === "agent-market-site" && record.cloudflare?.environment === "production" && record.cloudflare?.latestStage === "success" && /^[0-9a-f-]{36}$/.test(record.cloudflare?.deploymentId ?? "") && /^[0-9a-f]{40}$/.test(record.cloudflare?.mergeCommit ?? "") && routes.get("/") === 200 && routes.get("/evidence") === 200 && routes.get("/tasks/task-01/workspace") === 200 && routes.get("/missing") === 404 && actions.length >= 3 && actions.every((run) => run.conclusion === "success") && item.evidence.includes(screenshot) && record.assets?.includes(screenshot);
  } else if (item.id === "V2-SEPOLIA-READBACK") {
    const transactions = [record.transactions?.normal, record.transactions?.dispute];
    valid = record.project === "agent-market" && record.status === "verified-production" && record.network === "sepolia" && record.chainId === 11155111 && record.source === "tenderly-rpc-and-etherscan-public-html" && record.secondaryRpc?.checkedChainId === 11155111 && record.blockscout?.status === "pending-pro-api-key" && transactions.every((transaction) => /^0x[0-9a-f]{64}$/i.test(transaction?.transactionHash ?? "") && Number.isSafeInteger(transaction?.blockNumber) && transaction.status === 1 && transaction.matchingEventCount === 1 && transaction.etherscan?.statusMarker === "Success" && transaction.etherscan?.url === `https://sepolia.etherscan.io/tx/${transaction.transactionHash}` && /^[0-9a-f]{64}$/.test(transaction.etherscan?.pageSha256 ?? ""));
  }
  if (!valid) {
    violations.push(`phase2-production-record-invalid:${item.id}`);
  }
  for (const [location, value] of stringsIn(record)) if (PRIVATE_OR_SECRET.test(value)) violations.push(`unsafe-production-record:${item.id}:${location}`);
}

export function validateEvidenceRepository(root = process.cwd()) {
  const violations = [];
  for (const path of REQUIRED_PUBLIC_ARTIFACTS) if (!existsSync(resolve(root, path))) violations.push(`required-artifact-missing:${path}`);
  const phase2Path = resolve(root, "docs/evidence/phase2-local-validation.json");
  if (!existsSync(phase2Path)) return violations;
  let document;
  try { document = JSON.parse(readFileSync(phase2Path, "utf8")); } catch { return [...violations, "phase2-evidence-json-invalid"]; }
  if (document?.evidenceVersion !== 2 || document?.project !== "agent-market" || document?.snapshot !== "phase2-local-validation") violations.push("phase2-evidence-header-invalid");
  if (!Array.isArray(document?.items)) return [...violations, "phase2-evidence-items-missing"];
  const seen = new Set();
  for (const item of document.items) {
    if (!item?.id || seen.has(item.id)) violations.push(`phase2-item-id-invalid:${item?.id ?? "missing"}`); seen.add(item?.id);
    if (item.phase !== "v1" && item.phase !== "v2") violations.push(`phase-invalid:${item.id}`);
    if (!PUBLIC_EVIDENCE_STATUSES.has(item.status)) violations.push(`public-status-invalid:${item.id}`);
    if (item.phase === "v2" && item.status === "verified-production") validateV2ProductionRecord(root, item, violations);
    for (const field of ["requirement", "implementation"]) if (!item[field]?.en || !item[field]?.zh) violations.push(`bilingual-copy-missing:${item.id}:${field}`);
    for (const field of ["code", "evidence"]) {
      if (!Array.isArray(item[field])) { violations.push(`phase2-list-invalid:${item.id}:${field}`); continue; }
      for (const path of item[field]) {
        if (!validRepositoryValue(path)) violations.push(`unsafe-public-content:${item.id}:${field}`);
        else if (!existsSync(resolve(root, path))) violations.push(`referenced-artifact-missing:${path}`);
      }
    }
  }
  for (const status of PUBLIC_EVIDENCE_STATUSES) if (!document.items.some((item) => item.status === status)) violations.push(`required-status-missing:${status}`);
  const diagrams = document.assets?.diagrams;
  const evidencePagePath = resolve(root, "apps/web/src/pages/EvidencePage.tsx");
  const evidencePage = existsSync(evidencePagePath) ? readFileSync(evidencePagePath, "utf8") : "";
  if (!Array.isArray(diagrams) || diagrams.length < 3) violations.push("bilingual-diagrams-missing");
  else for (const pair of diagrams) {
    if (!pair?.en || !pair?.zh || pair.en === pair.zh) violations.push("bilingual-diagram-pair-invalid");
    for (const path of [pair?.en, pair?.zh]) if (typeof path === "string" && !existsSync(resolve(root, path))) violations.push(`referenced-asset-missing:${path}`);
    if (typeof pair?.en !== "string" || typeof pair?.zh !== "string") continue;
    const enPath = resolve(root, pair.en); const zhPath = resolve(root, pair.zh);
    if (!existsSync(enPath) || !existsSync(zhPath)) continue;
    const name = pair.en.split("/").at(-1).replace(/\.svg$/, "");
    const en = readSvgContract(enPath); const zh = readSvgContract(zhPath);
    if (en === null || zh === null || en.width !== zh.width || en.height !== zh.height) violations.push(`diagram-dimensions-mismatch:${name}`);
    if (en?.actors === undefined || zh?.actors === undefined || en.actors !== zh.actors) violations.push(`diagram-actors-mismatch:${name}`);
    if (en?.lanes === undefined || zh?.lanes === undefined || en.lanes !== zh.lanes) violations.push(`diagram-lanes-mismatch:${name}`);
    if (en !== null) {
      const declaration = new RegExp(`file:\\s*["']${name}["'][^}]*width:\\s*${en.width}[^}]*height:\\s*${en.height}`);
      if (!declaration.test(evidencePage)) violations.push(`diagram-page-dimensions-mismatch:${name}`);
    }
  }
  const screenshots = document.assets?.screenshots;
  if (!Array.isArray(screenshots) || screenshots.length === 0) violations.push("real-screenshots-missing");
  else for (const path of screenshots) {
    if (!validRepositoryValue(path)) { violations.push(`unsafe-public-content:assets.screenshots:${path}`); continue; }
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) { violations.push(`referenced-asset-missing:${path}`); continue; }
    const pngError = validatePngFile(absolute);
    if (pngError !== null) violations.push(`invalid-png:${path}:${pngError}`);
  }
  for (const [location, value] of stringsIn(document)) if (PRIVATE_OR_SECRET.test(value)) violations.push(`unsafe-public-content:${location}`);
  for (const path of ["README.md", "docs/architecture/adr/0001-defer-the-graph.md", "apps/web/src/pages/EvidencePage.tsx", ...REQUIRED_PUBLIC_ARTIFACTS.filter((path) => path.endsWith(".svg"))]) {
    const absolute = resolve(root, path); if (existsSync(absolute) && PRIVATE_OR_SECRET.test(readFileSync(absolute, "utf8"))) violations.push(`unsafe-public-file:${path}`);
  }
  return [...new Set(violations)];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = [...validateEvidence(readEvidence()), ...validateEvidenceRepository()];
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  }
}
