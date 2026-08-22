import { describe, expect, it } from "vitest";

import { createOpsHealthHandler } from "./route";

describe("GET /api/ops/health", () => {
  it("exposes a read-only sanitized snapshot", async () => {
    const response = await createOpsHealthHandler([{ name: "db", async check() { return "ok"; } }])(
      new Request("https://agent-market.test/api/ops/health"),
    );
    const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body.mode).toBe("read_only");
    expect(body.mutations).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/DATABASE_URL|SEPOLIA_RPC_URL|transfer|deploy|vote/u);
  });
});
