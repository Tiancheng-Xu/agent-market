import { describe, expect, it } from "vitest";

import { readOpsHealth } from "./health";

describe("read-only ops health", () => {
  it("returns only bounded component states and no mutation commands", async () => {
    const snapshot = await readOpsHealth([
      { name: "database arn:secret", async check() { return "ok"; } },
      { name: "queue", async check() { throw new Error("private endpoint"); } },
    ], () => new Date("2026-08-21T12:00:00.000Z"));
    expect(snapshot).toEqual({
      mode: "read_only",
      status: "unavailable",
      checkedAt: "2026-08-21T12:00:00.000Z",
      components: [
        { name: "database-arn-secret", status: "ok" },
        { name: "queue", status: "unavailable" },
      ],
      mutations: [],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/transfer|deploy|vote|arn:|endpoint/u);
  });
});
