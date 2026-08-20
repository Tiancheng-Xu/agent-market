export interface OutboxRecord {
  id: string;
  requestId: string;
  topic: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface OutboxStore {
  claim(limit: number): Promise<readonly OutboxRecord[]>;
  markPublished(id: string): Promise<void>;
  markFailed(id: string, reason: string): Promise<void>;
}

export interface EventPublisher {
  publish(event: OutboxRecord): Promise<void>;
}

export interface OutboxDispatchResult {
  claimed: number;
  published: number;
  failed: number;
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : "OUTBOX_PUBLISH_FAILED";
}

export async function dispatchOutboxBatch(
  store: OutboxStore,
  publisher: EventPublisher,
  limit: number,
): Promise<OutboxDispatchResult> {
  const records = await store.claim(limit);
  let published = 0;
  let failed = 0;

  for (const record of records) {
    try {
      await publisher.publish(record);
      await store.markPublished(record.id);
      published += 1;
    } catch (error) {
      await store.markFailed(record.id, errorReason(error));
      failed += 1;
    }
  }

  return {
    claimed: records.length,
    published,
    failed,
  };
}
