import copy
import hashlib
import json
import os
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor
from dataclasses import replace
from datetime import timedelta
from multiprocessing import get_context
from pathlib import Path

import pytest
from sklearn.ensemble import HistGradientBoostingClassifier

from agent_market_trainer import contracts
from agent_market_trainer import model_store
from agent_market_trainer import train as trainer


FIXTURE = Path(__file__).parents[1] / "fixtures" / "training-samples.jsonl"
RUN_ID = "018f3f50-7b2d-7cc1-98f5-9ab68e75b001"
DECISION_EVENT_ID = "018f3f50-7b2d-7cc1-98f5-9ab68e75b010"
REVIEWER_EVENT_ID = "018f3f50-7b2d-7cc1-98f5-9ab68e75b011"


def _train_worker(input_path: str, output_path: str, run_id: str) -> str:
    return trainer.train_model(Path(input_path), Path(output_path), run_id).model_hash


def _records() -> list[dict[str, object]]:
    return [json.loads(line) for line in FIXTURE.read_text(encoding="utf-8").splitlines()]


def _write_records(path: Path, records: list[dict[str, object]]) -> None:
    path.write_text("\n".join(json.dumps(record, sort_keys=True) for record in records) + "\n", encoding="utf-8")


def _recompute_hash(payload: dict[str, object]) -> str:
    body = copy.deepcopy({key: value for key, value in payload.items() if key != "model_hash"})
    return hashlib.sha256(
        json.dumps(body, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("utf-8")
    ).hexdigest()


def test_fixture_is_large_noisy_exposure_outcome_data() -> None:
    samples = contracts.load_samples(FIXTURE)
    assert len(samples) >= 100
    assert {sample.clicked for sample in samples} == {0, 1}
    assert len({sample.request_id for sample in samples}) >= 100
    for feature in contracts.FEATURE_ORDER:
        positives = [getattr(sample, feature) for sample in samples if sample.clicked]
        negatives = [getattr(sample, feature) for sample in samples if not sample.clicked]
        assert min(positives) < max(negatives)
        assert min(negatives) < max(positives)


def test_train_emits_candidate_with_gate_recommendation_without_auto_approval(tmp_path: Path) -> None:
    output = tmp_path / "model.json"
    result = trainer.train_model(FIXTURE, output, training_run_id=RUN_ID)
    assert result.schema_version == trainer.ARTIFACT_SCHEMA_VERSION
    assert result.algorithm == "hist-gradient-boosting-classifier"
    assert result.status == "candidate"
    assert result.gate_recommendation == "approve"
    assert result.decision_audit is None
    assert result.metrics.oof_roc_auc >= 0.60
    assert result.metrics.oof_log_loss < result.metrics.oof_baseline_log_loss
    assert result.metrics.temporal_roc_auc >= 0.60
    assert result.metrics.temporal_log_loss < result.metrics.temporal_baseline_log_loss
    assert result.metrics.oof_auc_lower_bound >= 0.60
    assert result.metrics.temporal_auc_lower_bound >= 0.60
    assert result.metrics.oof_log_loss_gain_lower_bound > 0
    assert result.metrics.temporal_log_loss_gain_lower_bound > 0
    assert result.metrics.fold_count == trainer.CV_FOLDS
    assert result.metrics.temporal_sample_count >= trainer.MIN_TEMPORAL_SAMPLES
    assert len(result.model_hash) == 64
    serialized = output.read_text(encoding="utf-8")
    for forbidden in ("pickle", "joblib", "request_id", "exposure_id", "wallet", "selected", "rank"):
        assert forbidden not in serialized.lower()
    assert trainer.artifact_from_dict(json.loads(serialized)) == result


def test_explicit_decision_records_audit_and_rehashes_the_complete_artifact(tmp_path: Path) -> None:
    candidate = trainer.train_model(FIXTURE, tmp_path / "candidate.json", RUN_ID)
    approved = trainer.decide_candidate(
        candidate, "approved", DECISION_EVENT_ID, REVIEWER_EVENT_ID, "gate-recommendation-accepted"
    )
    assert candidate.status == "candidate"
    assert candidate.decision_audit is None
    assert approved.status == "approved"
    assert approved.gate_recommendation == "approve"
    assert approved.decision_audit is not None
    assert approved.decision_audit.to_dict() == {
        "decision_event_id": DECISION_EVENT_ID,
        "outcome": "approved",
        "reason_code": "gate-recommendation-accepted",
        "reviewer_event_id": REVIEWER_EVENT_ID,
    }
    assert approved.model_hash != candidate.model_hash
    assert trainer.artifact_from_dict(approved.to_dict()) == approved


def test_decision_is_idempotent_but_conflicting_or_invalid_transitions_fail(tmp_path: Path) -> None:
    candidate = trainer.train_model(FIXTURE, tmp_path / "candidate.json", RUN_ID)
    approved = trainer.decide_candidate(
        candidate, "approved", DECISION_EVENT_ID, REVIEWER_EVENT_ID, "gate-recommendation-accepted"
    )
    assert trainer.decide_candidate(
        approved, "approved", DECISION_EVENT_ID, REVIEWER_EVENT_ID, "gate-recommendation-accepted"
    ) == approved
    with pytest.raises(ValueError, match="model-decision-conflict"):
        trainer.decide_candidate(
            approved, "rejected", "018f3f50-7b2d-7cc1-98f5-9ab68e75b012",
            REVIEWER_EVENT_ID, "policy-review-rejected",
        )
    with pytest.raises(ValueError, match="model-decision-invalid"):
        trainer.decide_candidate(candidate, "active", DECISION_EVENT_ID, REVIEWER_EVENT_ID,
                                 "gate-recommendation-accepted")
    with pytest.raises(ValueError, match="decision-reason-invalid"):
        trainer.decide_candidate(candidate, "approved", DECISION_EVENT_ID, REVIEWER_EVENT_ID, "free-form")
    with pytest.raises(ValueError, match="decision-audit-invalid"):
        trainer.decide_candidate(candidate, "approved", DECISION_EVENT_ID, DECISION_EVENT_ID,
                                 "gate-recommendation-accepted")


def test_safe_json_predictor_matches_sklearn_on_fixture_and_boundaries(tmp_path: Path) -> None:
    artifact_path = tmp_path / "model.json"
    artifact = trainer.train_model(FIXTURE, artifact_path, RUN_ID)
    store = model_store.FileModelStore(tmp_path / "registry.json")
    store.register("ctr-hgb-v1", artifact_path)
    store.decide("ctr-hgb-v1", "approved", DECISION_EVENT_ID, REVIEWER_EVENT_ID,
                 "gate-recommendation-accepted")
    store.activate("ctr-hgb-v1")
    active = store.load_active()
    samples = contracts.load_samples(FIXTURE)
    sklearn_model = HistGradientBoostingClassifier(**artifact.hyperparameters)
    sklearn_model.fit([sample.features for sample in samples], [sample.clicked for sample in samples])
    vectors = [sample.features for sample in samples] + [
        [0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0.0, 1.0, 0.5], [1.0, 0.0, 0.5],
    ]
    expected = sklearn_model.predict_proba(vectors)[:, 1]
    actual = [trainer.predict_probability(active, vector) for vector in vectors]
    assert actual == pytest.approx(expected, abs=1e-12, rel=1e-12)


@pytest.mark.parametrize("invalid", [True, "0.2", float("nan"), float("inf"), -0.01, 1.01])
def test_predictor_reuses_strict_training_feature_contract(tmp_path: Path, invalid: object) -> None:
    artifact_path = tmp_path / "model.json"
    trainer.train_model(FIXTURE, artifact_path, RUN_ID)
    store = model_store.FileModelStore(tmp_path / "registry.json")
    store.register("ctr-hgb-v1", artifact_path)
    store.decide("ctr-hgb-v1", "approved", DECISION_EVENT_ID, REVIEWER_EVENT_ID,
                 "gate-recommendation-accepted")
    store.activate("ctr-hgb-v1")
    active = store.load_active()
    with pytest.raises(ValueError, match="prediction-feature-invalid"):
        trainer.predict_probability(active, [0.5, invalid, 0.5])


def test_predictor_rejects_artifacts_unactivated_models_and_forged_handles(tmp_path: Path) -> None:
    assert not hasattr(trainer, "_issue_active_model")
    artifact_path = tmp_path / "model.json"
    artifact = trainer.train_model(FIXTURE, artifact_path, RUN_ID)
    with pytest.raises(ValueError, match="active-model-required"):
        trainer.predict_probability(artifact, [0.5, 0.5, 0.5])
    store = model_store.FileModelStore(tmp_path / "registry.json")
    store.register("ctr-hgb-v1", artifact_path)
    store.decide("ctr-hgb-v1", "approved", DECISION_EVENT_ID, REVIEWER_EVENT_ID,
                 "gate-recommendation-accepted")
    with pytest.raises(ValueError, match="active-model-required"):
        trainer.predict_probability(artifact, [0.5, 0.5, 0.5])
    active_type = getattr(trainer, "ActiveModel")
    forged = object.__new__(active_type)
    with pytest.raises(ValueError, match="active-model-required"):
        trainer.predict_probability(forged, [0.5, 0.5, 0.5])
    with pytest.raises(TypeError, match="registry"):
        active_type()


def test_full_artifact_is_deterministic_for_same_data_regardless_of_row_order(tmp_path: Path) -> None:
    shuffled = tmp_path / "shuffled.jsonl"
    _write_records(shuffled, list(reversed(_records())))
    first_path = tmp_path / "first.json"
    second_path = tmp_path / "second.json"
    first = trainer.train_model(FIXTURE, first_path, RUN_ID)
    second = trainer.train_model(shuffled, second_path, RUN_ID)
    assert first.model_hash == second.model_hash
    assert first_path.read_bytes() == second_path.read_bytes()


def test_concurrent_same_artifact_write_is_idempotent_and_conflict_does_not_overwrite(tmp_path: Path) -> None:
    output = tmp_path / "model.json"
    context = get_context("spawn")
    with ProcessPoolExecutor(max_workers=3, mp_context=context) as executor:
        hashes = list(executor.map(_train_worker, [str(FIXTURE)] * 3, [str(output)] * 3, [RUN_ID] * 3))
    assert len(set(hashes)) == 1
    original = output.read_bytes()
    with pytest.raises(ValueError, match="artifact-output-conflict"):
        trainer.train_model(FIXTURE, output, "018f3f50-7b2d-7cc1-98f5-9ab68e75b099")
    assert output.read_bytes() == original


def test_artifact_hash_binds_metrics_status_and_tree_data(tmp_path: Path) -> None:
    artifact = trainer.train_model(FIXTURE, tmp_path / "model.json", RUN_ID)
    for mutator in (
        lambda payload: payload["metrics"].__setitem__("oof_roc_auc", 0.0),
        lambda payload: payload.__setitem__("status", "rejected"),
        lambda payload: payload["model_data"]["trees"][0]["nodes"][0].__setitem__("value", 999.0),
    ):
        payload = artifact.to_dict()
        mutator(payload)
        with pytest.raises(
            ValueError,
            match="artifact-hash-mismatch|artifact-gate-recommendation-invalid|artifact-decision-invalid",
        ):
            trainer.artifact_from_dict(payload)


def test_tree_schema_rejects_boolean_indices_even_with_recomputed_hash(tmp_path: Path) -> None:
    artifact = trainer.train_model(FIXTURE, tmp_path / "model.json", RUN_ID)
    payload = artifact.to_dict()
    payload["model_data"]["trees"][0]["nodes"][0]["feature_index"] = True
    payload["model_hash"] = _recompute_hash(payload)
    with pytest.raises(ValueError, match="artifact-model-data-invalid"):
        trainer.artifact_from_dict(payload)


def test_grouped_oof_never_splits_one_request_across_folds(tmp_path: Path) -> None:
    records = _records()
    for index in range(20):
        records[index + 20]["request_id"] = records[index]["request_id"]
    grouped = tmp_path / "grouped.jsonl"
    _write_records(grouped, records)
    samples = contracts.load_samples(grouped)
    train_indices, temporal_indices = trainer.temporal_holdout_indices(samples)
    folds = trainer.grouped_fold_indices(samples, train_indices)
    assert len(folds) == trainer.CV_FOLDS
    seen_test_indices: set[int] = set()
    for fold_train, fold_test in folds:
        train_requests = {samples[index].request_id for index in fold_train}
        test_requests = {samples[index].request_id for index in fold_test}
        assert train_requests.isdisjoint(test_requests)
        assert min(sum(samples[index].clicked == label for index in fold_test) for label in (0, 1)) >= trainer.MIN_FOLD_CLASS_SAMPLES
        seen_test_indices.update(fold_test)
    assert seen_test_indices == set(train_indices)
    assert {samples[index].request_id for index in train_indices}.isdisjoint(
        {samples[index].request_id for index in temporal_indices}
    )


def test_temporal_holdout_contains_latest_request_groups(tmp_path: Path) -> None:
    samples = contracts.load_samples(FIXTURE)
    train_indices, holdout_indices = trainer.temporal_holdout_indices(samples)
    assert max(samples[index].exposed_at for index in train_indices) < min(
        samples[index].exposed_at for index in holdout_indices
    )
    assert len(holdout_indices) >= trainer.MIN_TEMPORAL_SAMPLES
    assert min(sum(samples[index].clicked == label for index in holdout_indices) for label in (0, 1)) >= trainer.MIN_TEMPORAL_CLASS_SAMPLES


def test_temporal_holdout_keeps_high_throughput_second_buckets_whole() -> None:
    samples = contracts.load_samples(FIXTURE)
    grouped: dict[object, list[int]] = {}
    for index, sample in enumerate(samples):
        grouped.setdefault(sample.request_id, []).append(index)
    ordered_groups = sorted(
        grouped,
        key=lambda group: (min(samples[index].exposed_at for index in grouped[group]), group.bytes),
    )
    bucketed = list(samples)
    start = min(sample.exposed_at for sample in samples)
    for group_index, group in enumerate(ordered_groups):
        timestamp = start + timedelta(seconds=group_index // 30)
        for sample_index in grouped[group]:
            bucketed[sample_index] = replace(bucketed[sample_index], exposed_at=timestamp)

    train_indices, holdout_indices = trainer.temporal_holdout_indices(bucketed)
    train_times = {bucketed[index].exposed_at for index in train_indices}
    holdout_times = {bucketed[index].exposed_at for index in holdout_indices}
    assert train_times.isdisjoint(holdout_times)
    assert max(train_times) < min(holdout_times)
    assert len({bucketed[index].request_id for index in holdout_indices}) >= trainer.MIN_TEMPORAL_GROUPS

    valid_distances = []
    for cutoff in sorted({sample.exposed_at for sample in bucketed})[1:]:
        candidate = [index for index, sample in enumerate(bucketed) if sample.exposed_at >= cutoff]
        candidate_groups = {bucketed[index].request_id for index in candidate}
        if (
            len(candidate) >= trainer.MIN_TEMPORAL_SAMPLES
            and len(candidate_groups) >= trainer.MIN_TEMPORAL_GROUPS
            and min(sum(bucketed[index].clicked == label for index in candidate) for label in (0, 1))
            >= trainer.MIN_TEMPORAL_CLASS_SAMPLES
        ):
            valid_distances.append(abs(len(candidate) / len(bucketed) - trainer.TEMPORAL_HOLDOUT_FRACTION))
    actual_distance = abs(len(holdout_indices) / len(bucketed) - trainer.TEMPORAL_HOLDOUT_FRACTION)
    assert actual_distance == pytest.approx(min(valid_distances))


def test_rejects_policy_leakage_fields(tmp_path: Path) -> None:
    for field, value in (("selected", 1), ("rank", 1), ("quality_score", 0.9)):
        records = _records()
        records[0][field] = value
        path = tmp_path / f"leak-{field}.jsonl"
        _write_records(path, records)
        with pytest.raises(ValueError, match="leakage-field-forbidden"):
            contracts.load_samples(path)


def test_rejects_small_class_sparse_and_temporal_sparse_training_sets(tmp_path: Path) -> None:
    records = _records()
    small = tmp_path / "small.jsonl"
    _write_records(small, records[:99])
    with pytest.raises(ValueError, match="training-set-too-small"):
        contracts.load_samples(small)
    sparse = copy.deepcopy(records)
    for index, record in enumerate(sparse):
        record["clicked"] = 1 if index < contracts.MIN_SAMPLES_PER_CLASS - 1 else 0
    sparse_path = tmp_path / "class-sparse.jsonl"
    _write_records(sparse_path, sparse)
    with pytest.raises(ValueError, match="training-class-too-small"):
        contracts.load_samples(sparse_path)
    temporal_sparse = copy.deepcopy(records)
    temporal_sparse.sort(key=lambda record: str(record["exposed_at"]))
    earliest = temporal_sparse[0]["exposed_at"]
    for index, record in enumerate(temporal_sparse):
        record["clicked"] = int(index < contracts.MIN_SAMPLES_PER_CLASS)
        if index < contracts.MIN_SAMPLES_PER_CLASS:
            record["exposed_at"] = earliest
    temporal_path = tmp_path / "temporal-sparse.jsonl"
    _write_records(temporal_path, temporal_sparse)
    samples = contracts.load_samples(temporal_path)
    with pytest.raises(ValueError, match="temporal-class-too-small"):
        trainer.temporal_holdout_indices(samples)


def test_rejects_non_uuid7_nil_and_noncanonical_identifiers(tmp_path: Path) -> None:
    for invalid in ("00000000-0000-0000-0000-000000000000", "550e8400-e29b-41d4-a716-446655440000", RUN_ID.upper()):
        records = _records()
        records[0]["request_id"] = invalid
        path = tmp_path / "invalid-id.jsonl"
        _write_records(path, records)
        with pytest.raises(ValueError, match="invalid-request-id"):
            contracts.load_samples(path)
        with pytest.raises(ValueError, match="training-run-id-invalid"):
            trainer.train_model(FIXTURE, tmp_path / "model.json", invalid)


def test_rejects_duplicate_exposure_and_pii_without_echoing_value(tmp_path: Path) -> None:
    records = _records()
    records[1]["exposure_id"] = records[0]["exposure_id"]
    duplicate = tmp_path / "duplicate.jsonl"
    _write_records(duplicate, records)
    with pytest.raises(ValueError, match="duplicate-exposure-id"):
        contracts.load_samples(duplicate)
    records = _records()
    pii_value = "person@example.invalid"
    records[0]["exposure_id"] = pii_value
    pii = tmp_path / "pii.jsonl"
    _write_records(pii, records)
    with pytest.raises(ValueError, match="invalid-exposure-id") as captured:
        contracts.load_samples(pii)
    assert pii_value not in str(captured.value)


def test_module_cli_does_not_preimport_train_module(tmp_path: Path) -> None:
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(Path(__file__).parents[1] / "src")
    completed = subprocess.run(
        [sys.executable, "-m", "agent_market_trainer.train", "--input", str(FIXTURE), "--output",
         str(tmp_path / "model.json"), "--training-run-id", RUN_ID],
        check=False, capture_output=True, env=environment, text=True,
    )
    assert completed.returncode == 0
    assert "RuntimeWarning" not in completed.stderr
    assert json.loads((tmp_path / "model.json").read_text(encoding="utf-8"))["status"] == "candidate"
