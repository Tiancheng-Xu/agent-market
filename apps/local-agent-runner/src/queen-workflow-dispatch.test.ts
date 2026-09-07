import { describe, expect, it, vi } from "vitest";
import { createQueenFrameworkRuntime } from "./queen-workflow-runtime";

describe("StateGraph business dispatch", () => {
  it.each([
    ["ProposeTaskGraph", "queen"], ["SubmitNodeOutput", "agent"],
    ["JudgeNodeOutput", "judge"], ["RepairNode", "repair"],
    ["RequestAdversarialReview", "red_team"], ["FinalArbitrate", "final_arbiter"],
    ["WriteLearningLoop", "learning"],
  ])("runs %s inside its selected node", async (operationName, node) => {
    const operation = vi.fn().mockResolvedValue(undefined);
    const result = await createQueenFrameworkRuntime().executeOperation!({ operationName, stages: [] }, operation);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(result.stages.at(-1)).toBe(`langgraph:executed:${node}`);
  });

  it("propagates approval or execution failure without automatic retry", async () => {
    const operation = vi.fn().mockRejectedValue(new Error("APPROVAL_REQUIRED"));
    await expect(createQueenFrameworkRuntime().executeOperation!({ operationName: "SubmitNodeOutput", stages: [] }, operation)).rejects.toThrow("APPROVAL_REQUIRED");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
