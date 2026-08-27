import json
import unittest

from worker import decode_event, percentile_summary


class PerformanceAggregatorTest(unittest.TestCase):
    def test_decodes_valid_performance_event(self):
        event = decode_event(json.dumps({
            "schemaVersion": 2,
            "eventType": "PerformanceObserved",
            "requestId": "7dc42790-a91c-7d62-9d5d-a08bb5211141",
            "route": "/evidence",
            "version": "v1",
            "observedAt": "2026-08-20T18:00:00.000Z",
            "metrics": {
                "LCP": 510,
                "CLS": 0.01,
                "FPS": 59.8,
                "DROPPED_FRAME_RATIO": 0.02,
                "HYDRATION_DURATION": 42,
            },
            "render": {
                "mode": "hydrate",
                "outcome": "hydrated",
                "recoverableErrorCount": 0,
                "fallbackCount": 0,
            },
        }))

        self.assertEqual(event["requestId"], "7dc42790-a91c-7d62-9d5d-a08bb5211141")
        self.assertEqual(event["metrics"]["LCP"], 510)
        self.assertEqual(event["render"]["outcome"], "hydrated")

    def test_rejects_out_of_range_frame_ratio(self):
        with self.assertRaisesRegex(ValueError, "PERFORMANCE_EVENT_INVALID"):
            decode_event(json.dumps({
                "schemaVersion": 2,
                "eventType": "PerformanceObserved",
                "requestId": "7dc42790-a91c-7d62-9d5d-a08bb5211141",
                "route": "/evidence",
                "version": "v2",
                "observedAt": "2026-08-27T08:00:00.000Z",
                "metrics": {"LCP": 510, "DROPPED_FRAME_RATIO": 1.1},
                "render": {
                    "mode": "hydrate",
                    "outcome": "hydrated",
                    "recoverableErrorCount": 0,
                    "fallbackCount": 0,
                },
            }))

    def test_rejects_unknown_event_fields(self):
        with self.assertRaisesRegex(ValueError, "PERFORMANCE_EVENT_INVALID"):
            decode_event(json.dumps({
                "schemaVersion": 1,
                "eventType": "PerformanceObserved",
                "requestId": "7dc42790-a91c-4d62-9d5d-a08bb5211141",
                "route": "/evidence",
                "version": "v1",
                "observedAt": "2026-08-20T18:00:00.000Z",
                "metrics": {"LCP": 510},
                "identity": "not-allowed",
            }))

    def test_single_sample_populates_all_lcp_percentiles(self):
        self.assertEqual(percentile_summary([510.0]), {
            "p50": 510.0,
            "p75": 510.0,
            "p95": 510.0,
        })


if __name__ == "__main__":
    unittest.main()
