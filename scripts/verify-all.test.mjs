import assert from "node:assert/strict";
import test from "node:test";

import { VERIFY_COMMANDS } from "./verify-all.mjs";

test("verification contains every runtime and no deploy command", () => {
  assert.deepEqual(VERIFY_COMMANDS.map((item) => item.id), [
    "repository",
    "regression-contract",
    "i18n",
    "i18n-routes",
    "evidence",
    "typescript",
    "contracts",
    "go",
    "python",
  ]);
  assert.equal(
    VERIFY_COMMANDS.some((item) => /deploy|wrangler|terraform apply|hardhat run/.test(item.command)),
    false,
  );
});
