import { describe, expect, it } from "vitest";

import { agents, tasks } from "./data";
import { rankMarketplaceAgents } from "./marketplaceRanking";

describe("marketplace ranking", () => {
  it("fails closed to verified public agents and exposes a frozen score breakdown", () => {
    const task = tasks[0]!;
    const ranked = rankMarketplaceAgents(agents, task);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.every((agent) => agent.verification === "verified" && agent.selectableBy === "public-market")).toBe(true);
    expect(ranked[0]?.reasons).toHaveLength(3);
    expect(ranked[0]?.scoreBreakdown).toEqual(expect.objectContaining({
      relevance: expect.any(Number),
      reliability: expect.any(Number),
      experience: expect.any(Number),
      exploration: expect.any(Number),
    }));
  });

  it("keeps explicit sorting deterministic", () => {
    const task = tasks[0]!;
    const ranked = rankMarketplaceAgents(agents, task, "", "reliability");
    expect(ranked.map((agent) => agent.reliability)).toEqual(
      [...ranked.map((agent) => agent.reliability)].sort((a, b) => b - a),
    );
  });
});
