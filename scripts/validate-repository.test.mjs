import assert from "node:assert/strict";
import test from "node:test";

import { validateRepository } from "./validate-repository.mjs";

test("requires every architecture runtime directory", () => {
	const violations = validateRepository(process.cwd());
	assert.deepEqual(violations, []);
});
