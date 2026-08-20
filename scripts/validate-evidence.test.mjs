import assert from "node:assert/strict";
import test from "node:test";

import { readEvidence, validateEvidence } from "./validate-evidence.mjs";

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
