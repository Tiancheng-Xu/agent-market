import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedStatuses = new Set(["enforced", "partial", "planned"]);
const allowedSeverities = new Set(["critical", "high", "medium", "low"]);

export function validateRegressionGates(base = root, contractOverride) {
  const contractPath = path.join(base, "docs/quality/reverse-induction-gates.json");
  const contract = contractOverride ?? JSON.parse(readFileSync(contractPath, "utf8"));
  const verifySource = readFileSync(path.join(base, "scripts/verify-all.mjs"), "utf8");
  const workflowSource = readFileSync(path.join(base, ".github/workflows/verify.yml"), "utf8");
  const knownGateIds = new Set([...verifySource.matchAll(/id:\s*"([^"]+)"/g)].map((match) => match[1]));
  const violations = [];
  const ids = new Set();

  if (contract.version !== 1 || typeof contract.method !== "string" || contract.method.length < 20) violations.push("contract:invalid-header");
  if (!Array.isArray(contract.items) || contract.items.length === 0) return [...violations, "contract:no-items"];

  for (const item of contract.items) {
    const prefix = typeof item.id === "string" ? item.id : "UNKNOWN";
    if (!/^[A-Z0-9-]+$/.test(prefix)) violations.push(`${prefix}:invalid-id`);
    if (ids.has(prefix)) violations.push(`${prefix}:duplicate-id`);
    ids.add(prefix);
    if (!allowedStatuses.has(item.status)) violations.push(`${prefix}:invalid-status`);
    if (!allowedSeverities.has(item.severity)) violations.push(`${prefix}:invalid-severity`);
    for (const field of ["symptom", "rootCause", "treatment", "invariant"]) {
      if (typeof item[field] !== "string" || item[field].length < 12) violations.push(`${prefix}:missing-${field}`);
    }
    if (!Array.isArray(item.gateIds) || item.gateIds.length === 0) violations.push(`${prefix}:missing-gateIds`);
    for (const gateId of item.gateIds ?? []) if (!knownGateIds.has(gateId)) violations.push(`${prefix}:unknown-gate:${gateId}`);
    if (!Array.isArray(item.evidenceFiles) || item.evidenceFiles.length === 0) violations.push(`${prefix}:missing-evidenceFiles`);
    for (const file of item.evidenceFiles ?? []) if (!existsSync(path.join(base, file))) violations.push(`${prefix}:missing-file:${file}`);
    if (item.status !== "enforced" && (typeof item.followUp !== "string" || item.followUp.length < 12)) violations.push(`${prefix}:partial-without-followUp`);
  }

  if (!workflowSource.includes("Run reverse-induction regression gates")) violations.push("workflow:missing-explicit-regression-step");
  if (!workflowSource.includes("node scripts/validate-regression-gates.mjs")) violations.push("workflow:missing-regression-contract-command");
  if (!workflowSource.includes("pnpm verify")) violations.push("workflow:missing-local-remote-parity");
  return violations.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = validateRegressionGates();
  if (violations.length > 0) {
    console.error(`[regression-gates] FAIL: ${violations.length} contract violations`);
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log("[regression-gates] PASS: observed problems map to causes, treatments, local gates, and remote PR enforcement");
  }
}
