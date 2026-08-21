import { describe, expect, it } from "vitest";

import { parsePersistedChainId } from "./auth-store";

describe("persisted auth state", () => {
  it("fails closed when a persisted identity is not on Sepolia", () => {
    expect(parsePersistedChainId("11155111")).toBe(11155111);
    expect(() => parsePersistedChainId(1)).toThrow("AUTH_PERSISTED_CHAIN_INVALID");
  });
});
