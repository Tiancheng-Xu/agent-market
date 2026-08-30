import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  createWorkflowOperationSignal,
  finalizeQueenWorkflowState,
  isIndependentQueenCandidate,
  LocalAgentsPage,
  parseGraphqlResponse,
  updateQueenNodeTitle,
} from "./LocalAgentsPage";

describe("local agents Queen workflow", () => {
  it("keeps Judge and Final Arbiter on independent model tags", () => {
    const graph = {
      taskId: "task-1",
      graphRevision: 1,
      riskLevel: "low" as const,
      startPolicy: "auto" as const,
      rescuePolicy: { mode: "auto" as const, visibleToUser: false as const, evidenceVisible: true as const },
      nodes: [
        { nodeId: "execute-1", type: "execute" as const, title: "Execute", dependencies: [], required: true },
        { nodeId: "judge-1", type: "judge" as const, title: "Judge", dependencies: ["execute-1"], required: true, judgesNodeId: "execute-1" },
        { nodeId: "final-1", type: "synthesize" as const, title: "Final", dependencies: ["judge-1"], required: true },
      ],
      edges: [],
    };
    const candidate = {
      agentId: "alias-agent",
      displayName: "Alias Agent",
      modelTag: "shared-model:v1",
      costPer1kTokensUsd: 0,
      qualityScore: 0.8,
      status: "online",
    };

    expect(isIndependentQueenCandidate(graph.nodes[1]!, candidate, graph, { "execute-1": "shared-model:v1" })).toBe(false);
    expect(isIndependentQueenCandidate(graph.nodes[1]!, candidate, graph, { "final-1": "shared-model:v1" })).toBe(false);
    expect(isIndependentQueenCandidate(graph.nodes[1]!, { ...candidate, modelTag: "judge-model:v1" }, graph, { "execute-1": "shared-model:v1" })).toBe(true);
    expect(isIndependentQueenCandidate(graph.nodes[0]!, candidate, graph, { "judge-1": "shared-model:v1" })).toBe(false);
    expect(isIndependentQueenCandidate(graph.nodes[0]!, { ...candidate, modelTag: "executor-model:v1" }, graph, { "judge-1": "shared-model:v1" })).toBe(true);
    expect(isIndependentQueenCandidate(graph.nodes[2]!, { ...candidate, modelTag: "judge-model:v1" }, graph, {
      "execute-1": "shared-model:v1",
      "judge-1": "judge-model:v1",
    })).toBe(false);
  });

  it("reports an unavailable GraphQL gateway when a response body is empty", async () => {
    const response = new Response(null, { status: 404 });

    await expect(parseGraphqlResponse(response)).rejects.toThrow("GRAPHQL_GATEWAY_UNAVAILABLE");
  });

  it("edits one DAG node title without changing other nodes or edges", () => {
    const graph = {
      taskId: "11111111-1111-4111-8111-111111111111",
      graphRevision: 1,
      riskLevel: "low" as const,
      startPolicy: "auto" as const,
      rescuePolicy: { mode: "auto" as const, visibleToUser: false as const, evidenceVisible: true as const },
      nodes: [
        { nodeId: "execute-1", type: "execute", title: "Execute", dependencies: [], required: true },
        { nodeId: "deliver-1", type: "deliver", title: "Deliver", dependencies: ["execute-1"], required: true },
      ],
      edges: [{ from: "execute-1", to: "deliver-1" }],
    };

    const updated = updateQueenNodeTitle(graph, "execute-1", "Build the verified asset");

    expect(updated.nodes).toEqual([
      { nodeId: "execute-1", type: "execute", title: "Build the verified asset", dependencies: [], required: true },
      { nodeId: "deliver-1", type: "deliver", title: "Deliver", dependencies: ["execute-1"], required: true },
    ]);
    expect(updated.edges).toBe(graph.edges);
  });

  it("keeps internal GraphQL state-machine actions out of the user-facing page", () => {
    const markup = renderToStaticMarkup(
      <LocalAgentsPage
        initialQueenWorkflow={{
          status: "ready",
          log: ["Recommended agents are auto-filled after the plan is generated."],
          graph: {
            taskId: "11111111-1111-4111-8111-111111111111",
            graphRevision: 1,
            riskLevel: "low",
            startPolicy: "auto",
            rescuePolicy: { mode: "auto", visibleToUser: false, evidenceVisible: true },
            edges: [
              { from: "execute-1", to: "judge-1" },
              { from: "judge-1", to: "synthesize-1" },
              { from: "synthesize-1", to: "deliver-1" },
            ],
            nodes: [
              { nodeId: "execute-1", type: "execute", title: "Build the requested change", dependencies: [], required: true },
              { nodeId: "judge-1", type: "judge", title: "Review the output independently", dependencies: ["execute-1"], required: true },
              { nodeId: "synthesize-1", type: "synthesize", title: "Finalize the accepted result", dependencies: ["judge-1"], required: true },
              { nodeId: "deliver-1", type: "deliver", title: "Record the delivery evidence", dependencies: ["synthesize-1"], required: true },
            ],
          },
        }}
      />,
    );

    expect(markup).toContain("Generate workflow plan");
    expect(markup).toContain("Start workflow");
    expect(markup).toContain("Auto-filled");
    expect(markup).toContain('aria-label="Queen workflow diagram"');
    expect(markup).toContain('aria-label="Graph edges"');
    expect(markup).toContain("execute-1");
    expect(markup).toContain("judge-1");
    expect(markup).not.toContain(">Rank<");
    expect(markup).not.toContain(">Accept<");
    expect(markup).not.toContain(">Run<");
    expect(markup).not.toContain(">Arbitrate<");
    expect(markup).not.toContain(">Write loop<");
  });

  it("renders the canonical flow and keeps Runtime-dependent actions disabled while offline", () => {
    const markup = renderToStaticMarkup(<LocalAgentsPage />);
    expect(markup).toContain("Requirement");
    expect(markup).toContain("Queen plan");
    expect(markup).toContain("Final arbiter");
    expect(markup).toContain("Red Team");
    expect(markup).toContain("Repair");
    expect(markup).toContain("RUNTIME_OFFLINE");
    expect(markup).toMatch(/<button[^>]+disabled=""[^>]*>Generate workflow plan<\/button>/);
  });

  it.each(["succeeded", "error", "cancelled"] as const)(
    "moves a running workflow into the %s terminal state",
    (outcome) => {
      const result = finalizeQueenWorkflowState({
        status: "running",
        activeNodeId: "execute-1",
        log: ["Executing execute-1..."],
      }, outcome, `Workflow ${outcome}.`);

      expect(result.status).toBe(outcome);
      expect(result.activeNodeId).toBeUndefined();
      expect(result.log.at(-1)).toBe(`Workflow ${outcome}.`);
    },
  );

  it("aborts one GraphQL operation at its deadline instead of waiting indefinitely", async () => {
    const signal = createWorkflowOperationSignal(new AbortController().signal, 10);

    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));

    expect(signal.aborted).toBe(true);
  });
});
