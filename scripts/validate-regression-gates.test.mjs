import assert from "node:assert/strict";
import test from "node:test";

import { validateRegressionGates } from "./validate-regression-gates.mjs";

test("accepts the canonical reverse-induction regression contract", () => {
  assert.deepEqual(validateRegressionGates(), []);
});

test("rejects partial regressions without an explicit closing action", () => {
  const contract = {
    version: 1,
    method: "Observed failures are mapped back to deterministic delivery gates.",
    items: [{
      id: "EXAMPLE-PARTIAL",
      severity: "high",
      status: "partial",
      symptom: "The visible operation has no user feedback.",
      rootCause: "Only component presence was checked before release.",
      treatment: "Add a behavior-level interaction test before release.",
      invariant: "Every operation returns a visible terminal or pending state.",
      gateIds: ["typescript"],
      evidenceFiles: ["apps/web/src/pages/DirectoryPages.tsx"]
    }]
  };
  assert.ok(validateRegressionGates(undefined, contract).includes("EXAMPLE-PARTIAL:partial-without-followUp"));
});
