import { describe, expect, it } from "vitest";

import { buildPerformanceEnvelope } from "./collector";

describe("performance evidence envelope", () => {
  it("keeps request continuity while removing query and fragment data", () => {
    const envelope = buildPerformanceEnvelope({
      requestId: "7dc42790-a91c-4d62-9d5d-a08bb5211141",
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
      requestId: "7dc42790-a91c-4d62-9d5d-a08bb5211141",
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
});
