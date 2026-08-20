type MetricName = "TTFB" | "FCP" | "LCP" | "CLS" | "INP";
type Metrics = Partial<Record<MetricName, number>>;

export interface PerformanceObservedEvent {
  schemaVersion: 1;
  eventType: "PerformanceObserved";
  requestId: string;
  route: string;
  version: string;
  observedAt: string;
  metrics: Metrics;
}

export interface PerformancePublisher {
  publish(event: PerformanceObservedEvent): Promise<void>;
}

const envelopeKeys = new Set([
  "schemaVersion",
  "requestId",
  "route",
  "version",
  "observedAt",
  "metrics",
]);
const metricKeys = new Set<MetricName>(["TTFB", "FCP", "LCP", "CLS", "INP"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(): never {
  throw new Error("PERFORMANCE_ENVELOPE_INVALID");
}

function parseEnvelope(body: string): PerformanceObservedEvent {
  let candidate: unknown;
  try {
    candidate = JSON.parse(body);
  } catch {
    return invalid();
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return invalid();
  }

  const record = candidate as Record<string, unknown>;
  if (Object.keys(record).some((key) => !envelopeKeys.has(key))) return invalid();
  if (record.schemaVersion !== 1) return invalid();
  if (typeof record.requestId !== "string" || !uuidPattern.test(record.requestId)) {
    return invalid();
  }
  if (
    typeof record.route !== "string"
    || !record.route.startsWith("/")
    || record.route.length > 256
    || /[?#]/u.test(record.route)
  ) return invalid();
  if (typeof record.version !== "string" || record.version.length > 64) {
    return invalid();
  }
  if (
    typeof record.observedAt !== "string"
    || !Number.isFinite(Date.parse(record.observedAt))
  ) return invalid();
  if (!record.metrics || typeof record.metrics !== "object" || Array.isArray(record.metrics)) {
    return invalid();
  }

  const metricRecord = record.metrics as Record<string, unknown>;
  if (
    Object.keys(metricRecord).length === 0
    || Object.keys(metricRecord).some((key) => !metricKeys.has(key as MetricName))
    || Object.values(metricRecord).some((value) => (
      typeof value !== "number" || !Number.isFinite(value) || value < 0
    ))
  ) return invalid();

  return {
    schemaVersion: 1,
    eventType: "PerformanceObserved",
    requestId: record.requestId,
    route: record.route,
    version: record.version,
    observedAt: record.observedAt,
    metrics: metricRecord as Metrics,
  };
}

export async function acceptPerformanceEnvelope(
  body: string,
  publisher: PerformancePublisher,
): Promise<{ accepted: true; requestId: string }> {
  const event = parseEnvelope(body);
  await publisher.publish(event);
  return { accepted: true, requestId: event.requestId };
}
