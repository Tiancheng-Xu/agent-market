import { describe, expect, it } from "vitest";

import { createAgent, publishAgent } from "./agents";

describe("agent lifecycle", () => {
  it("normalizes capabilities and publishes a complete draft", () => {
    const draft = createAgent({
      id: "agent-research-01",
      ownerId: "publisher-01",
      name: "Research Scout",
      description: "Finds and summarizes primary sources.",
      capabilities: [" Research ", "summarization", "research"],
      endpoint: "https://agents.example.test/research",
    });

    expect(draft.capabilities).toEqual(["research", "summarization"]);
    expect(draft.status).toBe("draft");

    expect(publishAgent(draft)).toMatchObject({
      id: "agent-research-01",
      status: "active",
      version: 2,
    });
  });

  it("rejects publication when a callable endpoint is missing", () => {
    const draft = createAgent({
      id: "agent-incomplete",
      ownerId: "publisher-01",
      name: "Incomplete Agent",
      description: "Not ready for marketplace execution.",
      capabilities: ["research"],
    });

    expect(() => publishAgent(draft)).toThrowError("AGENT_ENDPOINT_REQUIRED");
  });
});
