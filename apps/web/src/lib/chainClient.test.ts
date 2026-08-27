import { describe, expect, it } from "vitest";

import { formatYdAtomic, walletTransactionFromIntent, ydIntegerToAtomic } from "./chainClient";

const intent = {
  intentId: "0191f6f8-cb6b-7f31-81ad-c497d7d90301",
  requestId: "0191f6f8-cb6b-7f31-81ad-c497d7d90301",
  requestRef: `0x${"11".repeat(32)}`,
  chainId: 11_155_111 as const,
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  method: "createTask" as const,
  data: "0x1234",
  valueAtomic: "0",
  createdAt: "2026-08-26T00:00:00.000Z",
  expiresAt: "2026-08-26T00:10:00.000Z",
};

describe("chain client deterministic gates", () => {
  it("converts whole test YD amounts without floating-point loss", () => {
    expect(ydIntegerToAtomic("100")).toBe("100000000000000000000");
    expect(() => ydIntegerToAtomic("1.5")).toThrow("YD_AMOUNT_INVALID");
  });

  it("formats atomic YD readback without floating-point rounding", () => {
    expect(formatYdAtomic("100000000000000000000")).toBe("100");
    expect(formatYdAtomic("1000000000000000001")).toBe("1");
    expect(formatYdAtomic("1234500000000000000")).toBe("1.2345");
    expect(() => formatYdAtomic("-1")).toThrow("YD_ATOMIC_INVALID");
  });

  it("accepts only a live Sepolia intent owned by the connected wallet", () => {
    expect(walletTransactionFromIntent(intent, intent.from, Date.parse("2026-08-26T00:05:00.000Z"))).toEqual({ from: intent.from, to: intent.to, data: intent.data, value: "0x0" });
    expect(() => walletTransactionFromIntent(intent, "0x3333333333333333333333333333333333333333", Date.parse("2026-08-26T00:05:00.000Z"))).toThrow("INTENT_SENDER_MISMATCH");
    expect(() => walletTransactionFromIntent(intent, intent.from, Date.parse("2026-08-26T00:11:00.000Z"))).toThrow("INTENT_EXPIRED");
  });
});
