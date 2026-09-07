import { describe, expect, it } from "vitest";

import type { BrowserOrderCommand } from "./orderClient";

function browserCommand(command: BrowserOrderCommand): BrowserOrderCommand {
  return command;
}

describe("BrowserOrderCommand", () => {
  it("excludes system-only lifecycle commands from the browser contract", () => {
    // @ts-expect-error start_matching is system-owned and cannot be submitted by a browser.
    browserCommand({ type: "start_matching" });
    // @ts-expect-error mark_funded is derived from verified funding evidence.
    browserCommand({ type: "mark_funded" });
    // @ts-expect-error settlement is projected from verified chain authority.
    browserCommand({ type: "settle" });
    // @ts-expect-error refunds are projected from verified chain authority.
    browserCommand({ type: "refund" });

    expect(browserCommand({ type: "accept_assignment" })).toEqual({ type: "accept_assignment" });
  });

  it("requires confirmed quote context for browser funding preparation", () => {
    // @ts-expect-error funding preparation cannot be sent without confirmed quote context.
    browserCommand({ type: "mark_funding_pending" });
    // @ts-expect-error both quote fields are required together.
    browserCommand({ type: "mark_funding_pending", quoteId: "44444444-4444-4444-8444-444444444444" });

    expect(browserCommand({
      type: "mark_funding_pending",
      quoteId: "44444444-4444-4444-8444-444444444444",
      taskFingerprint: `sha256:${"a".repeat(64)}`,
    })).toEqual({
      type: "mark_funding_pending",
      quoteId: "44444444-4444-4444-8444-444444444444",
      taskFingerprint: `sha256:${"a".repeat(64)}`,
    });
  });
});
