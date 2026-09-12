import { describe, expect, it } from "vitest";
import { temporalConfig } from "./config";

describe("Temporal opt-in local configuration", () => {
  it("requires exact opt-in", () => {
    for (const enabled of [undefined, "false", "1", "TRUE"]) {
      expect(temporalConfig(enabled === undefined ? {} : { QUEEN_TEMPORAL_ENABLED: enabled })).toBeUndefined();
    }
  });
  it("uses a local queue by default", () => {
    expect(temporalConfig({ QUEEN_TEMPORAL_ENABLED: "true" })).toEqual({
      address: "127.0.0.1:7233", namespace: "default", taskQueue: "queen-order-schedule-v1",
    });
  });
  it.each(["remote.example:7233", "127.0.0.1:0", "localhost:65536", "https://localhost:7233"])(
    "rejects address %s", address => {
      expect(() => temporalConfig({ QUEEN_TEMPORAL_ENABLED: "true", QUEEN_TEMPORAL_ADDRESS: address })).toThrow();
    },
  );
});
