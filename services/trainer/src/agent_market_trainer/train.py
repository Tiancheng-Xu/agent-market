from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, log_loss

from .contracts import FEATURE_ORDER, load_samples


def train_model(input_path: Path, output_path: Path, training_run_id: str) -> dict[str, Any]:
    if not training_run_id.strip():
        raise ValueError("training-run-id-required")

    samples = load_samples(input_path)
    features = [sample.features for sample in samples]
    labels = [sample.selected for sample in samples]
    model = LogisticRegression(random_state=42, solver="liblinear")
    model.fit(features, labels)
    probabilities = model.predict_proba(features)[:, 1]
    predictions = model.predict(features)

    result: dict[str, Any] = {
        "schema_version": "ctr-model.v1",
        "training_run_id": training_run_id,
        "algorithm": "logistic-regression",
        "feature_order": list(FEATURE_ORDER),
        "coefficients": [float(value) for value in model.coef_[0]],
        "intercept": float(model.intercept_[0]),
        "sample_count": len(samples),
        "metrics": {
            "accuracy": float(accuracy_score(labels, predictions)),
            "log_loss": float(log_loss(labels, probabilities)),
        },
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Train one Agent Market CTR model")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--training-run-id", required=True)
    args = parser.parse_args()
    train_model(args.input, args.output, args.training_run_id)


if __name__ == "__main__":
    main()
