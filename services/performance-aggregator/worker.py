import base64
import json
import math
import os
import uuid
from datetime import datetime


ENVELOPE_KEYS = {
    "schemaVersion",
    "eventType",
    "requestId",
    "route",
    "version",
    "observedAt",
    "metrics",
}
METRIC_KEYS = {"TTFB", "FCP", "LCP", "CLS", "INP"}


def invalid_event():
    raise ValueError("PERFORMANCE_EVENT_INVALID")


def decode_event(raw):
    try:
        event = json.loads(raw)
        if not isinstance(event, dict) or set(event) != ENVELOPE_KEYS:
            invalid_event()
        if event["schemaVersion"] != 1 or event["eventType"] != "PerformanceObserved":
            invalid_event()
        uuid.UUID(event["requestId"])
        if not isinstance(event["route"], str) or not event["route"].startswith("/"):
            invalid_event()
        if len(event["route"]) > 256 or "?" in event["route"] or "#" in event["route"]:
            invalid_event()
        if not isinstance(event["version"], str) or len(event["version"]) > 64:
            invalid_event()
        datetime.fromisoformat(event["observedAt"].replace("Z", "+00:00"))
        metrics = event["metrics"]
        if not isinstance(metrics, dict) or not metrics or not set(metrics) <= METRIC_KEYS:
            invalid_event()
        if any(
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or not math.isfinite(value)
            or value < 0
            for value in metrics.values()
        ):
            invalid_event()
        return event
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        invalid_event()


def percentile(values, fraction):
    ordered = sorted(values)
    if not ordered:
        return None
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def percentile_summary(values):
    return {
        "p50": percentile(values, 0.50),
        "p75": percentile(values, 0.75),
        "p95": percentile(values, 0.95),
    }


def load_database_secret(secret_arn, region):
    import boto3

    response = boto3.client("secretsmanager", region_name=region).get_secret_value(
        SecretId=secret_arn,
    )
    return json.loads(response["SecretString"])


def persist(event, secret):
    import psycopg

    connection = psycopg.connect(
        host=secret["host"],
        port=secret.get("port", 5432),
        user=secret["username"],
        password=secret["password"],
        dbname=secret.get("dbname", "postgres"),
        connect_timeout=10,
        sslmode="require",
    )
    metrics = event["metrics"]
    run_id = str(uuid.uuid4())
    with connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO agent_market.performance_samples (
                  request_id, route, build_version, observed_at,
                  ttfb_ms, fcp_ms, lcp_ms, cls, inp_ms
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (request_id) DO NOTHING
                """,
                (
                    event["requestId"],
                    event["route"],
                    event["version"],
                    event["observedAt"],
                    metrics.get("TTFB"),
                    metrics.get("FCP"),
                    metrics.get("LCP"),
                    metrics.get("CLS"),
                    metrics.get("INP"),
                ),
            )
            cursor.execute(
                """
                SELECT lcp_ms
                FROM agent_market.performance_samples
                WHERE route = %s AND lcp_ms IS NOT NULL
                ORDER BY observed_at DESC
                LIMIT 100
                """,
                (event["route"],),
            )
            values = [float(row[0]) for row in cursor.fetchall()]
            summary = percentile_summary(values)
            cursor.execute(
                """
                INSERT INTO agent_market.performance_runs (
                  id, source_request_id, started_at, completed_at,
                  sample_count, p50_lcp_ms, p75_lcp_ms, p95_lcp_ms,
                  error_rate, task_exit_code, evidence_status
                ) VALUES (%s, %s, now(), now(), %s, %s, %s, %s, 0, 0, 'verified')
                """,
                (
                    run_id,
                    event["requestId"],
                    len(values),
                    summary["p50"],
                    summary["p75"],
                    summary["p95"],
                ),
            )
    connection.close()
    return {"runId": run_id, "sampleCount": len(values), **summary}


def main():
    encoded = os.environ["PERFORMANCE_EVENT_B64"]
    raw = base64.b64decode(encoded).decode("utf-8")
    event = decode_event(raw)
    secret = load_database_secret(
        os.environ["DATABASE_SECRET_ARN"],
        os.environ.get("AWS_REGION", "us-east-1"),
    )
    result = persist(event, secret)
    print(json.dumps({
        "event": "performance.aggregate.complete",
        "requestId": event["requestId"],
        **result,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
