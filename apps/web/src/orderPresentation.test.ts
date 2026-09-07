import { describe, expect, it } from "vitest";

import { availableOrderActions, lifecycleState, reputationConfidence } from "./orderPresentation";

describe("order presentation", () => {
  it("exposes only role-appropriate public commands", () => {
    expect(availableOrderActions("submitted", "publisher")).toEqual(["accept_delivery", "open_dispute"]);
    expect(availableOrderActions("submitted", "agent")).toEqual([]);
    expect(availableOrderActions("assigned", "agent")).toEqual(["accept_assignment"]);
    expect(availableOrderActions("funded", "publisher")).toEqual([]);
  });

  it("does not imply progress through an unknown money state", () => {
    expect(lifecycleState("manual_review", "manual_review")).toBe("exception");
    expect(lifecycleState("settled", "manual_review")).toBe("pending");
  });

  it("labels small reputation samples as low confidence", () => {
    expect(reputationConfidence(4)).toBe("low");
    expect(reputationConfidence(20)).toBe("high");
  });
});
