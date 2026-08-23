import assert from "node:assert/strict";
import test from "node:test";

import { validateI18n } from "./validate-i18n.mjs";

test("every visible static surface has exact zh-CN copy", () => {
  assert.deepEqual(validateI18n(), []);
});
