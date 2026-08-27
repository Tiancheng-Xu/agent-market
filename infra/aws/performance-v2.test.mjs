import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const template = readFileSync(fileURLToPath(new URL("./template.yaml", import.meta.url)), "utf8");

test("AWS ingestion accepts only bounded performance v2 metrics and render state", () => {
  assert.match(template, /DROPPED_FRAME_RATIO/);
  assert.match(template, /HYDRATION_DURATION/);
  assert.match(template, /recoverableErrorCount/);
  assert.match(template, /fallbackCount/);
  assert.match(template, /value\["schemaVersion"\] not in \(1,2\)/);
});
