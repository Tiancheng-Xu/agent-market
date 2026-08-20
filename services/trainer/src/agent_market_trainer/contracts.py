from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Final
from uuid import UUID

FEATURE_ORDER: Final[tuple[str, ...]] = (
    "capability_score",
    "reliability_score",
    "price_score",
)
EXPECTED_FIELDS: Final[set[str]] = {
    "sample_id",
    "request_id",
    *FEATURE_ORDER,
    "selected",
}


@dataclass(frozen=True)
class TrainingSample:
    sample_id: str
    request_id: UUID
    capability_score: float
    reliability_score: float
    price_score: float
    selected: int

    @property
    def features(self) -> list[float]:
        return [getattr(self, name) for name in FEATURE_ORDER]


def _parse_sample(payload: object, line_number: int) -> TrainingSample:
    if not isinstance(payload, dict) or set(payload) != EXPECTED_FIELDS:
        raise ValueError(f"invalid-fields:line-{line_number}")

    sample_id = payload["sample_id"]
    if not isinstance(sample_id, str) or not sample_id.strip():
        raise ValueError(f"invalid-sample-id:line-{line_number}")

    try:
        request_id = UUID(str(payload["request_id"]))
    except (TypeError, ValueError) as error:
        raise ValueError(f"invalid-request-id:line-{line_number}") from error

    values: list[float] = []
    for feature in FEATURE_ORDER:
        value = payload[feature]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"invalid-feature:{feature}:line-{line_number}")
        numeric = float(value)
        if not math.isfinite(numeric):
            raise ValueError(f"non-finite-feature:{feature}:line-{line_number}")
        values.append(numeric)

    selected = payload["selected"]
    if isinstance(selected, bool):
        selected = int(selected)
    if selected not in (0, 1):
        raise ValueError(f"invalid-label:line-{line_number}")

    return TrainingSample(
        sample_id=sample_id,
        request_id=request_id,
        capability_score=values[0],
        reliability_score=values[1],
        price_score=values[2],
        selected=selected,
    )


def load_samples(path: Path) -> list[TrainingSample]:
    samples: list[TrainingSample] = []
    sample_ids: set[str] = set()

    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        sample = _parse_sample(json.loads(line), line_number)
        if sample.sample_id in sample_ids:
            raise ValueError(f"duplicate-sample-id:{sample.sample_id}")
        sample_ids.add(sample.sample_id)
        samples.append(sample)

    if not samples:
        raise ValueError("empty-training-set")
    if len({sample.selected for sample in samples}) != 2:
        raise ValueError("single-label-training-set")
    return samples
