import assert from "node:assert/strict";
import test from "node:test";

import { compactLogs, compactTransaction } from "./readback-agent-market.mjs";

const txHash = `0x${"12".repeat(32)}`;
const contract = "0x1111111111111111111111111111111111111111";
const topic = `0x${"34".repeat(32)}`;

test("readback transaction schema is fail-closed", () => {
  const base = {
    hash: txHash, status: "ok", block_number: 100, confirmations: 2,
    from: contract, to: contract, value: "0", raw_input: "0x12345678",
  };
  assert.equal(compactTransaction(base, txHash).selector, "0x12345678");
  for (const field of ["status", "value", "raw_input"]) {
    assert.throws(() => compactTransaction({ ...base, [field]: null }, txHash),
      /BLOCKSCOUT_TRANSACTION_SCHEMA_INCOMPLETE/u);
  }
});

test("readback requires the expected log envelope and target event", () => {
  assert.throws(() => compactLogs({}, contract, topic), /BLOCKSCOUT_LOG_ENVELOPE_INVALID/u);
  assert.throws(() => compactLogs({ items: [] }, contract, topic), /BLOCKSCOUT_TARGET_EVENT_MISSING/u);
  assert.equal(compactLogs({ items: [{
    address: contract, index: 1, topics: [topic, `0x${"56".repeat(32)}`],
  }] }, contract, topic).length, 1);
});
