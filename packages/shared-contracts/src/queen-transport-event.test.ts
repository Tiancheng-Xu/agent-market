import { describe, expect, it } from "vitest";
import { QueenWorkflowEventSchema } from "./queen-orchestration";
import { QueenTransportEventSchema, queenTransportOperationParts } from "./queen-transport-event";

const id = "11111111-1111-4111-8111-111111111111";
const hash = `sha256:${"a".repeat(64)}`;
const event = { schemaVersion: "queen-workflow-event.v1", eventId: id, eventType: "task.requested",
  taskId: id, scopeId: id, graphRevision: 1, taskFingerprint: hash, operationKey: hash,
  payloadRef: id, payloadHash: hash, occurredAt: "2026-09-09T00:00:00.000Z", expiresAt: "2026-09-09T01:00:00.000Z" };

describe("Queen transport contract", () => {
  it("is distinct from the workflow audit event", () => {
    expect(QueenTransportEventSchema.safeParse(event).success).toBe(true);
    expect(QueenWorkflowEventSchema.safeParse(event).success).toBe(false);
    expect(QueenTransportEventSchema.safeParse({ eventId: id, taskId: id, graphRevision: 1,
      eventType: "graph_proposed", actorAgentId: "queen", createdAt: event.occurredAt, summary: "Planned" }).success).toBe(false);
  });
  it.each(["task.requested", "task.approval-recorded", "task.resume-requested"])("accepts %s without granting execution", eventType => {
    expect(QueenTransportEventSchema.safeParse({ ...event, eventType }).success).toBe(true);
  });
  it.each(["2026-09-09T00:00:00.000Z", "2026-09-08T23:59:59.000Z"])("rejects non-increasing expiry %s", expiresAt => {
    expect(QueenTransportEventSchema.safeParse({ ...event, expiresAt }).success).toBe(false);
  });
  it("rejects injected authority and private payload fields", () => {
    expect(QueenTransportEventSchema.safeParse({ ...event, approved: true }).success).toBe(false);
    expect(QueenTransportEventSchema.safeParse({ ...event, prompt: "private" }).success).toBe(false);
  });
  it("preserves the existing operation-key domain and ordering", () => {
    const parsed = QueenTransportEventSchema.parse(event);
    expect(queenTransportOperationParts(parsed)).toEqual([
      "queen-workflow-event.v1", "task.requested", id, id, 1, hash, id, hash,
    ]);
    expect(queenTransportOperationParts({ ...parsed, scopeId: "22222222-2222-4222-8222-222222222222" })).not.toEqual(queenTransportOperationParts(parsed));
  });
});
