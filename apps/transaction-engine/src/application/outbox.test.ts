import { describe, expect, it } from "vitest";

import {
  dispatchOutboxBatch,
  type EventPublisher,
  type OutboxRecord,
  type OutboxStore,
} from "./outbox";

class MemoryOutboxStore implements OutboxStore {
  readonly published: string[] = [];
  readonly failed: Array<{ id: string; reason: string }> = [];

  constructor(private readonly records: OutboxRecord[]) {}

  async claim(limit: number): Promise<readonly OutboxRecord[]> {
    return this.records.slice(0, limit);
  }

  async markPublished(id: string): Promise<void> {
    this.published.push(id);
  }

  async markFailed(id: string, reason: string): Promise<void> {
    this.failed.push({ id, reason });
  }
}

describe("transactional outbox dispatcher", () => {
  it("forwards request_id and acknowledges only after publish succeeds", async () => {
    const record: OutboxRecord = {
      id: "outbox-01",
      requestId: "req-match-01",
      topic: "matching.requested",
      payload: { taskId: "task-01" },
    };
    const store = new MemoryOutboxStore([record]);
    const received: OutboxRecord[] = [];
    const publisher: EventPublisher = {
      async publish(event) {
        received.push(event);
      },
    };

    const result = await dispatchOutboxBatch(store, publisher, 10);

    expect(received).toEqual([record]);
    expect(store.published).toEqual(["outbox-01"]);
    expect(store.failed).toEqual([]);
    expect(result).toEqual({ claimed: 1, published: 1, failed: 0 });
  });

  it("keeps a failed event available for retry", async () => {
    const store = new MemoryOutboxStore([{
      id: "outbox-02",
      requestId: "req-match-02",
      topic: "matching.requested",
      payload: { taskId: "task-02" },
    }]);
    const publisher: EventPublisher = {
      async publish() {
        throw new Error("SNS_UNAVAILABLE");
      },
    };

    const result = await dispatchOutboxBatch(store, publisher, 10);

    expect(store.published).toEqual([]);
    expect(store.failed).toEqual([{
      id: "outbox-02",
      reason: "SNS_UNAVAILABLE",
    }]);
    expect(result).toEqual({ claimed: 1, published: 0, failed: 1 });
  });
});
