import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LocalAgentsPage } from "./LocalAgentsPage";

describe("local agents Queen workflow", () => {
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
});
