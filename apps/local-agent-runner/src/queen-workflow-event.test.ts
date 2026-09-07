import { describe, expect, it, vi } from "vitest";
import { consumeQueenWorkflowEvent, queenEventOperationKey, type QueenWorkflowConsumerPorts } from "./queen-workflow-event";
const id = "01900000-0000-7000-8000-000000000021";
const fields = {
  schemaVersion: "queen-workflow-event.v1" as const, eventId: id,
  eventType: "task.requested" as const, taskId: id, scopeId: id,
  graphRevision: 1, taskFingerprint: `sha256:${"a".repeat(64)}`,
  payloadRef: id, payloadHash: `sha256:${"b".repeat(64)}`,
  occurredAt: "2026-09-04T00:00:00.000Z", expiresAt: "2026-09-05T00:00:00.000Z",
};
const event = { ...fields, operationKey: queenEventOperationKey(fields) };
const now = Date.parse("2026-09-04T12:00:00Z");
function ports(): QueenWorkflowConsumerPorts {
  return { assertTrustedSource: vi.fn().mockResolvedValue(undefined), authorizeAndResolve: vi.fn().mockResolvedValue(undefined), executeDurably: vi.fn().mockResolvedValue("committed"), deleteMessage: vi.fn().mockResolvedValue(undefined) };
}
describe("Queen asynchronous consumer contract", () => {
  it.each(["committed", "duplicate-committed"] as const)("acknowledges only durable result %s", async outcome => {
    const p = ports(), order: string[] = [];
    vi.mocked(p.executeDurably).mockImplementation(async () => { order.push("commit"); return outcome; });
    vi.mocked(p.deleteMessage).mockImplementation(async () => { order.push("delete"); });
    await expect(consumeQueenWorkflowEvent(JSON.stringify(event), p, now)).resolves.toEqual({ eventId: id, outcome });
    expect(order).toEqual(["commit", "delete"]);
  });
  it.each(["busy", "uncertain"] as const)("does not acknowledge %s execution", async outcome => {
    const p = ports(); vi.mocked(p.executeDurably).mockResolvedValue(outcome);
    await expect(consumeQueenWorkflowEvent(JSON.stringify(event), p, now)).rejects.toThrow();
    expect(p.deleteMessage).not.toHaveBeenCalled();
  });
  it.each([
    { ...event, secret: "forbidden-field" }, { ...event, graphRevision: 2 },
    { ...event, expiresAt: "2026-09-04T01:00:00Z" },
  ])("rejects malformed, changed or expired input before execution", async value => {
    const p = ports();
    await expect(consumeQueenWorkflowEvent(JSON.stringify(value), p, now)).rejects.toThrow();
    expect(p.executeDurably).not.toHaveBeenCalled();
    expect(p.deleteMessage).not.toHaveBeenCalled();
  });
  it("does not execute when current authorization rejects an old approval", async () => {
    const p = ports(); vi.mocked(p.authorizeAndResolve).mockRejectedValue(new Error("STALE_APPROVAL"));
    await expect(consumeQueenWorkflowEvent(JSON.stringify(event), p, now)).rejects.toThrow("STALE_APPROVAL");
    expect(p.executeDurably).not.toHaveBeenCalled();
    expect(p.deleteMessage).not.toHaveBeenCalled();
  });
});
