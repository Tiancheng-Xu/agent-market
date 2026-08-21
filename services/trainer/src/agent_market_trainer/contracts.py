from __future__ import annotations

import json
import math
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Final
from uuid import UUID


FEATURE_ORDER: Final[tuple[str, ...]] = (
    "capability_confidence",
    "reliability_rate",
    "price_fit",
)
EXPECTED_FIELDS: Final[set[str]] = {
    "exposure_id",
    "request_id",
    "exposed_at",
    *FEATURE_ORDER,
    "clicked",
}
MIN_TOTAL_SAMPLES: Final = 120
MIN_SAMPLES_PER_CLASS: Final = 40
MIN_UNIQUE_REQUESTS: Final = 80
MIN_REQUESTS_PER_CLASS: Final = 30
MAX_REQUEST_SHARE: Final = 0.05
_FORBIDDEN_FIELD_FRAGMENTS: Final = ("selected", "rank", "score")


@dataclass(frozen=True)
class TrainingSample:
    exposure_id: UUID
    request_id: UUID
    exposed_at: datetime
    capability_confidence: float
    reliability_rate: float
    price_fit: float
    clicked: int

    @property
    def features(self) -> list[float]:
        return [getattr(self, name) for name in FEATURE_ORDER]


def canonical_uuid7(value: object, error_code: str) -> UUID:
    if not isinstance(value, str):
        raise ValueError(error_code)
    try:
        parsed = UUID(value)
    except (AttributeError, TypeError, ValueError) as error:
        raise ValueError(error_code) from error
    if parsed.int == 0 or parsed.version != 7 or str(parsed) != value:
        raise ValueError(error_code)
    return parsed


def _parse_exposed_at(value: object, line_number: int) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError(f"invalid-exposed-at:line-{line_number}")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ValueError(f"invalid-exposed-at:line-{line_number}") from error
    canonical = parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if parsed.tzinfo is None or parsed.microsecond != 0 or canonical != value:
        raise ValueError(f"invalid-exposed-at:line-{line_number}")
    return parsed


def _parse_sample(payload: object, line_number: int) -> TrainingSample:
    if not isinstance(payload, dict):
        raise ValueError(f"invalid-fields:line-{line_number}")
    unknown = set(payload) - EXPECTED_FIELDS
    if any(fragment in str(field).lower() for field in unknown for fragment in _FORBIDDEN_FIELD_FRAGMENTS):
        raise ValueError(f"leakage-field-forbidden:line-{line_number}")
    if set(payload) != EXPECTED_FIELDS:
        raise ValueError(f"invalid-fields:line-{line_number}")

    try:
        exposure_id = canonical_uuid7(payload["exposure_id"], f"invalid-exposure-id:line-{line_number}")
        request_id = canonical_uuid7(payload["request_id"], f"invalid-request-id:line-{line_number}")
    except ValueError:
        raise

    values: list[float] = []
    for feature in FEATURE_ORDER:
        try:
            values.append(normalize_feature_value(payload[feature]))
        except ValueError as error:
            raise ValueError(f"invalid-feature:{feature}:line-{line_number}") from error

    clicked = payload["clicked"]
    if isinstance(clicked, bool) or clicked not in (0, 1):
        raise ValueError(f"invalid-clicked-outcome:line-{line_number}")

    return TrainingSample(
        exposure_id=exposure_id,
        request_id=request_id,
        exposed_at=_parse_exposed_at(payload["exposed_at"], line_number),
        capability_confidence=values[0],
        reliability_rate=values[1],
        price_fit=values[2],
        clicked=clicked,
    )


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate-json-key")
        result[key] = value
    return result


def load_samples(path: Path) -> list[TrainingSample]:
    samples: list[TrainingSample] = []
    exposure_ids: set[UUID] = set()

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise ValueError("training-file-invalid") from error
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            payload = json.loads(line, object_pairs_hook=_reject_duplicate_keys)
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
            raise ValueError(f"invalid-json:line-{line_number}") from error
        sample = _parse_sample(payload, line_number)
        if sample.exposure_id in exposure_ids:
            raise ValueError(f"duplicate-exposure-id:line-{line_number}")
        exposure_ids.add(sample.exposure_id)
        samples.append(sample)

    if not samples:
        raise ValueError("empty-training-set")
    if len(samples) < MIN_TOTAL_SAMPLES:
        raise ValueError(f"training-set-too-small:{len(samples)}")

    labels = Counter(sample.clicked for sample in samples)
    if len(labels) != 2:
        raise ValueError("single-label-training-set")
    if min(labels.values()) < MIN_SAMPLES_PER_CLASS:
        raise ValueError("training-class-too-small")

    request_counts = Counter(sample.request_id for sample in samples)
    if len(request_counts) < MIN_UNIQUE_REQUESTS:
        raise ValueError("independent-request-count-too-small")
    if max(request_counts.values()) / len(samples) > MAX_REQUEST_SHARE:
        raise ValueError("request-group-too-large")
    for label in (0, 1):
        request_count = len({sample.request_id for sample in samples if sample.clicked == label})
        if request_count < MIN_REQUESTS_PER_CLASS:
            raise ValueError(f"class-request-count-too-small:{label}")
    return samples


def normalize_feature_value(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("feature-value-invalid")
    numeric = float(value)
    if not math.isfinite(numeric) or not 0 <= numeric <= 1:
        raise ValueError("feature-value-invalid")
    return numeric
