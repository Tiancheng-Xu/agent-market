import assert from "node:assert/strict";
import test from "node:test";

import { isCocosGateFailure, shouldRequireCocosReady } from "./visual-route-audit-policy.mjs";

test("requires Cocos readiness unless a baseline capture explicitly disables the gate", () => {
  assert.equal(shouldRequireCocosReady(undefined), true);
  assert.equal(shouldRequireCocosReady("1"), true);
  assert.equal(shouldRequireCocosReady("0"), false);
});

test("records an unready baseline without weakening the candidate gate", () => {
  assert.equal(isCocosGateFailure({ route: "/office", ready: false, required: false }), false);
  assert.equal(isCocosGateFailure({ route: "/office", ready: false, required: true }), true);
  assert.equal(isCocosGateFailure({ route: "/", ready: false, required: true }), false);
});
