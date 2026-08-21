import hashlib
import json
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
from pathlib import Path

import pytest

from agent_market_trainer import model_store
from agent_market_trainer import train as trainer


FIXTURE = Path(__file__).parents[1] / "fixtures" / "training-samples.jsonl"
RUN_ID = "018f3f50-7b2d-7cc1-98f5-9ab68e75b001"
DECISION_EVENT_ID = "018f3f50-7b2d-7cc1-98f5-9ab68e75b020"
REVIEWER_EVENT_ID = "018f3f50-7b2d-7cc1-98f5-9ab68e75b021"


def _register_worker(registry: str, version: str, artifact: str) -> str:
    return model_store.FileModelStore(Path(registry)).register(version, Path(artifact)).status


def _activate_worker(registry: str, version: str) -> str:
    return model_store.FileModelStore(Path(registry)).activate(version).status


def _write_approved_artifact(path: Path, run_id: str = RUN_ID) -> trainer.ModelArtifact:
    candidate = trainer.train_model(FIXTURE, path.with_suffix(".candidate.json"), run_id)
    approved = trainer.decide_candidate(
        candidate, "approved", DECISION_EVENT_ID, REVIEWER_EVENT_ID, "gate-recommendation-accepted"
    )
    trainer.write_immutable_artifact(path, trainer.artifact_bytes(approved))
    return approved


def test_registry_requires_explicit_activation_and_returns_active_handle(tmp_path: Path) -> None:
    artifact = trainer.train_model(FIXTURE, tmp_path / "model.json", RUN_ID)
    store = model_store.FileModelStore(tmp_path / "registry.json")
    assert store.register("ctr-v4", tmp_path / "model.json").status == "candidate"
    with pytest.raises(ValueError, match="active-model-not-found"):
        store.load_active()
    with pytest.raises(ValueError, match="model-not-approved"):
        store.activate("ctr-v4")
    decided = store.decide(
        "ctr-v4", "approved", DECISION_EVENT_ID, REVIEWER_EVENT_ID, "gate-recommendation-accepted"
    )
    assert decided.status == "approved"
    assert store.activate("ctr-v4").status == "active"
    active = store.load_active()
    assert isinstance(active, trainer.ActiveModel)
    assert active.version == "ctr-v4"
    assert active.model_hash != artifact.model_hash
    assert 0 <= trainer.predict_probability(active, [0.5, 0.5, 0.5]) <= 1


def test_registry_refuses_to_activate_a_rejected_model(tmp_path: Path) -> None:
    records = [json.loads(line) for line in FIXTURE.read_text(encoding="utf-8").splitlines()]
    for record in records:
        digest = hashlib.sha256(str(record["exposure_id"]).encode("ascii")).digest()
        record["clicked"] = int(digest[0] < 128)
    path = tmp_path / "no-signal.jsonl"
    path.write_text("\n".join(json.dumps(record) for record in records) + "\n", encoding="utf-8")
    artifact = trainer.train_model(path, tmp_path / "rejected.json", "018f3f50-7b2d-7cc1-98f5-9ab68e75b002")
    assert artifact.status == "candidate"
    assert artifact.gate_recommendation == "reject"
    store = model_store.FileModelStore(tmp_path / "registry.json")
    store.register("ctr-rejected", tmp_path / "rejected.json")
    with pytest.raises(ValueError, match="model-not-approved"):
        store.activate("ctr-rejected")
    rejected = store.decide(
        "ctr-rejected", "rejected", DECISION_EVENT_ID, REVIEWER_EVENT_ID, "gate-recommendation-accepted"
    )
    assert rejected.status == "rejected"
    with pytest.raises(ValueError, match="model-not-approved"):
        store.activate("ctr-rejected")
    with pytest.raises(ValueError, match="active-model-not-found"):
        store.load_active()


def test_registry_retires_previous_active_model(tmp_path: Path) -> None:
    _write_approved_artifact(tmp_path / "model.json")
    store = model_store.FileModelStore(tmp_path / "registry.json")
    store.register("ctr-a", tmp_path / "model.json")
    store.register("ctr-b", tmp_path / "model.json")
    store.activate("ctr-a")
    previous = store.load_active()
    store.activate("ctr-b")
    models = store.list_models()
    assert models["ctr-a"].status == "retired"
    assert models["ctr-b"].status == "active"
    assert store.load_active().version == "ctr-b"
    with pytest.raises(ValueError, match="active-model-required"):
        trainer.predict_probability(previous, [0.5, 0.5, 0.5])


def test_active_handle_fails_closed_after_registry_corruption(tmp_path: Path) -> None:
    artifact_path = tmp_path / "model.json"
    _write_approved_artifact(artifact_path)
    registry = tmp_path / "registry.json"
    store = model_store.FileModelStore(registry)
    store.register("ctr-v4", artifact_path)
    store.activate("ctr-v4")
    active = store.load_active()
    registry.write_text('{"schema_version":"model-registry.v2","active_epoch":1,"models":{},"models":{}}', encoding="utf-8")
    with pytest.raises(ValueError, match="active-model-required"):
        trainer.predict_probability(active, [0.5, 0.5, 0.5])


def test_active_handle_fails_closed_after_managed_artifact_replacement(tmp_path: Path) -> None:
    artifact_path = tmp_path / "model.json"
    _write_approved_artifact(artifact_path)
    registry = tmp_path / "registry.json"
    store = model_store.FileModelStore(registry)
    stored = store.register("ctr-v4", artifact_path)
    store.activate("ctr-v4")
    active = store.load_active()
    (registry.parent / stored.artifact_path).write_text("{}\n", encoding="utf-8")
    with pytest.raises(ValueError, match="active-model-required"):
        trainer.predict_probability(active, [0.5, 0.5, 0.5])


def test_registry_rejects_corrupt_and_duplicate_key_json(tmp_path: Path) -> None:
    artifact = trainer.train_model(FIXTURE, tmp_path / "model.json", RUN_ID)
    registry = tmp_path / "registry.json"
    store = model_store.FileModelStore(registry)
    registry.write_text('{"schema_version":"model-registry.v1","models":{},"models":{}}', encoding="utf-8")
    with pytest.raises(ValueError, match="model-registry-invalid"):
        store.list_models()
    registry.write_text(json.dumps({"schema_version": "model-registry.v1", "models": {"bad": {
        "model_hash": artifact.model_hash, "artifact_schema_version": artifact.schema_version, "status": [],
    }}}), encoding="utf-8")
    with pytest.raises(ValueError, match="model-registry-invalid"):
        store.list_models()


def test_registry_concurrent_registration_preserves_every_model(tmp_path: Path) -> None:
    artifact_path = tmp_path / "model.json"
    _write_approved_artifact(artifact_path)
    registry = tmp_path / "registry.json"
    store = model_store.FileModelStore(registry)
    versions = [f"ctr-{index:02d}" for index in range(8)]
    context = get_context("spawn")
    with ProcessPoolExecutor(max_workers=4, mp_context=context) as executor:
        statuses = list(executor.map(_register_worker, [str(registry)] * len(versions), versions,
                                     [str(artifact_path)] * len(versions)))
    assert statuses == ["approved"] * len(versions)
    assert set(store.list_models()) == set(versions)
    with ProcessPoolExecutor(max_workers=4, mp_context=context) as executor:
        activated = list(executor.map(_activate_worker, [str(registry)] * len(versions), versions))
    assert activated == ["active"] * len(versions)
    models = store.list_models()
    assert sum(model.status == "active" for model in models.values()) == 1
    assert store.load_active().version in versions


def test_registry_fails_closed_for_missing_replaced_and_traversal_artifacts(tmp_path: Path) -> None:
    source = tmp_path / "model.json"
    artifact = _write_approved_artifact(source)
    registry = tmp_path / "registry.json"
    store = model_store.FileModelStore(registry)
    stored = store.register("ctr-v4", source)
    managed = registry.parent / stored.artifact_path
    managed.unlink()
    with pytest.raises(ValueError, match="model-artifact-invalid"):
        store.activate("ctr-v4")
    store.register("ctr-v4", source)
    replacement = tmp_path / "replacement.json"
    _write_approved_artifact(replacement, "018f3f50-7b2d-7cc1-98f5-9ab68e75b099")
    managed.write_bytes(replacement.read_bytes())
    with pytest.raises(ValueError, match="model-artifact-invalid"):
        store.activate("ctr-v4")
    managed.write_bytes(source.read_bytes())
    payload = json.loads(registry.read_text(encoding="utf-8"))
    payload["models"]["ctr-v4"]["artifact_path"] = "../outside.json"
    registry.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(ValueError, match="model-registry-invalid"):
        store.list_models()
    assert artifact.status == "approved"


def test_registry_decision_replay_is_idempotent_and_conflicts_fail(tmp_path: Path) -> None:
    candidate_path = tmp_path / "candidate.json"
    trainer.train_model(FIXTURE, candidate_path, RUN_ID)
    store = model_store.FileModelStore(tmp_path / "registry.json")
    store.register("ctr-v5", candidate_path)
    first = store.decide(
        "ctr-v5", "approved", DECISION_EVENT_ID, REVIEWER_EVENT_ID, "gate-recommendation-accepted"
    )
    repeated = store.decide(
        "ctr-v5", "approved", DECISION_EVENT_ID, REVIEWER_EVENT_ID, "gate-recommendation-accepted"
    )
    assert repeated == first
    with pytest.raises(ValueError, match="model-decision-conflict"):
        store.decide(
            "ctr-v5", "rejected", "018f3f50-7b2d-7cc1-98f5-9ab68e75b022",
            REVIEWER_EVENT_ID, "policy-review-rejected",
        )
