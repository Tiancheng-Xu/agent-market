import type { Agent, Task } from "./types";

export type MarketplaceSort = "recommended" | "reliability" | "experience" | "newcomer";

export type RankedMarketplaceAgent = Agent & {
  matchScore: number;
  reasons: string[];
  scoreBreakdown: {
    relevance: number;
    reliability: number;
    experience: number;
    exploration: number;
  };
};

const normalize = (value: string) => value.trim().toLowerCase();

export function rankMarketplaceAgents(
  source: readonly Agent[],
  task: Task,
  query = "",
  sort: MarketplaceSort = "recommended",
): RankedMarketplaceAgent[] {
  const terms = new Set([task.category, ...task.tags].map(normalize));
  const normalizedQuery = normalize(query);
  const ranked = source
    .filter((agent) => agent.status === "active")
    .filter((agent) => agent.selectableBy === "public-market")
    .filter((agent) => agent.verification === "verified")
    .filter((agent) => normalizedQuery.length === 0 || [agent.name, agent.description, ...agent.tags]
      .some((value) => normalize(value).includes(normalizedQuery)))
    .map((agent): RankedMarketplaceAgent => {
      const matchedTerms = [agent.category, ...agent.tags].map(normalize).filter((term) => terms.has(term));
      const relevance = Math.min(1, matchedTerms.length / Math.max(1, Math.min(3, terms.size)));
      const reliability = Math.max(0, Math.min(1, agent.reliability / 100));
      const experience = Math.min(1, Math.log10(agent.completed + 1) / 2);
      const exploration = agent.newcomer ? 1 : 0;
      const matchScore = relevance * 0.4 + reliability * 0.3 + experience * 0.2 + exploration * 0.1;
      const reasons = [
        matchedTerms.length > 0
          ? `Matches ${matchedTerms.slice(0, 3).join(", ")}`
          : "No exact task tag match; ranked on verified quality signals",
        `Reliability ${agent.reliability}% across ${agent.completed} completed tasks`,
        agent.newcomer
          ? "Qualified newcomer receives a bounded exploration boost"
          : "Established history contributes to the experience score",
      ];
      return {
        ...agent,
        matchScore,
        reasons,
        scoreBreakdown: { relevance, reliability, experience, exploration },
      };
    });

  return ranked.sort((left, right) => {
    if (sort === "reliability") return right.reliability - left.reliability || right.matchScore - left.matchScore;
    if (sort === "experience") return right.completed - left.completed || right.matchScore - left.matchScore;
    if (sort === "newcomer") return Number(Boolean(right.newcomer)) - Number(Boolean(left.newcomer)) || right.matchScore - left.matchScore;
    return right.matchScore - left.matchScore || left.id.localeCompare(right.id);
  });
}
