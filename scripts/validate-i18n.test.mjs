import assert from "node:assert/strict";
import test from "node:test";

import {
  findMissingLocalizedArchitectureAssets,
  validateI18n,
} from "./validate-i18n.mjs";

test("every visible static surface has exact zh-CN copy", () => {
  assert.deepEqual(validateI18n(), []);
});

test("every localized architecture image has a zh-CN asset", () => {
  assert.deepEqual(findMissingLocalizedArchitectureAssets(), []);
});
