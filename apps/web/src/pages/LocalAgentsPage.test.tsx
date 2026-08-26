import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  createWorkflowOperationSignal,
  finalizeQueenWorkflowState,
  LocalAgentsPage,
  parseGraphqlResponse,
  updateQueenNodeTitle,
} from "./LocalAgentsPage";

describe("local agents Queen workflow", () => {
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
    expect(markup).not.toContain(">Rank<");
    expect(markup).not.toContain(">Accept<");
    expect(markup).not.toContain(">Run<");
    expect(markup).not.toContain(">Judge<");
    expect(markup).not.toContain(">Red team<");
    expect(markup).not.toContain(">Repair<");
    expect(markup).not.toContain(">Arbitrate<");
    expect(markup).not.toContain(">Write loop<");
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
