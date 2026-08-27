import { describe, expect, it } from "vitest";

import {
  buildPerformanceEnvelope,
  createUuidV7,
  summarizeFrameTimings,
} from "./collector";

describe("performance evidence envelope", () => {
  it("keeps request continuity while removing query and fragment data", () => {
    const envelope = buildPerformanceEnvelope({
      requestId: "7dc42790-a91c-7d62-9d5d-a08bb5211141",
      route: "/evidence?wallet=private#section",
      version: "v1",
      observedAt: "2026-08-20T18:00:00.000Z",
      metrics: {
        TTFB: 120,
        FCP: 340,
        LCP: 510,
        CLS: 0.01,
        INP: 90,
        FPS: 59.8,
        FRAME_TIME_P95: 18.2,
        DROPPED_FRAME_RATIO: 0.02,
        FRAME_SAMPLE_COUNT: 298,
        FRAME_WINDOW_DURATION: 5_000,
        HYDRATION_DURATION: 42,
      },
      render: {
        mode: "hydrate",
        outcome: "hydrated",
        recoverableErrorCount: 0,
        fallbackCount: 0,
      },
    });

    expect(envelope).toEqual({
      schemaVersion: 2,
      requestId: "7dc42790-a91c-7d62-9d5d-a08bb5211141",
      route: "/evidence",
      version: "v1",
      observedAt: "2026-08-20T18:00:00.000Z",
      metrics: {
        TTFB: 120,
        FCP: 340,
        LCP: 510,
        CLS: 0.01,
        INP: 90,
        FPS: 59.8,
        FRAME_TIME_P95: 18.2,
        DROPPED_FRAME_RATIO: 0.02,
        FRAME_SAMPLE_COUNT: 298,
        FRAME_WINDOW_DURATION: 5_000,
        HYDRATION_DURATION: 42,
      },
      render: {
        mode: "hydrate",
        outcome: "hydrated",
        recoverableErrorCount: 0,
        fallbackCount: 0,
      },
    });
    expect(JSON.stringify(envelope)).not.toContain("wallet");
  });

  it("rejects an invalid request id", () => {
    expect(() => buildPerformanceEnvelope({
      requestId: "not-a-uuid",
      route: "/",
      version: "v1",
      observedAt: "2026-08-20T18:00:00.000Z",
      metrics: { LCP: 500 },
      render: {
        mode: "unknown",
        outcome: "not-observed",
        recoverableErrorCount: 0,
        fallbackCount: 0,
      },
    })).toThrowError("PERFORMANCE_REQUEST_ID_INVALID");
  });

  it("creates an RFC 9562 UUIDv7 request id", () => {
    const id = createUuidV7({
      now: () => 1_787_800_000_000,
      random: (bytes) => bytes.fill(0xab),
    });

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("summarizes a bounded frame window without device identity", () => {
    expect(summarizeFrameTimings([0, 16.67, 33.34, 83.34])).toEqual({
      FPS: expect.closeTo(36, 0),
      FRAME_TIME_P95: expect.closeTo(47, 0),
      DROPPED_FRAME_RATIO: 0.4,
      FRAME_SAMPLE_COUNT: 4,
      FRAME_WINDOW_DURATION: 83.34,
    });
  });
});
