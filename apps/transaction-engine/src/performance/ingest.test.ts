import { describe, expect, it } from "vitest";

import { acceptPerformanceEnvelope } from "./ingest";

describe("performance ingestion", () => {
  it("validates and publishes a versioned event with request continuity", async () => {
    const published: unknown[] = [];
    const result = await acceptPerformanceEnvelope(JSON.stringify({
      schemaVersion: 2,
      requestId: "7dc42790-a91c-7d62-9d5d-a08bb5211141",
      route: "/evidence",
      version: "v1",
      observedAt: "2026-08-20T18:00:00.000Z",
      metrics: {
        TTFB: 120, FCP: 340, LCP: 510, CLS: 0.01, INP: 90,
        FPS: 59.8, FRAME_TIME_P95: 18.2, DROPPED_FRAME_RATIO: 0.02,
        FRAME_SAMPLE_COUNT: 298, FRAME_WINDOW_DURATION: 5_000,
        HYDRATION_DURATION: 42,
      },
      render: {
        mode: "hydrate",
        outcome: "hydrated",
        recoverableErrorCount: 0,
        fallbackCount: 0,
      },
    }), {
      async publish(event) { published.push(event); },
    });

    expect(result).toEqual({
      accepted: true,
      requestId: "7dc42790-a91c-7d62-9d5d-a08bb5211141",
    });
    expect(published).toEqual([expect.objectContaining({
      eventType: "PerformanceObserved",
      requestId: "7dc42790-a91c-7d62-9d5d-a08bb5211141",
      route: "/evidence",
      metrics: expect.objectContaining({ LCP: 510 }),
      render: expect.objectContaining({ outcome: "hydrated" }),
    })]);
  });

  it("rejects an out-of-range frame ratio", async () => {
    await expect(acceptPerformanceEnvelope(JSON.stringify({
      schemaVersion: 2,
      requestId: "7dc42790-a91c-4d62-9d5d-a08bb5211141",
      route: "/evidence",
      version: "v2",
      observedAt: "2026-08-27T08:00:00.000Z",
      metrics: { LCP: 510, DROPPED_FRAME_RATIO: 1.1 },
      render: { mode: "hydrate", outcome: "hydrated", recoverableErrorCount: 0, fallbackCount: 0 },
    }), { async publish() {} })).rejects.toThrowError("PERFORMANCE_ENVELOPE_INVALID");
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
