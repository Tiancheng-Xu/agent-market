import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { evaluateFrozenRoutingDataset, type FrozenRoutingDataset } from "./routing-evaluation";

const datasetUrl = new URL("../evaluation/frozen-routing-cases.json", import.meta.url);
const source = readFileSync(datasetUrl, "utf8");
const dataset = JSON.parse(source) as FrozenRoutingDataset;

describe("frozen Agent routing evaluation", () => {
  it("passes the release gate without hard-filter or model-identity regressions", () => {
    const result = evaluateFrozenRoutingDataset(dataset);

    expect(result).toMatchObject({
      datasetId: "agent-market-routing-v1",
      caseCount: 5,
      baselineExactMatches: 2,
      candidateExactMatches: 5,
      hardFilterViolations: 0,
      duplicateModelSelections: 0,
      releaseGatePassed: true,
    });
    expect(result.cases.every((item) => item.passed)).toBe(true);
  });

  it("keeps the frozen set unique and free of secret or private-path material", () => {
    expect(new Set(dataset.cases.map((item) => item.id)).size).toBe(dataset.cases.length);
    expect(source).not.toMatch(/(?:api[_-]?key|secret|bearer\s|private[_-]?key|\/Users\/|127\.0\.0\.1:11434)/i);
  });

  it("fails closed when dataset metadata or cases are invalid", () => {
    expect(() => evaluateFrozenRoutingDataset({ ...dataset, schemaVersion: 2 as 1 })).toThrow("metadata is invalid");
    expect(() => evaluateFrozenRoutingDataset({ ...dataset, cases: [dataset.cases[0]!, dataset.cases[0]!] })).toThrow("unique cases");
  });
});
