import { describe, expect, it } from "vitest";

import { acceptPerformanceEnvelope } from "./ingest";

describe("performance ingestion", () => {
  it("validates and publishes a versioned event with request continuity", async () => {
    const published: unknown[] = [];
    const result = await acceptPerformanceEnvelope(JSON.stringify({
      schemaVersion: 1,
      requestId: "7dc42790-a91c-4d62-9d5d-a08bb5211141",
      route: "/evidence",
      version: "v1",
      observedAt: "2026-08-20T18:00:00.000Z",
      metrics: { TTFB: 120, FCP: 340, LCP: 510, CLS: 0.01, INP: 90 },
    }), {
      async publish(event) { published.push(event); },
    });

    expect(result).toEqual({
      accepted: true,
      requestId: "7dc42790-a91c-4d62-9d5d-a08bb5211141",
    });
    expect(published).toEqual([expect.objectContaining({
      eventType: "PerformanceObserved",
      requestId: "7dc42790-a91c-4d62-9d5d-a08bb5211141",
      route: "/evidence",
      metrics: expect.objectContaining({ LCP: 510 }),
    })]);
  });

  it("rejects unknown fields before publishing", async () => {
    const publisher = { async publish() { throw new Error("must not publish"); } };

    await expect(acceptPerformanceEnvelope(JSON.stringify({
      schemaVersion: 1,
      requestId: "7dc42790-a91c-4d62-9d5d-a08bb5211141",
      route: "/evidence",
      version: "v1",
      observedAt: "2026-08-20T18:00:00.000Z",
      metrics: { LCP: 510 },
      wallet: "must-not-enter-event",
    }), publisher)).rejects.toThrowError("PERFORMANCE_ENVELOPE_INVALID");
  });
});
