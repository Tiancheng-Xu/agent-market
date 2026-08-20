export type PerformanceMetricName = "TTFB" | "FCP" | "LCP" | "CLS" | "INP";

export type PerformanceMetrics = Partial<Record<PerformanceMetricName, number>>;

export interface PerformanceEnvelopeInput {
  requestId: string;
  route: string;
  version: string;
  observedAt: string;
  metrics: PerformanceMetrics;
}

export interface PerformanceEnvelope extends PerformanceEnvelopeInput {
  schemaVersion: 1;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeRoute(route: string): string {
  const pathname = route.split(/[?#]/u, 1)[0] || "/";
  return pathname.startsWith("/") ? pathname.slice(0, 256) : "/";
}

export function buildPerformanceEnvelope(
  input: PerformanceEnvelopeInput,
): PerformanceEnvelope {
  if (!uuidPattern.test(input.requestId)) {
    throw new Error("PERFORMANCE_REQUEST_ID_INVALID");
  }

  const metrics = Object.fromEntries(
    Object.entries(input.metrics).filter(([, value]) => (
      typeof value === "number" && Number.isFinite(value) && value >= 0
    )),
  ) as PerformanceMetrics;

  return {
    schemaVersion: 1,
    requestId: input.requestId,
    route: safeRoute(input.route),
    version: input.version.slice(0, 64),
    observedAt: input.observedAt,
    metrics,
  };
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

interface EventTimingEntry extends PerformanceEntry {
  duration: number;
}

export function startPerformanceCollection(options: {
  endpoint?: string;
  route: string;
  version: string;
  flushAfterMs?: number;
}): { flush(): Promise<void>; stop(): void } {
  const metrics: PerformanceMetrics = {};
  const observers: PerformanceObserver[] = [];
  const requestId = crypto.randomUUID();
  let flushed = false;

  const navigation = performance.getEntriesByType("navigation")[0] as (
    PerformanceNavigationTiming | undefined
  );
  if (navigation) metrics.TTFB = Math.max(0, navigation.responseStart);

  const observe = (
    type: string,
    callback: (entries: PerformanceObserverEntryList) => void,
  ) => {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
    const observer = new PerformanceObserver((list) => callback(list));
    observer.observe({ type, buffered: true });
    observers.push(observer);
  };

  observe("paint", (entries) => {
    const fcp = entries.getEntries().find((entry) => (
      entry.name === "first-contentful-paint"
    ));
    if (fcp) metrics.FCP = fcp.startTime;
  });
  observe("largest-contentful-paint", (entries) => {
    const last = entries.getEntries().at(-1);
    if (last) metrics.LCP = last.startTime;
  });
  observe("layout-shift", (entries) => {
    metrics.CLS = entries.getEntries()
      .map((entry) => entry as LayoutShiftEntry)
      .filter((entry) => !entry.hadRecentInput)
      .reduce((total, entry) => total + entry.value, metrics.CLS ?? 0);
  });
  observe("event", (entries) => {
    const longest = Math.max(
      metrics.INP ?? 0,
      ...entries.getEntries().map((entry) => (
        (entry as EventTimingEntry).duration
      )),
    );
    if (Number.isFinite(longest)) metrics.INP = longest;
  });

  const flush = async () => {
    if (flushed) return;
    flushed = true;
    observers.forEach((observer) => observer.disconnect());
    const envelope = buildPerformanceEnvelope({
      requestId,
      route: options.route,
      version: options.version,
      observedAt: new Date().toISOString(),
      metrics,
    });
    await fetch(options.endpoint ?? "/api/performance", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: JSON.stringify(envelope),
      credentials: "omit",
      keepalive: true,
    });
  };

  const timeoutId = setTimeout(() => void flush(), options.flushAfterMs ?? 5_000);
  return {
    flush,
    stop() {
      clearTimeout(timeoutId);
      observers.forEach((observer) => observer.disconnect());
    },
  };
}
