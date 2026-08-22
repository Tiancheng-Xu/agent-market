import { describe, expect, it } from "vitest";

import type { AgentCandidate } from "@agent-market/shared-contracts";

import { rankAgentCandidates } from "./queen-ranking";

describe("queen agent ranking", () => {
  it("prioritizes lower cost after capability match and minimum quality", () => {
    const ranked = rankAgentCandidates({
      nodeType: "execute",
      requiredCapabilities: ["completion"],
      now: new Date("2026-08-22T12:00:00.000Z"),
      candidates: [
        candidate("expensive", { costPer1kTokensUsd: 0.02, qualityScore: 0.9 }),
        candidate("cheap", { costPer1kTokensUsd: 0.001, qualityScore: 0.82 }),
      ],
    });

    expect(ranked.map((item) => item.agentId)).toEqual(["cheap", "expensive"]);
  });

  it("filters low-score old models even when they are cheap", () => {
    const ranked = rankAgentCandidates({
      nodeType: "execute",
      requiredCapabilities: ["completion"],
      now: new Date("2026-08-22T12:00:00.000Z"),
      candidates: [
        candidate("low-old", { costPer1kTokensUsd: 0, qualityScore: 0.31, firstSeenAt: "2026-01-01T00:00:00.000Z" }),
        candidate("ok", { costPer1kTokensUsd: 0.01, qualityScore: 0.75 }),
      ],
    });

    expect(ranked.map((item) => item.agentId)).toEqual(["ok"]);
  });

  it("gives a bounded protection boost to new models above the quality floor", () => {
    const ranked = rankAgentCandidates({
      nodeType: "execute",
      requiredCapabilities: ["completion"],
      now: new Date("2026-08-22T12:00:00.000Z"),
      candidates: [
        candidate("stable", { costPer1kTokensUsd: 0.004, qualityScore: 0.83, firstSeenAt: "2026-01-01T00:00:00.000Z" }),
        candidate("new", { costPer1kTokensUsd: 0.004, qualityScore: 0.78, firstSeenAt: "2026-08-22T00:00:00.000Z" }),
      ],
    });

    expect(ranked.map((item) => item.agentId)).toEqual(["new", "stable"]);
  });

  it("rejects candidates that lack required capabilities", () => {
    const ranked = rankAgentCandidates({
      nodeType: "judge",
      requiredCapabilities: ["judge"],
      now: new Date("2026-08-22T12:00:00.000Z"),
      candidates: [
        candidate("completion-only", { capabilities: ["completion"], costPer1kTokensUsd: 0, qualityScore: 0.99 }),
        candidate("judge-ready", { capabilities: ["completion", "judge"], costPer1kTokensUsd: 0.01, qualityScore: 0.8 }),
      ],
    });

    expect(ranked.map((item) => item.agentId)).toEqual(["judge-ready"]);
  });

  it("keeps only one candidate per model in the three-choice pool", () => {
    const ranked = rankAgentCandidates({
      nodeType: "execute",
      requiredCapabilities: ["completion"],
      now: new Date("2026-08-22T12:00:00.000Z"),
      candidates: [
        candidate("same-model-a", { modelTag: "qwen-plus", costPer1kTokensUsd: 0.001, qualityScore: 0.81 }),
        candidate("same-model-b", { modelTag: "qwen-plus", costPer1kTokensUsd: 0.002, qualityScore: 0.99 }),
        candidate("other-model", { modelTag: "deepseek-v4-flash", costPer1kTokensUsd: 0.003, qualityScore: 0.83 }),
      ],
    });

    expect(ranked.map((item) => item.modelTag)).toEqual(["qwen-plus", "deepseek-v4-flash"]);
  });

  it("excludes owner-only local agents from public ranking", () => {
    const ranked = rankAgentCandidates({
      nodeType: "execute",
      requiredCapabilities: ["completion"],
      now: new Date("2026-08-22T12:00:00.000Z"),
      candidates: [
        candidate("local-private", { selectableBy: "owner-only", costPer1kTokensUsd: 0, qualityScore: 0.99 }),
        candidate("provider-public", { costPer1kTokensUsd: 0.004, qualityScore: 0.8 }),
      ],
    });

    expect(ranked.map((item) => item.agentId)).toEqual(["provider-public"]);
  });

  it("gives brand-new zero-score models an exploration reason without pretending quality history exists", () => {
    const ranked = rankAgentCandidates({
      nodeType: "execute",
      requiredCapabilities: ["completion"],
      now: new Date("2026-08-22T12:00:00.000Z"),
      candidates: [
        candidate("new-model", {
          costPer1kTokensUsd: 0.004,
          qualityScore: 0,
          firstSeenAt: "2026-08-22T00:00:00.000Z",
          tags: ["new-model", "fast-draft"],
          license: "provider terms pending metadata",
        }),
        candidate("old-low", {
          costPer1kTokensUsd: 0,
          qualityScore: 0.3,
          firstSeenAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });

    expect(ranked.map((item) => item.agentId)).toEqual(["new-model"]);
    expect(ranked[0]!.rankingReasons).toContain("new-model-exploration");
    expect(ranked[0]!.rankingReasons).toContain("tags:new-model|fast-draft");
  });
});

function candidate(
  agentId: string,
  overrides: Partial<AgentCandidate> & { costPer1kTokensUsd: number; qualityScore: number },
): AgentCandidate {
  return {
    agentId,
    displayName: agentId,
    capabilities: ["completion"],
    tags: [],
    provider: "qwen",
    ownership: "third-party/provider-api",
    selectableBy: "public-market",
    status: "online",
    latencyMs: 900,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    modelTag: agentId,
    modelDigest: "provider-managed",
    riskCodes: [],
    ...overrides,
  };
}
