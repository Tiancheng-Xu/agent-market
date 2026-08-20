import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AppErrorSchema, MatchRequestedV1Schema } from "./index";

const fixturePath = fileURLToPath(
  new URL("../fixtures/match-requested.v1.json", import.meta.url),
);

describe("shared contracts", () => {
  it("accepts the canonical match event fixture", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    expect(MatchRequestedV1Schema.parse(fixture).type).toBe(
      "match.requested.v1",
    );
  });

  it("rejects internal error details", () => {
    expect(() =>
      AppErrorSchema.parse({
        code: "INTERNAL",
        message: "safe",
        stack: "secret",
      }),
    ).toThrow();
  });
});
