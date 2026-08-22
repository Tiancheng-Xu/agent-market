import { afterEach, describe, expect, it } from "vitest";

import { getAuthOrigin, getAuthService, resetAuthRuntimeForTests } from "./runtime";

const originalEnvironment = {
  AUTH_ORIGIN: process.env.AUTH_ORIGIN,
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
};

function restore(name: keyof typeof originalEnvironment): void {
  const value = originalEnvironment[name];
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else Reflect.set(process.env, name, value);
}

describe.sequential("auth runtime fail-closed configuration", () => {
  afterEach(() => {
    restore("AUTH_ORIGIN");
    restore("DATABASE_URL");
    restore("NODE_ENV");
    resetAuthRuntimeForTests();
  });

  it.each([undefined, "http://agent-market.test", "https://agent-market.test/path", "https://agent-market.test?query=1"])(
    "rejects a missing or non-canonical AUTH_ORIGIN: %s",
    (value) => {
      if (value === undefined) delete process.env.AUTH_ORIGIN;
      else process.env.AUTH_ORIGIN = value;
      expect(() => getAuthOrigin()).toThrow(/AUTH_ORIGIN_(?:NOT_CONFIGURED|INVALID)/u);
    },
  );

  it("accepts only a canonical HTTPS origin", () => {
    process.env.AUTH_ORIGIN = "https://agent-market.test";
    expect(getAuthOrigin().origin).toBe("https://agent-market.test");
  });

  it("fails closed in production without DATABASE_URL", () => {
    Reflect.set(process.env, "NODE_ENV", "production");
    delete process.env.DATABASE_URL;
    expect(() => getAuthService()).toThrow("AUTH_STORE_NOT_CONFIGURED");
  });
});
