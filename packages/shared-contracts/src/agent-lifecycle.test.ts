import { describe, expect, it } from "vitest";

import {
  beginAgentRevision,
  createAgentLifecycle,
  isAgentVersionSelectable,
  transitionAgentLifecycle,
} from "./agent-lifecycle";

const event = (reasonCode: string, actorRole: "owner" | "reviewer" = "owner") => ({
  actorRole,
  reasonCode,
  occurredAt: "2026-08-31T12:00:00.000Z",
});

describe("agent lifecycle contract", () => {
  it("requires review before publication and preserves an audit history", () => {
    const draft = createAgentLifecycle(event("owner_created"));
    const reviewing = transitionAgentLifecycle(draft, "reviewing", event("owner_submitted"));
    const published = transitionAgentLifecycle(
      reviewing,
      "published",
      event("review_passed", "reviewer"),
    );

    expect(published).toMatchObject({ status: "published", version: 1 });
    expect(published.history.map(({ to }) => to)).toEqual(["draft", "reviewing", "published"]);
    expect(isAgentVersionSelectable(published)).toBe(true);
  });

  it("fails closed on skipped review, retired recovery, and draft revision", () => {
    const draft = createAgentLifecycle(event("owner_created"));
    expect(() => transitionAgentLifecycle(draft, "published", event("skip_review"))).toThrow(
      "AGENT_LIFECYCLE_TRANSITION_FORBIDDEN:draft:published",
    );
    expect(() => beginAgentRevision(draft, event("edit"))).toThrow(
      "AGENT_REVISION_FORBIDDEN:draft",
    );

    const reviewing = transitionAgentLifecycle(draft, "reviewing", event("owner_submitted"));
    const published = transitionAgentLifecycle(
      reviewing,
      "published",
      event("review_passed", "reviewer"),
    );
    const retired = transitionAgentLifecycle(published, "retired", event("owner_retired"));
    expect(() => transitionAgentLifecycle(retired, "published", event("restore"))).toThrow(
      "AGENT_LIFECYCLE_TRANSITION_FORBIDDEN:retired:published",
    );
  });

  it("starts an immutable next version without erasing prior events", () => {
    const reviewing = transitionAgentLifecycle(
      createAgentLifecycle(event("owner_created")),
      "reviewing",
      event("owner_submitted"),
    );
    const published = transitionAgentLifecycle(
      reviewing,
      "published",
      event("review_passed", "reviewer"),
    );
    const revision = beginAgentRevision(published, event("owner_started_revision"));

    expect(revision).toMatchObject({ status: "draft", version: 2 });
    expect(revision.history.at(-1)).toMatchObject({
      from: "published",
      to: "draft",
      version: 2,
    });
    expect(isAgentVersionSelectable(revision)).toBe(false);
  });
});
