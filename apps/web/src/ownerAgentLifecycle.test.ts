import { describe, expect, it } from "vitest";

import type { OwnerAgentRecord } from "./ownerAgentRegistry";
import { deriveOwnerAgentLifecycle, nextOwnerAgentLifecycle } from "./ownerAgentLifecycle";

const record = {
  id: "owner-agent-1",
  ownerWallet: "0x1111111111111111111111111111111111111111",
  displayName: "Owner Agent",
  description: "A locally registered owner agent.",
  provider: "https",
  endpoint: "https://agent.example/run",
  modelTag: "owner-agent:v1",
  categories: ["research"],
  category: "research",
  tags: ["research"],
  pricing: "free",
  platformTestStatus: "not-required",
  pricePerTaskYd: 0,
  listingStatus: "listed",
  selectableBy: "public-market",
  createdAt: "2026-08-31T12:00:00.000Z",
  updatedAt: "2026-08-31T12:00:00.000Z",
} as unknown as OwnerAgentRecord;

describe("owner agent lifecycle adapter", () => {
  it("imports a legacy marketplace record without erasing its provenance", () => {
    expect(deriveOwnerAgentLifecycle(record)).toMatchObject({
      status: "published",
      version: 1,
      history: [{ reasonCode: "legacy_registry_import" }],
    });
  });

  it("supports pause, resume, and immutable revision history", () => {
    const paused = { ...record, lifecycle: nextOwnerAgentLifecycle(record, "pause", "2026-08-31T12:01:00.000Z") };
    const resumed = { ...paused, lifecycle: nextOwnerAgentLifecycle(paused, "resume", "2026-08-31T12:02:00.000Z") };
    const revision = nextOwnerAgentLifecycle(resumed, "revise", "2026-08-31T12:03:00.000Z");
    expect(revision).toMatchObject({ status: "draft", version: 2 });
    expect(revision.history.map((event) => event.to)).toEqual(["published", "paused", "published", "draft"]);
  });
});
