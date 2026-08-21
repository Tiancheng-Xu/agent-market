import { createHash, randomUUID } from "node:crypto";

import {
  DlqReplayRequestedV1Schema,
  type DlqReplayRequestedV1,
} from "@agent-market/shared-contracts";

export type JSONValue = string | number | boolean | null | JSONValue[] | JSONObject;

export interface JSONObject {
  [key: string]: JSONValue;
}

export interface ReplayableEvent {
  eventId: string;
  requestId: string;
  body: JSONObject;
}

export interface ReplayResult {
  replayId: string;
  originalEventId: string;
  requestId: string;
  idempotencyKey: string;
  status: "in_progress" | "published";
}

export interface ReplayClaimInput {
  request: DlqReplayRequestedV1;
  original: ReplayableEvent;
  bodyHash: string;
  publisherIdempotencyKey: string;
}

export interface ReplayClaim {
  claimed: boolean;
  result: ReplayResult;
}

export interface ReplayOutboxLease {
  originalEventId: string;
  requestId: string;
  event: ReplayableEvent;
  idempotencyKey: string;
  bodyHash: string;
  leaseToken: string;
  leaseUntil: Date;
  attempt: number;
}

export interface ReplayLedger {
  claim(input: ReplayClaimInput): Promise<ReplayClaim>;
  claimOutbox(options: {
    originalEventId?: string;
    now: Date;
    leaseMs: number;
  }): Promise<ReplayOutboxLease | null>;
  markPublished(lease: ReplayOutboxLease, now: Date): Promise<void>;
  markFailed(lease: ReplayOutboxLease, errorCode: string, nextAttemptAt: Date, now: Date): Promise<void>;
  find(originalEventId: string): Promise<ReplayResult | null>;
}

export interface ReplayPublisher {
  // Delivery is intentionally at-least-once. Every retry carries the same
  // stable key, so downstream consumers must deduplicate by idempotencyKey.
  publishOriginal(event: ReplayableEvent, options: { idempotencyKey: string }): Promise<void>;
}

type MemoryState = "pending" | "publishing" | "published" | "failed";

interface MemoryEntry {
  input: ReplayClaimInput;
  state: MemoryState;
  attempt: number;
  nextAttemptAt: number;
  leaseToken: string | null;
  leaseUntil: number | null;
}

export class MemoryReplayLedger implements ReplayLedger {
  private readonly entries = new Map<string, MemoryEntry>();

  async claim(input: ReplayClaimInput): Promise<ReplayClaim> {
    const key = input.request.originalEventId;
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing.input.request.requestId !== input.request.requestId
        || existing.input.bodyHash !== input.bodyHash) {
        throw new Error("REPLAY_ORIGINAL_CONFLICT");
      }
      return { claimed: false, result: resultFor(existing) };
    }

    const entry: MemoryEntry = {
      input: structuredClone(input),
      state: "pending",
      attempt: 0,
      nextAttemptAt: 0,
      leaseToken: null,
      leaseUntil: null,
    };
    this.entries.set(key, entry);
    return { claimed: true, result: resultFor(entry) };
  }

  async claimOutbox(options: {
    originalEventId?: string;
    now: Date;
    leaseMs: number;
  }): Promise<ReplayOutboxLease | null> {
    const now = options.now.getTime();
    const candidates = [...this.entries.entries()]
      .filter(([eventId, entry]) => (options.originalEventId === undefined || eventId === options.originalEventId)
        && entry.state !== "published"
        && entry.nextAttemptAt <= now
        && (entry.leaseUntil === null || entry.leaseUntil <= now))
      .sort(([left], [right]) => left.localeCompare(right));
    const selected = candidates[0];
    if (selected === undefined) return null;

    const [originalEventId, entry] = selected;
    entry.state = "publishing";
    entry.attempt += 1;
    entry.leaseToken = randomUUID();
    entry.leaseUntil = now + options.leaseMs;
    return {
      originalEventId,
      requestId: entry.input.request.requestId,
      event: structuredClone(entry.input.original),
      idempotencyKey: entry.input.publisherIdempotencyKey,
      bodyHash: entry.input.bodyHash,
      leaseToken: entry.leaseToken,
      leaseUntil: new Date(entry.leaseUntil),
      attempt: entry.attempt,
    };
  }

  async markPublished(lease: ReplayOutboxLease, _now: Date): Promise<void> {
    const entry = this.requireLease(lease);
    entry.state = "published";
    entry.leaseToken = null;
    entry.leaseUntil = null;
  }

  async markFailed(
    lease: ReplayOutboxLease,
    _errorCode: string,
    nextAttemptAt: Date,
    _now: Date,
  ): Promise<void> {
    const entry = this.requireLease(lease);
    entry.state = "failed";
    entry.nextAttemptAt = nextAttemptAt.getTime();
    entry.leaseToken = null;
    entry.leaseUntil = null;
  }

  async find(originalEventId: string): Promise<ReplayResult | null> {
    const entry = this.entries.get(originalEventId);
    return entry === undefined ? null : resultFor(entry);
  }

  private requireLease(lease: ReplayOutboxLease): MemoryEntry {
    const entry = this.entries.get(lease.originalEventId);
    if (entry === undefined || entry.state !== "publishing" || entry.leaseToken !== lease.leaseToken) {
      throw new Error("REPLAY_LEASE_LOST");
    }
    return entry;
  }
}

function resultFor(entry: MemoryEntry): ReplayResult {
  return {
    replayId: entry.input.request.replayId,
    originalEventId: entry.input.request.originalEventId,
    requestId: entry.input.request.requestId,
    idempotencyKey: entry.input.publisherIdempotencyKey,
    status: entry.state === "published" ? "published" : "in_progress",
  };
}

export class RecoveryOutboxRelay {
  constructor(
    private readonly ledger: ReplayLedger,
    private readonly publisher: ReplayPublisher,
    private readonly options: {
      now?: () => Date;
      leaseMs?: number;
      retryDelayMs?: number;
    } = {},
  ) {}

  async deliverNext(originalEventId?: string): Promise<ReplayResult | null> {
    const now = this.options.now?.() ?? new Date();
    const leaseMs = this.options.leaseMs ?? 30_000;
    const lease = await this.ledger.claimOutbox(originalEventId === undefined
      ? { now, leaseMs }
      : { originalEventId, now, leaseMs });
    if (lease === null) return originalEventId === undefined ? null : this.ledger.find(originalEventId);
    if (hashCanonicalJson(lease.event.body) !== lease.bodyHash) {
      throw new Error("REPLAY_BODY_HASH_MISMATCH");
    }

    try {
      await this.publisher.publishOriginal(structuredClone(lease.event), {
        idempotencyKey: lease.idempotencyKey,
      });
    } catch (error) {
      try {
        const failedAt = this.options.now?.() ?? new Date();
        await this.ledger.markFailed(
          lease,
          "REPLAY_PUBLISH_FAILED",
          new Date(failedAt.getTime() + (this.options.retryDelayMs ?? 1_000)),
          failedAt,
        );
      } catch {
        // The durable lease expires and becomes claimable. Preserve the
        // publisher error from this worker.
      }
      throw error;
    }

    // If this commit fails after publish, lease expiry permits another worker
    // to republish with the same stable key.
    await this.ledger.markPublished(lease, this.options.now?.() ?? new Date());
    const result = await this.ledger.find(lease.originalEventId);
    if (result === null) throw new Error("REPLAY_RESULT_NOT_PERSISTED");
    return result;
  }
}

export class RecoveryReplayService {
  private readonly relay: RecoveryOutboxRelay;

  constructor(
    private readonly ledger: ReplayLedger,
    publisher: ReplayPublisher,
    options: ConstructorParameters<typeof RecoveryOutboxRelay>[2] = {},
  ) {
    this.relay = new RecoveryOutboxRelay(ledger, publisher, options);
  }

  async replay(requestInput: unknown, original: ReplayableEvent): Promise<ReplayResult> {
    const request = DlqReplayRequestedV1Schema.parse(requestInput);
    validateOriginalIdentity(request, original);
    const publisherIdempotencyKey = `dlq-replay-v1:${request.originalEventId}`;
    const claim = await this.ledger.claim({
      request,
      original: structuredClone(original),
      bodyHash: hashCanonicalJson(original.body),
      publisherIdempotencyKey,
    });

    const delivered = await this.relay.deliverNext(request.originalEventId);
    return delivered ?? claim.result;
  }

  async relayNext(): Promise<ReplayResult | null> {
    return this.relay.deliverNext();
  }
}

function validateOriginalIdentity(request: DlqReplayRequestedV1, original: ReplayableEvent): void {
  if (original.eventId !== request.originalEventId || original.requestId !== request.requestId
    || original.body.eventId !== original.eventId || original.body.requestId !== original.requestId) {
    throw new Error("REPLAY_IDENTITY_MISMATCH");
  }
}

export function hashCanonicalJson(body: JSONValue): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("REPLAY_BODY_INVALID");
}
