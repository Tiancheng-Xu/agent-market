import type { AgentCandidate, TaskNodeType } from "@agent-market/shared-contracts";

import { rankAgentCandidates } from "./queen-ranking";

export type FrozenRoutingCase = {
  id: string;
  nodeType: TaskNodeType;
  requiredCapabilities: string[];
  now: string;
  candidates: AgentCandidate[];
  expectedRanking: string[];
  prohibitedAgentIds: string[];
};

export type FrozenRoutingDataset = {
  schemaVersion: 1;
  datasetId: string;
  frozenAt: string;
  cases: FrozenRoutingCase[];
};

export type RoutingEvaluation = {
  datasetId: string;
  caseCount: number;
  baselineExactMatches: number;
  candidateExactMatches: number;
  hardFilterViolations: number;
  duplicateModelSelections: number;
  releaseGatePassed: boolean;
  cases: Array<{
    id: string;
    expectedRanking: string[];
    baselineRanking: string[];
    candidateRanking: string[];
    passed: boolean;
  }>;
};

export function evaluateFrozenRoutingDataset(dataset: FrozenRoutingDataset): RoutingEvaluation {
  assertDataset(dataset);
  let baselineExactMatches = 0;
  let candidateExactMatches = 0;
  let hardFilterViolations = 0;
  let duplicateModelSelections = 0;

  const cases = dataset.cases.map((testCase) => {
    const baselineRanking = simpleCostBaseline(testCase).map((candidate) => candidate.agentId);
    const candidateResults = rankAgentCandidates({
      nodeType: testCase.nodeType,
      requiredCapabilities: testCase.requiredCapabilities,
      now: new Date(testCase.now),
      candidates: testCase.candidates,
    });
    const candidateRanking = candidateResults.map((candidate) => candidate.agentId);
    if (sameOrder(baselineRanking, testCase.expectedRanking)) baselineExactMatches += 1;
    const passed = sameOrder(candidateRanking, testCase.expectedRanking);
    if (passed) candidateExactMatches += 1;
    hardFilterViolations += candidateRanking.filter((agentId) => testCase.prohibitedAgentIds.includes(agentId)).length;
    const uniqueModels = new Set(candidateResults.map((candidate) => candidate.modelTag.toLowerCase()));
    duplicateModelSelections += candidateResults.length - uniqueModels.size;
    return { id: testCase.id, expectedRanking: testCase.expectedRanking, baselineRanking, candidateRanking, passed };
  });

  return {
    datasetId: dataset.datasetId,
    caseCount: dataset.cases.length,
    baselineExactMatches,
    candidateExactMatches,
    hardFilterViolations,
    duplicateModelSelections,
    releaseGatePassed:
      candidateExactMatches === dataset.cases.length &&
      candidateExactMatches >= baselineExactMatches &&
      hardFilterViolations === 0 &&
      duplicateModelSelections === 0,
    cases,
  };
}

function simpleCostBaseline(testCase: FrozenRoutingCase): AgentCandidate[] {
  return [...testCase.candidates]
    .filter((candidate) => candidate.status !== "offline")
    .filter((candidate) => testCase.requiredCapabilities.every((capability) => candidate.capabilities.includes(capability)))
    .sort((left, right) => left.costPer1kTokensUsd - right.costPer1kTokensUsd || left.agentId.localeCompare(right.agentId));
}

function assertDataset(dataset: FrozenRoutingDataset): void {
  if (dataset.schemaVersion !== 1 || dataset.datasetId.trim() === "" || Number.isNaN(Date.parse(dataset.frozenAt))) {
    throw new Error("Frozen routing dataset metadata is invalid");
  }
  if (dataset.cases.length === 0 || new Set(dataset.cases.map((item) => item.id)).size !== dataset.cases.length) {
    throw new Error("Frozen routing dataset requires unique cases");
  }
  for (const testCase of dataset.cases) {
    if (testCase.expectedRanking.length === 0 || Number.isNaN(Date.parse(testCase.now))) {
      throw new Error(`Frozen routing case ${testCase.id} is invalid`);
    }
  }
}

function sameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
