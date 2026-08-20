import json
from pathlib import Path

import pytest

from agent_market_trainer.contracts import load_samples
from agent_market_trainer.train import train_model

FIXTURE = Path(__file__).parents[1] / "fixtures" / "training-samples.jsonl"


def test_train_emits_versioned_model_without_personal_data(tmp_path: Path) -> None:
    output = tmp_path / "model.json"
    result = train_model(FIXTURE, output, training_run_id="run-test-001")

    assert result["algorithm"] == "logistic-regression"
    assert result["sample_count"] == 6
    assert result["feature_order"] == [
        "capability_score",
        "reliability_score",
        "price_score",
    ]
    serialized = output.read_text(encoding="utf-8")
    assert "request_id" not in serialized
    assert "sample_id" not in serialized


def test_rejects_duplicate_samples(tmp_path: Path) -> None:
    first = FIXTURE.read_text(encoding="utf-8").splitlines()[0]
    duplicate = tmp_path / "duplicate.jsonl"
    duplicate.write_text(f"{first}\n{first}\n", encoding="utf-8")

    with pytest.raises(ValueError, match="duplicate-sample-id"):
        load_samples(duplicate)


def test_rejects_single_label_data(tmp_path: Path) -> None:
    records = [json.loads(line) for line in FIXTURE.read_text(encoding="utf-8").splitlines()]
    for record in records:
        record["selected"] = 1
    path = tmp_path / "single-label.jsonl"
    path.write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")

    with pytest.raises(ValueError, match="single-label-training-set"):
        load_samples(path)
