type LegacyMetricName = "TTFB" | "FCP" | "LCP" | "CLS" | "INP";
type MetricName = LegacyMetricName | "FPS" | "FRAME_TIME_P95" | "DROPPED_FRAME_RATIO" | "FRAME_SAMPLE_COUNT" | "FRAME_WINDOW_DURATION" | "HYDRATION_DURATION";
type Metrics = Partial<Record<MetricName, number>>;

interface RenderObservation {
  mode: "hydrate" | "csr" | "unknown";
  outcome: "hydrated" | "csr" | "csr-fallback" | "not-observed";
  recoverableErrorCount: number;
  fallbackCount: number;
}

export interface PerformanceObservedEvent {
  schemaVersion: 1 | 2;
  eventType: "PerformanceObserved";
  requestId: string;
  route: string;
  version: string;
  observedAt: string;
  metrics: Metrics;
  render?: RenderObservation;
}

export interface PerformancePublisher { publish(event: PerformanceObservedEvent): Promise<void>; }

const baseKeys = ["schemaVersion", "requestId", "route", "version", "observedAt", "metrics"];
const envelopeKeysV1 = new Set(baseKeys);
const envelopeKeysV2 = new Set([...baseKeys, "render"]);
const legacyMetricKeys = new Set<MetricName>(["TTFB", "FCP", "LCP", "CLS", "INP"]);
const metricBounds: Record<MetricName, number> = {
  TTFB: 300_000, FCP: 300_000, LCP: 300_000, CLS: 100, INP: 300_000,
  FPS: 240, FRAME_TIME_P95: 10_000, DROPPED_FRAME_RATIO: 1,
  FRAME_SAMPLE_COUNT: 100_000, FRAME_WINDOW_DURATION: 60_000,
  HYDRATION_DURATION: 300_000,
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(): never { throw new Error("PERFORMANCE_ENVELOPE_INVALID"); }

function parseRender(value: unknown): RenderObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const render = value as Record<string, unknown>;
  if (Object.keys(render).some((key) => !["mode", "outcome", "recoverableErrorCount", "fallbackCount"].includes(key))
    || Object.keys(render).length !== 4
    || typeof render.mode !== "string" || !["hydrate", "csr", "unknown"].includes(render.mode)
    || typeof render.outcome !== "string" || !["hydrated", "csr", "csr-fallback", "not-observed"].includes(render.outcome)
    || !Number.isInteger(render.recoverableErrorCount) || (render.recoverableErrorCount as number) < 0 || (render.recoverableErrorCount as number) > 100
    || !Number.isInteger(render.fallbackCount) || (render.fallbackCount as number) < 0 || (render.fallbackCount as number) > 1) return invalid();
  return render as unknown as RenderObservation;
}

function parseEnvelope(body: string): PerformanceObservedEvent {
  let candidate: unknown;
  try { candidate = JSON.parse(body); } catch { return invalid(); }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return invalid();
  const record = candidate as Record<string, unknown>;
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) return invalid();
  const allowedKeys = record.schemaVersion === 2 ? envelopeKeysV2 : envelopeKeysV1;
  if (Object.keys(record).length !== allowedKeys.size || Object.keys(record).some((key) => !allowedKeys.has(key))) return invalid();
  if (typeof record.requestId !== "string" || !uuidPattern.test(record.requestId)
    || (record.schemaVersion === 2 && record.requestId[14] !== "7")) return invalid();
  if (typeof record.route !== "string" || !record.route.startsWith("/") || record.route.length > 256 || /[?#]/u.test(record.route)) return invalid();
  if (typeof record.version !== "string" || record.version.length > 64) return invalid();
  if (typeof record.observedAt !== "string" || !Number.isFinite(Date.parse(record.observedAt))) return invalid();
  if (!record.metrics || typeof record.metrics !== "object" || Array.isArray(record.metrics)) return invalid();
  const metricRecord = record.metrics as Record<string, unknown>;
  const allowedMetrics = record.schemaVersion === 1 ? legacyMetricKeys : new Set(Object.keys(metricBounds));
  if (Object.keys(metricRecord).length === 0 || Object.keys(metricRecord).some((key) => !allowedMetrics.has(key))) return invalid();
  for (const [key, value] of Object.entries(metricRecord)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > metricBounds[key as MetricName]
      || (key === "FRAME_SAMPLE_COUNT" && !Number.isInteger(value))) return invalid();
  }
  const render = record.schemaVersion === 2 ? parseRender(record.render) : undefined;
  return {
    schemaVersion: record.schemaVersion,
    eventType: "PerformanceObserved",
    requestId: record.requestId,
    route: record.route,
    version: record.version,
    observedAt: record.observedAt,
    metrics: metricRecord as Metrics,
    ...(render ? { render } : {}),
  };
}

export async function acceptPerformanceEnvelope(body: string, publisher: PerformancePublisher): Promise<{ accepted: true; requestId: string }> {
  const event = parseEnvelope(body);
  await publisher.publish(event);
  return { accepted: true, requestId: event.requestId };
}
