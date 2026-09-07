import { describe, expect, it } from "vitest";

import type { AgentCandidate } from "@agent-market/shared-contracts";

import { computeDecayedQualityScore, rankAgentCandidates, selectThreeFromFour, selectThreeWithAudit } from "./queen-ranking";

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

  it("hard-filters by task category and every required tag before scoring", () => {
    const ranked = rankAgentCandidates({
      nodeType: "execute",
      category: "code",
      requiredTags: ["typescript", "frontend"],
      requiredCapabilities: ["completion"],
      now: new Date("2026-08-22T12:00:00.000Z"),
      candidates: [
        candidate("exact", { categories: ["code"], tags: ["typescript", "frontend"], costPer1kTokensUsd: 0.01, qualityScore: 0.7 }),
        candidate("wrong-category", { categories: ["research"], tags: ["typescript", "frontend"], costPer1kTokensUsd: 0, qualityScore: 0.99 }),
        candidate("missing-tag", { categories: ["code"], tags: ["typescript"], costPer1kTokensUsd: 0, qualityScore: 0.99 }),
      ],
    });

    expect(ranked.map((item) => item.agentId)).toEqual(["exact"]);
    expect(ranked[0]!.rankingReasons).toContain("category:code");
    expect(ranked[0]!.rankingReasons).toContain("required-tags:typescript|frontend");
  });

  it("computes quality from a bounded event window with exponential time decay", () => {
    const score = computeDecayedQualityScore(
      candidate("history", {
        costPer1kTokensUsd: 0.01,
        qualityScore: 0.99,
        scoreEvents: [
          { score: 1, occurredAt: "2026-06-01T00:00:00.000Z" },
          { score: 0.8, occurredAt: "2026-08-01T00:00:00.000Z" },
          { score: 0.2, occurredAt: "2026-08-22T00:00:00.000Z" },
        ],
      }),
      new Date("2026-08-22T12:00:00.000Z"),
    );

    expect(score).toBeGreaterThan(0.2);
    expect(score).toBeLessThan(0.5);
  });

  it("selects three distinct models from the top four and reserves exploration when needed", () => {
    const selected = selectThreeFromFour({
      nodeType: "execute",
      requiredCapabilities: ["completion"],
      now: new Date("2026-08-22T12:00:00.000Z"),
      candidates: [
        candidate("stable-a", { costPer1kTokensUsd: 0.001, qualityScore: 0.91 }),
        candidate("stable-b", { costPer1kTokensUsd: 0.002, qualityScore: 0.88 }),
        candidate("stable-c", { costPer1kTokensUsd: 0.003, qualityScore: 0.86 }),
        candidate("new-agent", { costPer1kTokensUsd: 0.004, qualityScore: 0.3, firstSeenAt: "2026-08-22T00:00:00.000Z", scoreEvents: [] }),
        candidate("outside-pool", { costPer1kTokensUsd: 0.05, qualityScore: 0.99 }),
      ],
    });

    expect(selected).toHaveLength(3);
    expect(selected.map((item) => item.agentId)).toEqual(["stable-a", "stable-b", "new-agent"]);
    expect(new Set(selected.map((item) => item.modelTag)).size).toBe(3);
  });

  it("fills all three seats reproducibly during a pure cold start", () => {
    const base = {
      nodeType: "execute" as const,
      requiredCapabilities: ["completion"],
      now: new Date("2026-09-01T12:00:00.000Z"),
      selectionPolicy: { taskId: "task-cold", matchingRound: 1, policyVersion: "fair-v1" },
      candidates: ["a", "b", "c", "d"].map((id) => candidate(`new-${id}`, {
        modelTag: `model-${id}`,
        costPer1kTokensUsd: 0.01,
        qualityScore: 0,
        firstSeenAt: "2026-09-01T11:00:00.000Z",
        scoreEvents: [],
      })),
    };
    const first = selectThreeWithAudit(base);
    const second = selectThreeWithAudit(base);
    expect(first.candidates).toHaveLength(3);
    expect(first.audit).toEqual(second.audit);
    expect(first.audit.selectionReasons).toEqual([
      "cold-start-exploration",
      "cold-start-exploration",
      "cold-start-exploration",
    ]);
  });

  it.each([
    {
      taskId: "task-cold",
      matchingRound: 1,
      policyVersion: "fair-v1",
      agentIds: ["new-d", "new-b", "new-a", "new-c"],
      seedHash: "aa366ba1cb7874f091fec6e0fed3b293766ec340a53a89171f54b45568bb255a",
      selectedIds: ["new-d", "new-b", "new-a"],
    },
    {
      taskId: "任务-42",
      matchingRound: 12,
      policyVersion: "公平-v2",
      agentIds: ["agent-𐀀", "agent-", "agent-a", "agent-Z"],
      seedHash: "efb6c5da19c3e9a2e64c8af2d8d4ff3902d874df74e17a8facd6996e1f6805f7",
      selectedIds: ["agent-", "agent-Z", "agent-a"],
    },
  ])("matches the shared seeded Fisher-Yates vector for $taskId", ({
    taskId,
    matchingRound,
    policyVersion,
    agentIds,
    seedHash,
    selectedIds,
  }) => {
    const result = selectThreeWithAudit({
      nodeType: "execute",
      requiredCapabilities: ["completion"],
      now: new Date("2026-09-01T12:00:00.000Z"),
      selectionPolicy: { taskId, matchingRound, policyVersion },
      candidates: agentIds.map((agentId) => candidate(agentId, {
        modelTag: agentId,
        costPer1kTokensUsd: 0.01,
        qualityScore: 0,
        firstSeenAt: "2026-09-01T11:00:00.000Z",
        scoreEvents: [],
      })),
    });

    expect(result.audit.seedHash).toBe(seedHash);
    expect(result.audit.selectedIds).toEqual(selectedIds);
  });

  it("allows owner-only candidates only under an authenticated owner scope", () => {
    const ownerCandidate = candidate("local-owner", {
      selectableBy: "owner-only",
      costPer1kTokensUsd: 0,
      qualityScore: 0.8,
    });
    const baseInput = {
      nodeType: "execute" as const,
      requiredCapabilities: ["completion"],
      now: new Date("2026-08-22T12:00:00.000Z"),
      candidates: [ownerCandidate],
    };

    expect(rankAgentCandidates({ ...baseInput, callerScope: "public" })).toEqual([]);
    expect(rankAgentCandidates({ ...baseInput, callerScope: "owner" }).map((item) => item.agentId)).toEqual(["local-owner"]);
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
