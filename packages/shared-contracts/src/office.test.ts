import { describe, expect, it } from "vitest";

import {
  officeHostMessageSchema,
  officeSnapshotSchema,
  toPublicOfficeSnapshot,
} from "./office";

describe("OfficeSnapshotV2", () => {
  it("removes owner identity and node payloads before Cocos", () => {
    const snapshot = toPublicOfficeSnapshot({
      statusFilter: "all",
      generatedAt: "2026-08-26T12:00:00.000Z",
      desks: [
        {
          taskId: "task-1",
          ownerWallet: "0x1234",
          ownerLabel: "Owner",
          title: "Build release notes",
          category: "writing",
          tags: ["release"],
          status: "in_progress",
          agents: [{ agentId: "agent-1", displayName: "Code Agent", role: "execute", score: 30 }],
          nodeInput: "private input",
          nodeOutput: "private output",
          downloadableResult: "secret://result",
        },
      ],
      viewerWallet: "0x1234",
    });

    expect(snapshot.desks[0]).toMatchObject({
      taskId: "task-1",
      isOwner: true,
      agents: [expect.objectContaining({ activity: "working" })],
    });
    expect(JSON.stringify(snapshot)).not.toContain("0x1234");
    expect(JSON.stringify(snapshot)).not.toContain("private input");
    expect(JSON.stringify(snapshot)).not.toContain("private output");
    expect(JSON.stringify(snapshot)).not.toContain("secret://result");
    expect(officeSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("rejects undeclared private fields", () => {
    expect(() =>
      officeSnapshotSchema.parse({
        version: 2,
        generatedAt: "2026-08-26T12:00:00.000Z",
        statusFilter: "all",
        desks: [{
          taskId: "task-1",
          title: "Private",
          category: "code",
          tags: [],
          status: "completed",
          agents: [],
          isOwner: false,
          nodeInput: "must fail",
        }],
      }),
    ).toThrow();
  });

  it("accepts only the versioned host snapshot message", () => {
    const snapshot = toPublicOfficeSnapshot({
      statusFilter: "completed",
      generatedAt: "2026-08-26T12:00:00.000Z",
      desks: [],
    });
    expect(officeHostMessageSchema.parse({ type: "agent-market.office.snapshot.v2", payload: snapshot })).toBeTruthy();
    expect(() => officeHostMessageSchema.parse({ type: "wallet.sign", payload: {} })).toThrow();
  });
});
