import { describe, expect, it } from "vitest";

import { createMemoryModelScoreStore } from "./model-score-store";

describe("model score store", () => {
  it("starts at zero, applies bounded outcomes, and ignores duplicate events", () => {
    const store = createMemoryModelScoreStore();
    const event = { eventId: "task:1:node:agent:judge", taskId: "task", nodeId: "node", agentId: "agent", score: 1, verdict: "approved", observedAt: "2026-08-22T00:00:00.000Z" };
    expect(store.scoreFor("agent")).toBeUndefined();
    store.recordScore(event);
    store.recordScore(event);
    expect(store.scoreFor("agent")).toBeCloseTo(0.2);
    expect(store.firstSeenAt("agent")).toBe(event.observedAt);
  });
});
