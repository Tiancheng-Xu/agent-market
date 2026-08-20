import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = validateEvidence(readEvidence());
  if (violations.length > 0) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  }
}
