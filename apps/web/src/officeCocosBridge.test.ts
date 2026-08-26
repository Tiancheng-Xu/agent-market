import { describe, expect, it } from "vitest";

import { parseOfficeCocosMessage, postOfficeSnapshot } from "./officeCocosBridge";

describe("office Cocos bridge", () => {
  it("posts only to the configured same-origin frame", () => {
    const calls: unknown[][] = [];
    const frame = { postMessage: (...args: unknown[]) => calls.push(args) } as unknown as Window;
    postOfficeSnapshot(frame, "https://market.example", {
      version: 1,
      generatedAt: "2026-08-26T12:00:00.000Z",
      statusFilter: "all",
      desks: [],
    });
    expect(calls).toEqual([[expect.objectContaining({ type: "agent-market.office.snapshot.v1" }), "https://market.example"]]);
  });

  it("rejects foreign origins and unknown commands", () => {
    const source = {} as Window;
    expect(parseOfficeCocosMessage({
      data: { type: "agent-market.office.ready.v1" },
      origin: "https://evil.example",
      source,
    }, { expectedOrigin: "https://market.example", expectedSource: source })).toBeNull();
    expect(parseOfficeCocosMessage({
      data: { type: "wallet.sign" },
      origin: "https://market.example",
      source,
    }, { expectedOrigin: "https://market.example", expectedSource: source })).toBeNull();
  });

  it("accepts a same-origin desk selection from the expected iframe", () => {
    const source = {} as Window;
    expect(parseOfficeCocosMessage({
      data: { type: "agent-market.office.select-desk.v1", taskId: "task-1" },
      origin: "https://market.example",
      source,
    }, { expectedOrigin: "https://market.example", expectedSource: source })).toEqual({
      type: "agent-market.office.select-desk.v1",
      taskId: "task-1",
    });
  });
});
