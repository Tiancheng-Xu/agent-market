import { describe, expect, it } from "vitest";

import {
  PINNED_LAYA_MODEL_REVISION,
  parseSystemOneShadowConfig,
} from "./config";

describe("System-One shadow configuration", () => {
  it("defaults to off before validating any provider fields", () => {
    expect(parseSystemOneShadowConfig({})).toEqual({ mode: "off" });
    expect(parseSystemOneShadowConfig({
      SYSTEM_ONE_SHADOW_MODE: "off",
      LAYA_MODEL_DIR: "relative",
      LAYA_MODEL_REVISION: "wrong",
      LAYA_TIMEOUT_MS: "invalid",
      JEV_SHADOW_ENABLED: "invalid",
    })).toEqual({ mode: "off" });
  });

  it("parses a complete offline-capable dual-shadow configuration", () => {
    expect(parseSystemOneShadowConfig({
      SYSTEM_ONE_SHADOW_MODE: "dual-shadow",
      LAYA_MODEL_DIR: "/opt/agent-market/laya",
      LAYA_MODEL_REVISION: PINNED_LAYA_MODEL_REVISION,
      LAYA_TIMEOUT_MS: "2000",
      SYSTEM_ONE_SHADOW_HMAC_KEY: "test-only-reference-key-32-characters",
      JEV_SHADOW_ENABLED: "false",
    })).toMatchObject({
      mode: "dual-shadow",
      referenceHmacKey: "test-only-reference-key-32-characters",
      laya: {
        modelDir: "/opt/agent-market/laya",
        revision: PINNED_LAYA_MODEL_REVISION,
        timeoutMs: 2000,
      },
      jev: { enabled: false, apiKey: undefined, timeoutMs: 1500, sampleRate: 0.1, maxRequests: 100 },
    });
  });

  it("parses Jev independently when explicitly enabled", () => {
    expect(parseSystemOneShadowConfig({
      SYSTEM_ONE_SHADOW_MODE: "dual-shadow",
      LAYA_MODEL_DIR: "/opt/agent-market/laya",
      LAYA_MODEL_REVISION: PINNED_LAYA_MODEL_REVISION,
      SYSTEM_ONE_SHADOW_HMAC_KEY: "test-only-reference-key-32-characters",
      JEV_SHADOW_ENABLED: "true",
      TYPESAFE_API_KEY: "test-only",
      JEV_SHADOW_TIMEOUT_MS: "3000",
      JEV_SHADOW_SAMPLE_RATE: "0.25",
      JEV_SHADOW_MAX_REQUESTS: "12",
    })).toMatchObject({
      mode: "dual-shadow",
      jev: { enabled: true, apiKey: "test-only", timeoutMs: 3000, sampleRate: 0.25, maxRequests: 12 },
    });
  });

  it.each([
    [{ SYSTEM_ONE_SHADOW_MODE: "unknown" }, "SYSTEM_ONE_SHADOW_MODE"],
    [{ SYSTEM_ONE_SHADOW_MODE: "dual-shadow", LAYA_MODEL_DIR: "relative", LAYA_MODEL_REVISION: PINNED_LAYA_MODEL_REVISION }, "LAYA_MODEL_DIR"],
    [{ SYSTEM_ONE_SHADOW_MODE: "dual-shadow", LAYA_MODEL_DIR: "/models/laya", LAYA_MODEL_REVISION: "wrong" }, "LAYA_MODEL_REVISION"],
    [{ SYSTEM_ONE_SHADOW_MODE: "dual-shadow", LAYA_MODEL_DIR: "/models/laya", LAYA_MODEL_REVISION: PINNED_LAYA_MODEL_REVISION, LAYA_TIMEOUT_MS: "99" }, "LAYA_TIMEOUT_MS"],
    [{ SYSTEM_ONE_SHADOW_MODE: "dual-shadow", LAYA_MODEL_DIR: "/models/laya", LAYA_MODEL_REVISION: PINNED_LAYA_MODEL_REVISION, LAYA_TIMEOUT_MS: "10001" }, "LAYA_TIMEOUT_MS"],
    [{ SYSTEM_ONE_SHADOW_MODE: "dual-shadow", LAYA_MODEL_DIR: "/models/laya", LAYA_MODEL_REVISION: PINNED_LAYA_MODEL_REVISION }, "SYSTEM_ONE_SHADOW_HMAC_KEY"],
  ] as const)("rejects invalid fail-closed input %#", (env, message) => {
    expect(() => parseSystemOneShadowConfig(env)).toThrow(message);
  });
});
