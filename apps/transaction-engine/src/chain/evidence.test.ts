import { describe, expect, it } from "vitest";

import { projectTransactionEvidence } from "./evidence";
import { buildTransactionIntent } from "./intents";

describe("public transaction evidence projection", () => {
  it("uses an explicit public allowlist and omits signing and diagnostic material", () => {
    const intent = buildTransactionIntent({
      intentId: "10000000-0000-4000-8000-000000000001",
      requestId: "20000000-0000-4000-8000-000000000002",
      requestRef: `0x${"AB".repeat(32)}`,
      from: "0x11111111111111111111111111111111111111AA",
      to: "0x22222222222222222222222222222222222222BB",
      method: "createTask",
      args: {
        taskId: `0x${"11".repeat(32)}`,
        budgetAtomic: "6000000",
        deadline: 1_800_000_000,
      },
      createdAt: "2026-08-21T12:00:00.000Z",
      expiresAt: "2026-08-21T12:10:00.000Z",
    });
    const evidence = projectTransactionEvidence(intent, {
      intentId: intent.intentId,
      requestId: intent.requestId,
      txHash: `0x${"CD".repeat(32)}`,
      checkedAt: "2026-08-21T14:00:00.000Z",
      status: "failed",
      confirmations: 2,
      blockNumber: 100,
      errorCode: "PRIVATE_RPC_TIMEOUT cookie=secret signature=secret",
    });

    expect(evidence).toEqual({
      from: intent.from,
      to: intent.to,
      txHash: `0x${"cd".repeat(32)}`,
      eventName: null,
      requestRef: intent.requestRef,
      blockNumber: 100,
      confirmations: 2,
      status: "failed",
      checkedAt: "2026-08-21T14:00:00.000Z",
    });
    expect(JSON.stringify(evidence)).not.toContain(intent.data);
    expect(JSON.stringify(evidence)).not.toMatch(/cookie|signature|private|timeout/i);
  });
});
