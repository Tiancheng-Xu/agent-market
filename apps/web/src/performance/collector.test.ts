import { describe, expect, it } from "vitest";

import { buildPerformanceEnvelope, createUuidV7 } from "./collector";

describe("performance evidence envelope", () => {
  it("keeps request continuity while removing query and fragment data", () => {
    const envelope = buildPerformanceEnvelope({
      requestId: "0198f8e2-0b80-7d1a-8a2b-d08bb5211141",
      route: "/evidence?wallet=private#section",
      version: "v1",
      observedAt: "2026-08-20T18:00:00.000Z",
      metrics: {
        TTFB: 120,
        FCP: 340,
        LCP: 510,
        CLS: 0.01,
        INP: 90,
      },
    });

    expect(envelope).toEqual({
      schemaVersion: 1,
      requestId: "0198f8e2-0b80-7d1a-8a2b-d08bb5211141",
      route: "/evidence",
      version: "v1",
      observedAt: "2026-08-20T18:00:00.000Z",
      metrics: {
        TTFB: 120,
        FCP: 340,
        LCP: 510,
        CLS: 0.01,
        INP: 90,
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
    })).toThrowError("PERFORMANCE_REQUEST_ID_INVALID");
  });

  it("creates the UUIDv7 required by AWS ingestion", () => {
    expect(createUuidV7(1_777_000_000_000)).toMatch(/^[0-9a-f-]{14}7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
