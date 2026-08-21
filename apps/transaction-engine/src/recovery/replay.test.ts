import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  MemoryReplayLedger,
  RecoveryOutboxRelay,
  RecoveryReplayService,
  type ReplayLedger,
  type ReplayableEvent,
} from "./replay";

const request = {
  replayId: "0191f6f8-cb6b-7f31-81ad-c497d7d90501",
  type: "dlq.replay.requested.v1" as const,
  occurredAt: "2026-08-21T12:00:00.000Z",
  originalEventId: "0191f6f8-cb6b-7f31-81ad-c497d7d90502",
  requestId: "0191f6f8-cb6b-7f31-81ad-c497d7d90503",
  idempotencyKey: "replay-identity-001",
  reason: "operator approved after dependency recovery",
};
const original: ReplayableEvent = {
  eventId: request.originalEventId,
  requestId: request.requestId,
  body: { eventId: request.originalEventId, requestId: request.requestId, value: "original" },
};
const originalBodyHash = createHash("sha256").update(JSON.stringify(original.body)).digest("hex");

describe("DLQ recovery replay", () => {
  it("publishes once by globally unique original identity even if the operator key changes", async () => {
    const published: Array<{ event: ReplayableEvent; key: string }> = [];
    const service = new RecoveryReplayService(new MemoryReplayLedger(), {
      async publishOriginal(event, options) { published.push({ event, key: options.idempotencyKey }); },
    });
    expect((await service.replay(request, original)).status).toBe("published");
    expect((await service.replay({
      ...request,
      replayId: "0191f6f8-cb6b-7f31-81ad-c497d7d90509",
      idempotencyKey: "different-operator-key",
    }, original)).status).toBe("published");
    expect(published).toEqual([{ event: original, key: `dlq-replay-v1:${request.originalEventId}` }]);
  });

  it("rejects wrapper and original-body identity substitution", async () => {
    const service = new RecoveryReplayService(new MemoryReplayLedger(), {
      async publishOriginal() { throw new Error("must not publish"); },
    });
    await expect(service.replay(request, { ...original, requestId: "0191f6f8-cb6b-7f31-81ad-c497d7d90508" }))
      .rejects.toThrow("REPLAY_IDENTITY_MISMATCH");
    await expect(service.replay(request, {
      ...original,
      body: { ...original.body, eventId: "0191f6f8-cb6b-7f31-81ad-c497d7d90508" },
    })).rejects.toThrow("REPLAY_IDENTITY_MISMATCH");
  });

  it("reclaims a lease after a crash between durable claim and publish", async () => {
    let now = new Date("2026-08-21T12:00:00.000Z");
    const ledger = new MemoryReplayLedger();
    const service = new RecoveryReplayService(ledger, { async publishOriginal() {} }, {
      now: () => now,
      leaseMs: 1_000,
    });
    await ledger.claim({
      request,
      original,
      bodyHash: originalBodyHash,
      publisherIdempotencyKey: `dlq-replay-v1:${request.originalEventId}`,
    });
    expect(await ledger.claimOutbox({ originalEventId: request.originalEventId, now, leaseMs: 1_000 }))
      .toMatchObject({ attempt: 1 });
    now = new Date(now.getTime() + 1_001);
    await expect(service.replay(request, original)).resolves.toMatchObject({ status: "published" });
  });

  it("retries a definite failure only after next_attempt_at", async () => {
    let now = new Date("2026-08-21T12:00:00.000Z");
    let attempts = 0;
    const service = new RecoveryReplayService(new MemoryReplayLedger(), {
      async publishOriginal() { attempts += 1; if (attempts === 1) throw new Error("PUBLISH_UNAVAILABLE"); },
    }, { now: () => now, retryDelayMs: 1_000 });
    await expect(service.replay(request, original)).rejects.toThrow("PUBLISH_UNAVAILABLE");
    await expect(service.replay(request, original)).resolves.toMatchObject({ status: "in_progress" });
    now = new Date(now.getTime() + 1_001);
    await expect(service.replay(request, original)).resolves.toMatchObject({ status: "published" });
    expect(attempts).toBe(2);
  });

  it("returns in_progress to a concurrent loser while a valid lease is held", async () => {
    let releasePublish!: () => void;
    let notifyStarted!: () => void;
    const publishing = new Promise<void>((resolve) => { releasePublish = resolve; });
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    let calls = 0;
    const service = new RecoveryReplayService(new MemoryReplayLedger(), {
      async publishOriginal() { calls += 1; notifyStarted(); await publishing; },
    });
    const winner = service.replay(request, original);
    await started;
    await expect(service.replay(request, original)).resolves.toMatchObject({ status: "in_progress" });
    releasePublish();
    await expect(winner).resolves.toMatchObject({ status: "published" });
    expect(calls).toBe(1);
  });

  it("republishes with the same key after publish succeeds but durable completion fails", async () => {
    let now = new Date("2026-08-21T12:00:00.000Z");
    const durable = new MemoryReplayLedger();
    let failCompletion = true;
    const ledger: ReplayLedger = {
      claim: (input) => durable.claim(input),
      claimOutbox: (options) => durable.claimOutbox(options),
      markPublished: async (lease, completedAt) => {
        if (failCompletion) { failCompletion = false; throw new Error("LEDGER_UNAVAILABLE"); }
        await durable.markPublished(lease, completedAt);
      },
      markFailed: (lease, code, nextAttemptAt, failedAt) => durable.markFailed(lease, code, nextAttemptAt, failedAt),
      find: (eventId) => durable.find(eventId),
    };
    const keys: string[] = [];
    const service = new RecoveryReplayService(ledger, {
      async publishOriginal(_event, options) { keys.push(options.idempotencyKey); },
    }, { now: () => now, leaseMs: 1_000 });
    await expect(service.replay(request, original)).rejects.toThrow("LEDGER_UNAVAILABLE");
    now = new Date(now.getTime() + 1_001);
    await expect(service.replay(request, original)).resolves.toMatchObject({ status: "published" });
    expect(keys).toEqual([
      `dlq-replay-v1:${request.originalEventId}`,
      `dlq-replay-v1:${request.originalEventId}`,
    ]);
  });

  it("exposes a worker primitive that drains the next ready outbox row", async () => {
    const ledger = new MemoryReplayLedger();
    await ledger.claim({
      request,
      original,
      bodyHash: originalBodyHash,
      publisherIdempotencyKey: `dlq-replay-v1:${request.originalEventId}`,
    });
    const relay = new RecoveryOutboxRelay(ledger, { async publishOriginal() {} });
    await expect(relay.deliverNext()).resolves.toMatchObject({ status: "published" });
    await expect(relay.deliverNext()).resolves.toBeNull();
  });

  it("fails closed before publish when a leased body no longer matches its stored hash", async () => {
    let published = false;
    const ledger: ReplayLedger = {
      async claim() { throw new Error("not used"); },
      async claimOutbox() {
        return {
          originalEventId: request.originalEventId,
          requestId: request.requestId,
          event: { ...original, body: { ...original.body, value: "tampered" } },
          idempotencyKey: `dlq-replay-v1:${request.originalEventId}`,
          bodyHash: originalBodyHash,
          leaseToken: "0191f6f8-cb6b-7f31-81ad-c497d7d90510",
          leaseUntil: new Date("2026-08-21T12:01:00.000Z"),
          attempt: 1,
        };
      },
      async markPublished() { throw new Error("must not complete"); },
      async markFailed() { throw new Error("must not mutate a corrupt lease"); },
      async find() { return null; },
    };
    const relay = new RecoveryOutboxRelay(ledger, {
      async publishOriginal() { published = true; },
    });

    await expect(relay.deliverNext()).rejects.toThrow("REPLAY_BODY_HASH_MISMATCH");
    expect(published).toBe(false);
  });
});
