export type PerformanceMetricName =
  | "TTFB" | "FCP" | "LCP" | "CLS" | "INP"
  | "FPS" | "FRAME_TIME_P95" | "DROPPED_FRAME_RATIO"
  | "FRAME_SAMPLE_COUNT" | "FRAME_WINDOW_DURATION"
  | "HYDRATION_DURATION";

export type PerformanceMetrics = Partial<Record<PerformanceMetricName, number>>;

export interface RenderObservation {
  mode: "hydrate" | "csr" | "unknown";
  outcome: "hydrated" | "csr" | "csr-fallback" | "not-observed";
  recoverableErrorCount: number;
  fallbackCount: number;
}

export interface PerformanceEnvelopeInput {
  requestId: string;
  route: string;
  version: string;
  observedAt: string;
  metrics: PerformanceMetrics;
  render: RenderObservation;
}

export interface PerformanceEnvelope extends PerformanceEnvelopeInput {
  schemaVersion: 2;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const metricBounds: Record<PerformanceMetricName, number> = {
  TTFB: 300_000,
  FCP: 300_000,
  LCP: 300_000,
  CLS: 100,
  INP: 300_000,
  FPS: 240,
  FRAME_TIME_P95: 10_000,
  DROPPED_FRAME_RATIO: 1,
  FRAME_SAMPLE_COUNT: 100_000,
  FRAME_WINDOW_DURATION: 60_000,
  HYDRATION_DURATION: 300_000,
};

function safeRoute(route: string): string {
  const pathname = route.split(/[?#]/u, 1)[0] || "/";
  return pathname.startsWith("/") ? pathname.slice(0, 256) : "/";
}

function validRender(render: RenderObservation): boolean {
  return ["hydrate", "csr", "unknown"].includes(render.mode)
    && ["hydrated", "csr", "csr-fallback", "not-observed"].includes(render.outcome)
    && Number.isInteger(render.recoverableErrorCount)
    && render.recoverableErrorCount >= 0
    && render.recoverableErrorCount <= 100
    && Number.isInteger(render.fallbackCount)
    && render.fallbackCount >= 0
    && render.fallbackCount <= 1;
}

export function buildPerformanceEnvelope(input: PerformanceEnvelopeInput): PerformanceEnvelope {
  if (!uuidPattern.test(input.requestId)) throw new Error("PERFORMANCE_REQUEST_ID_INVALID");
  if (!validRender(input.render)) throw new Error("PERFORMANCE_RENDER_INVALID");

  const metrics = Object.fromEntries(Object.entries(input.metrics).filter(([key, value]) => {
    const bound = metricBounds[key as PerformanceMetricName];
    return bound !== undefined
      && typeof value === "number"
      && Number.isFinite(value)
      && value >= 0
      && value <= bound
      && (key !== "FRAME_SAMPLE_COUNT" || Number.isInteger(value));
  })) as PerformanceMetrics;

  return {
    schemaVersion: 2,
    requestId: input.requestId,
    route: safeRoute(input.route),
    version: input.version.slice(0, 64),
    observedAt: input.observedAt,
    metrics,
    render: { ...input.render },
  };
}

export function createUuidV7(options: {
  now?: () => number;
  random?: (bytes: Uint8Array) => void;
} = {}): string {
  const bytes = new Uint8Array(16);
  if (options.random) {
    options.random(bytes);
  } else {
    crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>);
  }
  let timestamp = BigInt(Math.trunc((options.now ?? Date.now)()));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function percentile(values: number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower]!;
  const weight = position - lower;
  return ordered[lower]! * (1 - weight) + ordered[upper]! * weight;
}

export function summarizeFrameTimings(timestamps: number[]): PerformanceMetrics {
  if (timestamps.length < 2) return {};
  const intervals = timestamps.slice(1)
    .map((timestamp, index) => timestamp - timestamps[index]!)
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  if (intervals.length === 0) return {};
  const duration = intervals.reduce((total, item) => total + item, 0);
  const targetFrameMs = 1_000 / 60;
  let expectedFrames = 0;
  let droppedFrames = 0;
  for (const interval of intervals) {
    const expected = Math.max(1, Math.round(interval / targetFrameMs));
    expectedFrames += expected;
    droppedFrames += Math.max(0, expected - 1);
  }
  return {
    FPS: intervals.length * 1_000 / duration,
    FRAME_TIME_P95: percentile(intervals, 0.95),
    DROPPED_FRAME_RATIO: expectedFrames === 0 ? 0 : droppedFrames / expectedFrames,
    FRAME_SAMPLE_COUNT: timestamps.length,
    FRAME_WINDOW_DURATION: duration,
  };
}

interface LayoutShiftEntry extends PerformanceEntry { value: number; hadRecentInput: boolean; }
interface EventTimingEntry extends PerformanceEntry { duration: number; }

export function startPerformanceCollection(options: {
  endpoint?: string;
  route: string;
  version: string;
  flushAfterMs?: number;
  frameWindowMs?: number;
}): {
  flush(): Promise<void>;
  stop(): void;
  recordBootstrapMode(mode: "hydrate" | "csr"): void;
  recordRenderEvent(event: "hydration.recoverable_error" | "csr.fallback"): void;
  markInteractive(): void;
} {
  const metrics: PerformanceMetrics = {};
  const observers: PerformanceObserver[] = [];
  const requestId = createUuidV7();
  const startedAt = performance.now();
  const frameTimestamps: number[] = [];
  const frameWindowMs = Math.min(options.frameWindowMs ?? 5_000, 60_000);
  let frameRequestId: number | undefined;
  let flushed = false;
  let interactive = false;
  const render: RenderObservation = {
    mode: "unknown",
    outcome: "not-observed",
    recoverableErrorCount: 0,
    fallbackCount: 0,
  };

  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (navigation) metrics.TTFB = Math.max(0, navigation.responseStart);

  const observe = (type: string, callback: (entries: PerformanceObserverEntryList) => void) => {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
    const observer = new PerformanceObserver((list) => callback(list));
    observer.observe({ type, buffered: true });
    observers.push(observer);
  };

  observe("paint", (entries) => {
    const fcp = entries.getEntries().find((entry) => entry.name === "first-contentful-paint");
    if (fcp) metrics.FCP = fcp.startTime;
  });
  observe("largest-contentful-paint", (entries) => {
    const last = entries.getEntries().at(-1);
    if (last) metrics.LCP = last.startTime;
  });
  observe("layout-shift", (entries) => {
    metrics.CLS = entries.getEntries().map((entry) => entry as LayoutShiftEntry)
      .filter((entry) => !entry.hadRecentInput)
      .reduce((total, entry) => total + entry.value, metrics.CLS ?? 0);
  });
  observe("event", (entries) => {
    const longest = Math.max(
      metrics.INP ?? 0,
      ...entries.getEntries().map((entry) => (entry as EventTimingEntry).duration),
    );
    if (Number.isFinite(longest)) metrics.INP = longest;
  });

  const sampleFrame = (timestamp: number) => {
    if (timestamp - startedAt <= frameWindowMs) {
      frameTimestamps.push(timestamp);
      frameRequestId = requestAnimationFrame(sampleFrame);
    }
  };
  if (typeof requestAnimationFrame === "function") frameRequestId = requestAnimationFrame(sampleFrame);

  const flush = async () => {
    if (flushed) return;
    flushed = true;
    observers.forEach((observer) => observer.disconnect());
    if (frameRequestId !== undefined) cancelAnimationFrame(frameRequestId);
    Object.assign(metrics, summarizeFrameTimings(frameTimestamps));
    const envelope = buildPerformanceEnvelope({
      requestId,
      route: options.route,
      version: options.version,
      observedAt: new Date().toISOString(),
      metrics,
      render,
    });
    await fetch(options.endpoint ?? "/api/performance", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify(envelope),
      credentials: "omit",
      keepalive: true,
    });
  };

  const timeoutId = setTimeout(() => void flush(), options.flushAfterMs ?? 5_000);
  return {
    flush,
    recordBootstrapMode(mode) {
      render.mode = mode;
    },
    recordRenderEvent(event) {
      if (event === "hydration.recoverable_error") {
        render.recoverableErrorCount = Math.min(100, render.recoverableErrorCount + 1);
      } else {
        render.fallbackCount = 1;
        render.outcome = "csr-fallback";
      }
    },
    markInteractive() {
      if (interactive) return;
      interactive = true;
      metrics.HYDRATION_DURATION = Math.max(0, performance.now() - startedAt);
      render.outcome = render.fallbackCount > 0
        ? "csr-fallback"
        : render.mode === "hydrate" ? "hydrated" : "csr";
    },
    stop() {
      clearTimeout(timeoutId);
      observers.forEach((observer) => observer.disconnect());
      if (frameRequestId !== undefined) cancelAnimationFrame(frameRequestId);
    },
  };
}
