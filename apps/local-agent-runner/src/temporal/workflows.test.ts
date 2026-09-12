import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchOutcome, ScheduleIdentity, ScheduleSnapshot } from "./contracts";

const temporal = vi.hoisted(() => ({
  condition: vi.fn(async () => true),
  dispatchDeadline: vi.fn(),
  inspectSchedule: vi.fn(),
  resumeApproval: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
  condition: temporal.condition,
  defineSignal: vi.fn((name: string) => name),
  isCancellation: vi.fn(() => false),
  proxyActivities: vi.fn((options: { startToCloseTimeout: string }) => {
    if (options.startToCloseTimeout === "30 seconds") {
      return { inspectSchedule: temporal.inspectSchedule };
    }
    if (options.startToCloseTimeout === "30 minutes") {
      return {
        dispatchDeadline: temporal.dispatchDeadline,
        resumeApproval: temporal.resumeApproval,
      };
    }
    return { consumePlanning: vi.fn() };
  }),
  setHandler: vi.fn(),
}));

import { queenOrderSchedule } from "./workflows";

const identity: ScheduleIdentity = {
  scopeId: "00000000-0000-4000-8000-000000000001",
  taskId: "00000000-0000-4000-8000-000000000002",
  graphRevision: 1,
  taskFingerprint: `sha256:${"a".repeat(64)}`,
};
const snapshot = (overrides: Partial<ScheduleSnapshot> = {}): ScheduleSnapshot => ({
  approvalRef: null,
  deadlineAt: 2_000,
  terminal: false,
  ...overrides,
});

describe("queenOrderSchedule committed command reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_000);
  });

  it.each<DispatchOutcome>(["committed", "duplicate-committed"])(
    "re-inspects after approval %s and can process the later deadline without replaying approval",
    async outcome => {
      temporal.inspectSchedule
        .mockResolvedValueOnce(snapshot({ approvalRef: "00000000-0000-4000-8000-000000000003" }))
        .mockResolvedValueOnce(snapshot({ approvalRef: "00000000-0000-4000-8000-000000000003" }))
        .mockResolvedValueOnce(snapshot({ approvalRef: "00000000-0000-4000-8000-000000000003", deadlineAt: 999 }))
        .mockResolvedValueOnce(snapshot({ terminal: true }));
      temporal.resumeApproval.mockResolvedValue(outcome);
      temporal.dispatchDeadline.mockResolvedValue("committed");

      await expect(queenOrderSchedule(identity)).resolves.toBe("business-terminal");
      expect(temporal.resumeApproval).toHaveBeenCalledTimes(1);
      expect(temporal.dispatchDeadline).toHaveBeenCalledTimes(1);
      expect(temporal.inspectSchedule).toHaveBeenCalledTimes(4);
    },
  );

  it("re-inspects after a committed deadline and does not replay it while business remains open", async () => {
    temporal.inspectSchedule
      .mockResolvedValueOnce(snapshot({ deadlineAt: 999 }))
      .mockResolvedValueOnce(snapshot({ deadlineAt: 999 }))
      .mockResolvedValueOnce(snapshot({ terminal: true }));
    temporal.dispatchDeadline.mockResolvedValue("committed");

    await expect(queenOrderSchedule(identity)).resolves.toBe("business-terminal");
    expect(temporal.dispatchDeadline).toHaveBeenCalledTimes(1);
    expect(temporal.inspectSchedule).toHaveBeenCalledTimes(3);
  });
});
