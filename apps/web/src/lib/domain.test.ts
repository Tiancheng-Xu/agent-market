import { describe, expect, it } from "vitest";

import { calculateLinearYield, SECONDS_PER_YEAR, shortAddress } from "./domain";

describe("domain rules", () => {
  it("calculates six percent linear annual yield with floor rounding", () => {
    expect(calculateLinearYield(5_000, SECONDS_PER_YEAR)).toBe(300);
    expect(calculateLinearYield(10_000, SECONDS_PER_YEAR * 5)).toBe(3_000);
  });

  it("rejects invalid financial inputs", () => {
    expect(() => calculateLinearYield(-1, 60)).toThrow();
    expect(() => calculateLinearYield(1, Number.NaN)).toThrow();
  });

  it("redacts a connected address in the shell", () => {
    expect(shortAddress("0x1234567890abcdef1234")).toBe("0x1234...1234");
  });
});
