import { describe, expect, it } from "vitest";

import { createAgent, publishAgent, submitAgentForReview } from "./agents";

describe("agent lifecycle", () => {
  it("normalizes capabilities and publishes only after review", () => {
    const draft = createAgent({
      id: "agent-research-01",
      ownerId: "publisher-01",
      name: "Research Scout",
      description: "Finds and summarizes primary sources.",
      capabilities: [" Research ", "summarization", "research"],
      endpoint: "https://agents.example.test/research",
      occurredAt: "2026-08-31T12:00:00.000Z",
    });

    expect(draft.capabilities).toEqual(["research", "summarization"]);
    expect(draft.status).toBe("draft");

    const reviewing = submitAgentForReview(draft, {
      reasonCode: "owner_submitted",
      occurredAt: "2026-08-31T12:01:00.000Z",
    });
    expect(reviewing.status).toBe("reviewing");

    expect(
      publishAgent(reviewing, {
        reasonCode: "review_passed",
        occurredAt: "2026-08-31T12:02:00.000Z",
      }),
    ).toMatchObject({ id: "agent-research-01", status: "published", version: 1 });
  });

  it("rejects review when a callable endpoint is missing", () => {
    const draft = createAgent({
      id: "agent-incomplete",
      ownerId: "publisher-01",
      name: "Incomplete Agent",
      description: "Not ready for marketplace execution.",
      capabilities: ["research"],
      occurredAt: "2026-08-31T12:00:00.000Z",
    });

    expect(() =>
      submitAgentForReview(draft, {
        reasonCode: "owner_submitted",
        occurredAt: "2026-08-31T12:01:00.000Z",
      }),
    ).toThrowError("AGENT_ENDPOINT_REQUIRED");
  });
});
