import { describe, expect, it } from "vitest";

import { officeFrameStatusFromRuntimeState } from "./CocosOfficeFrame";

describe("Cocos office host status", () => {
  it("keeps ready and degraded distinct without accepting arbitrary runtime states", () => {
    expect(officeFrameStatusFromRuntimeState("ready")).toBe("ready");
    expect(officeFrameStatusFromRuntimeState("degraded")).toBe("degraded");
    expect(officeFrameStatusFromRuntimeState("starting")).toBeUndefined();
    expect(officeFrameStatusFromRuntimeState("private-error-detail")).toBeUndefined();
  });
});
