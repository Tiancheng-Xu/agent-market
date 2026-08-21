from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import math
import os
import random
import tempfile
from collections import defaultdict
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Final, Literal
from uuid import UUID

from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import log_loss, roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold

from .contracts import (
    FEATURE_ORDER,
    MIN_TOTAL_SAMPLES,
    TrainingSample,
    canonical_uuid7,
    load_samples,
    normalize_feature_value,
)


ARTIFACT_SCHEMA_VERSION: Final = "ctr-model.v5"
MODEL_DATA_SCHEMA_VERSION: Final = "hist-gradient-boosting-json.v1"
ALGORITHM: Final = "hist-gradient-boosting-classifier"
CV_FOLDS: Final = 5
MIN_ROC_AUC: Final = 0.60
MIN_FOLD_CLASS_SAMPLES: Final = 8
TEMPORAL_HOLDOUT_FRACTION: Final = 0.20
MIN_TEMPORAL_SAMPLES: Final = 30
MIN_TEMPORAL_CLASS_SAMPLES: Final = 10
MIN_TEMPORAL_GROUPS: Final = 10
BOOTSTRAP_ITERATIONS: Final = 200
BOOTSTRAP_QUANTILE: Final = 0.05
MODEL_HYPERPARAMETERS: Final[dict[str, object]] = {
    "early_stopping": False,
    "l2_regularization": 0.1,
    "learning_rate": 0.08,
    "loss": "log_loss",
    "max_bins": 255,
    "max_iter": 60,
    "max_leaf_nodes": 15,
    "min_samples_leaf": 10,
    "random_state": 42,
}
ArtifactStatus = Literal["candidate", "approved", "rejected"]
GateRecommendation = Literal["approve", "reject"]
DecisionOutcome = Literal["approved", "rejected"]
DecisionReasonCode = Literal[
    "gate-recommendation-accepted",
    "gate-recommendation-overridden",
    "policy-review-approved",
    "policy-review-rejected",
]
_DECISION_REASON_CODES: Final = {
    "gate-recommendation-accepted",
    "gate-recommendation-overridden",
    "policy-review-approved",
    "policy-review-rejected",
}


@dataclass(frozen=True)
class ModelMetrics:
    oof_roc_auc: float
    oof_log_loss: float
    oof_baseline_log_loss: float
    temporal_roc_auc: float
    temporal_log_loss: float
    temporal_baseline_log_loss: float
    oof_auc_lower_bound: float
    temporal_auc_lower_bound: float
    oof_log_loss_gain_lower_bound: float
    temporal_log_loss_gain_lower_bound: float
    fold_count: int
    temporal_sample_count: int
    bootstrap_iterations: int

    def to_dict(self) -> dict[str, object]:
        return {
            "bootstrap_iterations": self.bootstrap_iterations,
            "fold_count": self.fold_count,
            "oof_auc_lower_bound": self.oof_auc_lower_bound,
            "oof_baseline_log_loss": self.oof_baseline_log_loss,
            "oof_log_loss": self.oof_log_loss,
            "oof_log_loss_gain_lower_bound": self.oof_log_loss_gain_lower_bound,
            "oof_roc_auc": self.oof_roc_auc,
            "temporal_auc_lower_bound": self.temporal_auc_lower_bound,
            "temporal_baseline_log_loss": self.temporal_baseline_log_loss,
            "temporal_log_loss": self.temporal_log_loss,
            "temporal_log_loss_gain_lower_bound": self.temporal_log_loss_gain_lower_bound,
            "temporal_roc_auc": self.temporal_roc_auc,
            "temporal_sample_count": self.temporal_sample_count,
        }


@dataclass(frozen=True)
class TreeNode:
    value: float
    feature_index: int
    threshold: float
    missing_go_to_left: bool
    left: int
    right: int
    is_leaf: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "feature_index": self.feature_index,
            "is_leaf": self.is_leaf,
            "left": self.left,
            "missing_go_to_left": self.missing_go_to_left,
            "right": self.right,
            "threshold": self.threshold,
            "value": self.value,
        }


@dataclass(frozen=True)
class TreeData:
    nodes: tuple[TreeNode, ...]

    def to_dict(self) -> dict[str, object]:
        return {"nodes": [node.to_dict() for node in self.nodes]}


@dataclass(frozen=True)
class HistGradientBoostingModelData:
    schema_version: str
    baseline: float
    trees: tuple[TreeData, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "baseline": self.baseline,
            "schema_version": self.schema_version,
            "trees": [tree.to_dict() for tree in self.trees],
        }


@dataclass(frozen=True)
class DecisionAudit:
    decision_event_id: str
    reviewer_event_id: str
    outcome: DecisionOutcome
    reason_code: DecisionReasonCode

    def to_dict(self) -> dict[str, str]:
        return {
            "decision_event_id": self.decision_event_id,
            "outcome": self.outcome,
            "reason_code": self.reason_code,
            "reviewer_event_id": self.reviewer_event_id,
        }


@dataclass(frozen=True)
class ModelArtifact:
    schema_version: str
    training_run_id: str
    algorithm: str
    feature_order: tuple[str, ...]
    hyperparameters: dict[str, object]
    sample_count: int
    metrics: ModelMetrics
    model_data: HistGradientBoostingModelData
    gate_recommendation: GateRecommendation
    decision_audit: DecisionAudit | None
    status: ArtifactStatus
    model_hash: str

    def _body_dict(self) -> dict[str, object]:
        return {
            "algorithm": self.algorithm,
            "feature_order": list(self.feature_order),
            "gate_recommendation": self.gate_recommendation,
            "hyperparameters": dict(self.hyperparameters),
            "metrics": self.metrics.to_dict(),
            "model_data": self.model_data.to_dict(),
            "decision_audit": None if self.decision_audit is None else self.decision_audit.to_dict(),
            "sample_count": self.sample_count,
            "schema_version": self.schema_version,
            "status": self.status,
            "training_run_id": self.training_run_id,
        }

    def to_dict(self) -> dict[str, object]:
        return {**self._body_dict(), "model_hash": self.model_hash}

    def validate(self) -> None:
        if self.schema_version != ARTIFACT_SCHEMA_VERSION:
            raise ValueError("artifact-schema-invalid")
        _canonical_uuid7(self.training_run_id)
        if self.algorithm != ALGORITHM or self.feature_order != FEATURE_ORDER:
            raise ValueError("artifact-model-contract-invalid")
        if self.hyperparameters != MODEL_HYPERPARAMETERS:
            raise ValueError("artifact-hyperparameters-invalid")
        if isinstance(self.sample_count, bool) or self.sample_count < MIN_TOTAL_SAMPLES:
            raise ValueError("artifact-sample-count-invalid")
        if self.status not in ("candidate", "approved", "rejected"):
            raise ValueError("artifact-status-invalid")
        _validate_metrics(self.metrics)
        _validate_model_data(self.model_data)
        if self.gate_recommendation != _gate_recommendation_for(self.metrics):
            raise ValueError("artifact-gate-recommendation-invalid")
        _validate_decision_audit(self.status, self.gate_recommendation, self.decision_audit)
        if not _is_sha256(self.model_hash) or self.model_hash != _content_hash(self._body_dict()):
            raise ValueError("artifact-hash-mismatch")


class ActiveModel:
    __slots__ = ("__registry", "__registry_token", "version", "active_epoch", "version_hash", "artifact_digest")

    def __new__(cls, *_args: object, **_kwargs: object) -> ActiveModel:
        raise TypeError("ActiveModel is issued only by the registry")

    def __setattr__(self, _name: str, _value: object) -> None:
        raise TypeError("ActiveModel is immutable")

    @property
    def model_hash(self) -> str:
        return _artifact_for_active(self).model_hash

    @property
    def schema_version(self) -> str:
        return _artifact_for_active(self).schema_version


def _artifact_for_active(active: object) -> ModelArtifact:
    if type(active) is not ActiveModel:
        raise ValueError("active-model-required")
    try:
        from .model_store import FileModelStore

        registry = object.__getattribute__(active, "_ActiveModel__registry")
        if type(registry) is not FileModelStore:
            raise ValueError("active-model-required")
        return FileModelStore._artifact_for_active_handle(registry, active)
    except (AttributeError, OSError, TypeError, ValueError) as error:
        raise ValueError("active-model-required") from error


def _canonical_uuid7(value: str) -> str:
    return str(canonical_uuid7(value, "training-run-id-invalid"))


def _canonical_bytes(payload: dict[str, object]) -> bytes:
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _content_hash(payload: dict[str, object]) -> str:
    return hashlib.sha256(_canonical_bytes(payload)).hexdigest()


def _is_sha256(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def _gate_recommendation_for(metrics: ModelMetrics) -> GateRecommendation:
    recommend_approval = (
        metrics.oof_roc_auc >= MIN_ROC_AUC
        and metrics.temporal_roc_auc >= MIN_ROC_AUC
        and metrics.oof_log_loss < metrics.oof_baseline_log_loss
        and metrics.temporal_log_loss < metrics.temporal_baseline_log_loss
        and metrics.oof_auc_lower_bound >= MIN_ROC_AUC
        and metrics.temporal_auc_lower_bound >= MIN_ROC_AUC
        and metrics.oof_log_loss_gain_lower_bound > 0
        and metrics.temporal_log_loss_gain_lower_bound > 0
    )
    return "approve" if recommend_approval else "reject"


def _validate_decision_audit(
    status: ArtifactStatus,
    gate_recommendation: GateRecommendation,
    audit: DecisionAudit | None,
) -> None:
    if status == "candidate":
        if audit is not None:
            raise ValueError("artifact-decision-invalid")
        return
    if audit is None or audit.outcome != status:
        raise ValueError("artifact-decision-invalid")
    try:
        decision_event_id = str(canonical_uuid7(audit.decision_event_id, "decision-event-id-invalid"))
        reviewer_event_id = str(canonical_uuid7(audit.reviewer_event_id, "reviewer-event-id-invalid"))
    except ValueError as error:
        raise ValueError(str(error)) from error
    if decision_event_id == reviewer_event_id:
        raise ValueError("decision-audit-invalid")
    if audit.reason_code not in _DECISION_REASON_CODES:
        raise ValueError("decision-reason-invalid")
    recommended_outcome = "approved" if gate_recommendation == "approve" else "rejected"
    if audit.reason_code == "gate-recommendation-accepted" and audit.outcome != recommended_outcome:
        raise ValueError("decision-reason-invalid")
    if audit.reason_code == "gate-recommendation-overridden" and audit.outcome == recommended_outcome:
        raise ValueError("decision-reason-invalid")
    if audit.reason_code == "policy-review-approved" and audit.outcome != "approved":
        raise ValueError("decision-reason-invalid")
    if audit.reason_code == "policy-review-rejected" and audit.outcome != "rejected":
        raise ValueError("decision-reason-invalid")


def decide_candidate(
    artifact: ModelArtifact,
    outcome: DecisionOutcome,
    decision_event_id: str,
    reviewer_event_id: str,
    reason_code: DecisionReasonCode,
) -> ModelArtifact:
    if type(artifact) is not ModelArtifact:
        raise ValueError("model-artifact-invalid")
    artifact.validate()
    if outcome not in ("approved", "rejected"):
        raise ValueError("model-decision-invalid")
    if reason_code not in _DECISION_REASON_CODES:
        raise ValueError("decision-reason-invalid")
    canonical_decision_id = str(canonical_uuid7(decision_event_id, "decision-event-id-invalid"))
    canonical_reviewer_id = str(canonical_uuid7(reviewer_event_id, "reviewer-event-id-invalid"))
    if canonical_decision_id == canonical_reviewer_id:
        raise ValueError("decision-audit-invalid")
    audit = DecisionAudit(canonical_decision_id, canonical_reviewer_id, outcome, reason_code)
    _validate_decision_audit(outcome, artifact.gate_recommendation, audit)
    if artifact.status != "candidate":
        if artifact.status == outcome and artifact.decision_audit == audit:
            return artifact
        raise ValueError("model-decision-conflict")
    decided = replace(artifact, status=outcome, decision_audit=audit, model_hash="")
    decided = replace(decided, model_hash=_content_hash(decided._body_dict()))
    decided.validate()
    return decided


def _new_model() -> HistGradientBoostingClassifier:
    return HistGradientBoostingClassifier(**MODEL_HYPERPARAMETERS)


def temporal_holdout_indices(samples: list[TrainingSample]) -> tuple[list[int], list[int]]:
    groups: dict[UUID, list[int]] = defaultdict(list)
    for index, sample in enumerate(samples):
        groups[sample.request_id].append(index)

    group_rows = sorted(
        (
            min(samples[index].exposed_at for index in indices),
            max(samples[index].exposed_at for index in indices),
            group,
            len(indices),
            sum(samples[index].clicked for index in indices),
        )
        for group, indices in groups.items()
    )
    if len(group_rows) < MIN_TEMPORAL_GROUPS + 1:
        raise ValueError("temporal-holdout-too-small")

    suffix_samples = [0] * (len(group_rows) + 1)
    suffix_positives = [0] * (len(group_rows) + 1)
    for index in range(len(group_rows) - 1, -1, -1):
        suffix_samples[index] = suffix_samples[index + 1] + group_rows[index][3]
        suffix_positives[index] = suffix_positives[index + 1] + group_rows[index][4]

    boundary_candidates: list[tuple[int, int]] = []
    prefix_maximum = group_rows[0][1]
    for index in range(1, len(group_rows)):
        cutoff = group_rows[index][0]
        if group_rows[index - 1][0] != cutoff and prefix_maximum < cutoff:
            boundary_candidates.append((index, suffix_samples[index]))
        prefix_maximum = max(prefix_maximum, group_rows[index][1])
    if not boundary_candidates:
        raise ValueError("temporal-group-overlap")

    sized_candidates = [
        (index, sample_count)
        for index, sample_count in boundary_candidates
        if sample_count >= MIN_TEMPORAL_SAMPLES and len(group_rows) - index >= MIN_TEMPORAL_GROUPS
    ]
    if not sized_candidates:
        raise ValueError("temporal-holdout-too-small")
    valid_candidates = [
        (index, sample_count)
        for index, sample_count in sized_candidates
        if min(suffix_positives[index], sample_count - suffix_positives[index]) >= MIN_TEMPORAL_CLASS_SAMPLES
    ]
    if not valid_candidates:
        raise ValueError("temporal-class-too-small")

    boundary_index, _ = min(
        valid_candidates,
        key=lambda candidate: (
            abs(candidate[1] / len(samples) - TEMPORAL_HOLDOUT_FRACTION),
            abs((len(group_rows) - candidate[0]) / len(group_rows) - TEMPORAL_HOLDOUT_FRACTION),
            -candidate[1],
        ),
    )
    holdout_groups = {row[2] for row in group_rows[boundary_index:]}
    train_indices = [index for index, sample in enumerate(samples) if sample.request_id not in holdout_groups]
    holdout_indices = [index for index, sample in enumerate(samples) if sample.request_id in holdout_groups]
    if not train_indices or max(samples[index].exposed_at for index in train_indices) >= min(
        samples[index].exposed_at for index in holdout_indices
    ):
        raise ValueError("temporal-group-overlap")
    return train_indices, holdout_indices


def grouped_fold_indices(
    samples: list[TrainingSample],
    eligible_indices: list[int] | None = None,
) -> list[tuple[list[int], list[int]]]:
    indices = list(range(len(samples))) if eligible_indices is None else list(eligible_indices)
    features = [samples[index].features for index in indices]
    labels = [samples[index].clicked for index in indices]
    groups = [str(samples[index].request_id) for index in indices]
    splitter = StratifiedGroupKFold(n_splits=CV_FOLDS, shuffle=True, random_state=42)
    folds: list[tuple[list[int], list[int]]] = []
    for local_train, local_test in splitter.split(features, labels, groups):
        train = [indices[int(index)] for index in local_train]
        test = [indices[int(index)] for index in local_test]
        train_requests = {samples[index].request_id for index in train}
        test_requests = {samples[index].request_id for index in test}
        if not train_requests.isdisjoint(test_requests):
            raise ValueError("grouped-cv-request-leakage")
        for fold_indices in (train, test):
            if min(sum(samples[index].clicked == label for index in fold_indices) for label in (0, 1)) < MIN_FOLD_CLASS_SAMPLES:
                raise ValueError("grouped-cv-class-too-small")
        folds.append((train, test))
    return folds


def _quantile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.floor((len(ordered) - 1) * quantile))]


def _bootstrap_lower_bounds(
    labels: list[int],
    probabilities: list[float],
    baselines: list[float],
    groups: list[str],
    seed: int,
) -> tuple[float, float]:
    by_group: dict[str, list[int]] = defaultdict(list)
    for index, group in enumerate(groups):
        by_group[group].append(index)
    group_names = sorted(by_group)
    generator = random.Random(seed)
    auc_values: list[float] = []
    gain_values: list[float] = []
    for _ in range(BOOTSTRAP_ITERATIONS):
        sampled_groups = [generator.choice(group_names) for _ in group_names]
        sampled_indices = [index for group in sampled_groups for index in by_group[group]]
        sampled_labels = [labels[index] for index in sampled_indices]
        if len(set(sampled_labels)) != 2:
            continue
        sampled_probabilities = [probabilities[index] for index in sampled_indices]
        sampled_baselines = [baselines[index] for index in sampled_indices]
        auc_values.append(float(roc_auc_score(sampled_labels, sampled_probabilities)))
        gain_values.append(
            float(log_loss(sampled_labels, sampled_baselines, labels=[0, 1]))
            - float(log_loss(sampled_labels, sampled_probabilities, labels=[0, 1]))
        )
    if len(auc_values) < BOOTSTRAP_ITERATIONS // 2:
        raise ValueError("metric-uncertainty-insufficient")
    return _quantile(auc_values, BOOTSTRAP_QUANTILE), _quantile(gain_values, BOOTSTRAP_QUANTILE)


def _evaluate(samples: list[TrainingSample]) -> ModelMetrics:
    train_indices, temporal_indices = temporal_holdout_indices(samples)
    oof_probabilities: dict[int, float] = {}
    oof_baselines: dict[int, float] = {}
    for fold_train, fold_test in grouped_fold_indices(samples, train_indices):
        model = _new_model()
        train_labels = [samples[index].clicked for index in fold_train]
        model.fit([samples[index].features for index in fold_train], train_labels)
        probabilities = model.predict_proba([samples[index].features for index in fold_test])[:, 1]
        positive_rate = sum(train_labels) / len(train_labels)
        for index, probability in zip(fold_test, probabilities, strict=True):
            oof_probabilities[index] = float(probability)
            oof_baselines[index] = positive_rate
    if set(oof_probabilities) != set(train_indices):
        raise ValueError("grouped-cv-incomplete")

    oof_labels = [samples[index].clicked for index in train_indices]
    oof = [oof_probabilities[index] for index in train_indices]
    oof_baseline = [oof_baselines[index] for index in train_indices]
    oof_groups = [str(samples[index].request_id) for index in train_indices]

    temporal_model = _new_model()
    temporal_model.fit([samples[index].features for index in train_indices], oof_labels)
    temporal_labels = [samples[index].clicked for index in temporal_indices]
    temporal = [
        float(value)
        for value in temporal_model.predict_proba([samples[index].features for index in temporal_indices])[:, 1]
    ]
    training_positive_rate = sum(oof_labels) / len(oof_labels)
    temporal_baseline = [training_positive_rate] * len(temporal_indices)
    temporal_groups = [str(samples[index].request_id) for index in temporal_indices]

    oof_auc_lower, oof_gain_lower = _bootstrap_lower_bounds(oof_labels, oof, oof_baseline, oof_groups, 4201)
    temporal_auc_lower, temporal_gain_lower = _bootstrap_lower_bounds(
        temporal_labels, temporal, temporal_baseline, temporal_groups, 4202
    )
    return ModelMetrics(
        oof_roc_auc=float(roc_auc_score(oof_labels, oof)),
        oof_log_loss=float(log_loss(oof_labels, oof, labels=[0, 1])),
        oof_baseline_log_loss=float(log_loss(oof_labels, oof_baseline, labels=[0, 1])),
        temporal_roc_auc=float(roc_auc_score(temporal_labels, temporal)),
        temporal_log_loss=float(log_loss(temporal_labels, temporal, labels=[0, 1])),
        temporal_baseline_log_loss=float(log_loss(temporal_labels, temporal_baseline, labels=[0, 1])),
        oof_auc_lower_bound=oof_auc_lower,
        temporal_auc_lower_bound=temporal_auc_lower,
        oof_log_loss_gain_lower_bound=oof_gain_lower,
        temporal_log_loss_gain_lower_bound=temporal_gain_lower,
        fold_count=CV_FOLDS,
        temporal_sample_count=len(temporal_indices),
        bootstrap_iterations=BOOTSTRAP_ITERATIONS,
    )


def _export_model(model: HistGradientBoostingClassifier) -> HistGradientBoostingModelData:
    predictors = getattr(model, "_predictors", None)
    baseline = getattr(model, "_baseline_prediction", None)
    if not isinstance(predictors, list) or baseline is None or baseline.shape != (1, 1):
        raise ValueError("sklearn-model-export-invalid")
    trees: list[TreeData] = []
    for iteration in predictors:
        if len(iteration) != 1:
            raise ValueError("sklearn-model-export-invalid")
        exported_nodes: list[TreeNode] = []
        for node in iteration[0].nodes:
            if bool(node["is_categorical"]):
                raise ValueError("sklearn-categorical-tree-unsupported")
            exported_nodes.append(
                TreeNode(
                    value=float(node["value"]),
                    feature_index=int(node["feature_idx"]),
                    threshold=float(node["num_threshold"]),
                    missing_go_to_left=bool(node["missing_go_to_left"]),
                    left=int(node["left"]),
                    right=int(node["right"]),
                    is_leaf=bool(node["is_leaf"]),
                )
            )
        trees.append(TreeData(tuple(exported_nodes)))
    return HistGradientBoostingModelData(
        schema_version=MODEL_DATA_SCHEMA_VERSION,
        baseline=float(baseline[0, 0]),
        trees=tuple(trees),
    )


def _predict_artifact(artifact: ModelArtifact, values: list[float]) -> float:
    raw = artifact.model_data.baseline
    for tree in artifact.model_data.trees:
        index = 0
        while True:
            node = tree.nodes[index]
            if node.is_leaf:
                raw += node.value
                break
            value = values[node.feature_index]
            index = node.left if value <= node.threshold else node.right
    if raw >= 0:
        return 1 / (1 + math.exp(-raw))
    exponential = math.exp(raw)
    return exponential / (1 + exponential)


def predict_probability(active: ActiveModel, features: list[object]) -> float:
    artifact = _artifact_for_active(active)
    if len(features) != len(FEATURE_ORDER):
        raise ValueError("prediction-feature-count-invalid")
    try:
        values = [normalize_feature_value(value) for value in features]
    except ValueError as error:
        raise ValueError("prediction-feature-invalid") from error
    return _predict_artifact(artifact, values)


def _validate_metrics(metrics: ModelMetrics) -> None:
    float_values = (
        metrics.oof_roc_auc,
        metrics.oof_log_loss,
        metrics.oof_baseline_log_loss,
        metrics.temporal_roc_auc,
        metrics.temporal_log_loss,
        metrics.temporal_baseline_log_loss,
        metrics.oof_auc_lower_bound,
        metrics.temporal_auc_lower_bound,
        metrics.oof_log_loss_gain_lower_bound,
        metrics.temporal_log_loss_gain_lower_bound,
    )
    if any(isinstance(value, bool) or not math.isfinite(value) for value in float_values):
        raise ValueError("artifact-metrics-invalid")
    if not all(0 <= value <= 1 for value in (
        metrics.oof_roc_auc,
        metrics.temporal_roc_auc,
        metrics.oof_auc_lower_bound,
        metrics.temporal_auc_lower_bound,
    )):
        raise ValueError("artifact-metrics-invalid")
    if min(metrics.oof_log_loss, metrics.oof_baseline_log_loss, metrics.temporal_log_loss,
           metrics.temporal_baseline_log_loss) < 0:
        raise ValueError("artifact-metrics-invalid")
    if (
        metrics.fold_count != CV_FOLDS
        or metrics.temporal_sample_count < MIN_TEMPORAL_SAMPLES
        or metrics.bootstrap_iterations != BOOTSTRAP_ITERATIONS
    ):
        raise ValueError("artifact-metrics-invalid")


def _validate_model_data(model_data: HistGradientBoostingModelData) -> None:
    if model_data.schema_version != MODEL_DATA_SCHEMA_VERSION or not math.isfinite(model_data.baseline):
        raise ValueError("artifact-model-data-invalid")
    if len(model_data.trees) != int(MODEL_HYPERPARAMETERS["max_iter"]):
        raise ValueError("artifact-model-data-invalid")
    for tree in model_data.trees:
        if not tree.nodes:
            raise ValueError("artifact-model-data-invalid")
        visited: set[int] = set()
        stack = [0]
        while stack:
            index = stack.pop()
            if index in visited or not 0 <= index < len(tree.nodes):
                raise ValueError("artifact-model-data-invalid")
            visited.add(index)
            node = tree.nodes[index]
            if (
                isinstance(node.feature_index, bool)
                or isinstance(node.left, bool)
                or isinstance(node.right, bool)
                or not math.isfinite(node.value)
                or not math.isfinite(node.threshold)
                or type(node.missing_go_to_left) is not bool
                or type(node.is_leaf) is not bool
            ):
                raise ValueError("artifact-model-data-invalid")
            if node.is_leaf:
                if node.left != 0 or node.right != 0:
                    raise ValueError("artifact-model-data-invalid")
            else:
                if not 0 <= node.feature_index < len(FEATURE_ORDER) or node.left == node.right:
                    raise ValueError("artifact-model-data-invalid")
                stack.extend((node.left, node.right))
        if len(visited) != len(tree.nodes):
            raise ValueError("artifact-model-data-invalid")


def _strict_json_loads(payload: bytes) -> object:
    def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("artifact-fields-invalid")
            result[key] = value
        return result
    try:
        return json.loads(payload, object_pairs_hook=reject_duplicate_keys)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
        raise ValueError("artifact-file-invalid") from error


def artifact_from_dict(payload: object) -> ModelArtifact:
    expected = {
        "algorithm", "decision_audit", "feature_order", "gate_recommendation", "hyperparameters",
        "metrics", "model_data", "model_hash", "sample_count", "schema_version", "status", "training_run_id",
    }
    if not isinstance(payload, dict) or set(payload) != expected:
        raise ValueError("artifact-fields-invalid")
    metrics_payload = payload["metrics"]
    metric_fields = set(ModelMetrics.__dataclass_fields__)
    if not isinstance(metrics_payload, dict) or set(metrics_payload) != metric_fields:
        raise ValueError("artifact-metrics-invalid")
    float_metric_names = metric_fields - {"fold_count", "temporal_sample_count", "bootstrap_iterations"}
    if any(
        isinstance(metrics_payload[name], bool) or not isinstance(metrics_payload[name], (int, float))
        for name in float_metric_names
    ) or any(type(metrics_payload[name]) is not int for name in ("fold_count", "temporal_sample_count", "bootstrap_iterations")):
        raise ValueError("artifact-metrics-invalid")

    model_payload = payload["model_data"]
    if not isinstance(model_payload, dict) or set(model_payload) != {"baseline", "schema_version", "trees"}:
        raise ValueError("artifact-model-data-invalid")
    if (
        isinstance(model_payload["baseline"], bool)
        or not isinstance(model_payload["baseline"], (int, float))
        or not isinstance(model_payload["schema_version"], str)
        or not isinstance(model_payload["trees"], list)
    ):
        raise ValueError("artifact-model-data-invalid")
    trees: list[TreeData] = []
    node_fields = set(TreeNode.__dataclass_fields__)
    for tree_payload in model_payload["trees"]:
        if not isinstance(tree_payload, dict) or set(tree_payload) != {"nodes"} or not isinstance(tree_payload["nodes"], list):
            raise ValueError("artifact-model-data-invalid")
        nodes: list[TreeNode] = []
        for node in tree_payload["nodes"]:
            if not isinstance(node, dict) or set(node) != node_fields:
                raise ValueError("artifact-model-data-invalid")
            if (
                any(type(node[name]) is not int for name in ("feature_index", "left", "right"))
                or any(isinstance(node[name], bool) or not isinstance(node[name], (int, float)) for name in ("value", "threshold"))
                or type(node["missing_go_to_left"]) is not bool
                or type(node["is_leaf"]) is not bool
            ):
                raise ValueError("artifact-model-data-invalid")
            nodes.append(TreeNode(
                value=float(node["value"]),
                feature_index=node["feature_index"],
                threshold=float(node["threshold"]),
                missing_go_to_left=node["missing_go_to_left"],
                left=node["left"],
                right=node["right"],
                is_leaf=node["is_leaf"],
            ))
        trees.append(TreeData(tuple(nodes)))

    decision_payload = payload["decision_audit"]
    decision_audit: DecisionAudit | None
    if decision_payload is None:
        decision_audit = None
    elif (
        isinstance(decision_payload, dict)
        and set(decision_payload) == {"decision_event_id", "outcome", "reason_code", "reviewer_event_id"}
        and all(isinstance(value, str) for value in decision_payload.values())
    ):
        decision_audit = DecisionAudit(
            decision_event_id=decision_payload["decision_event_id"],
            reviewer_event_id=decision_payload["reviewer_event_id"],
            outcome=decision_payload["outcome"],
            reason_code=decision_payload["reason_code"],
        )
    else:
        raise ValueError("artifact-decision-invalid")

    hyperparameters = payload["hyperparameters"]
    feature_order = payload["feature_order"]
    if (
        not isinstance(hyperparameters, dict)
        or hyperparameters != MODEL_HYPERPARAMETERS
        or not isinstance(feature_order, list)
        or any(not isinstance(value, str) for value in feature_order)
        or type(payload["sample_count"]) is not int
        or any(not isinstance(payload[name], str) for name in (
            "algorithm", "gate_recommendation", "model_hash", "schema_version", "status", "training_run_id",
        ))
    ):
        raise ValueError("artifact-value-invalid")
    artifact = ModelArtifact(
        schema_version=payload["schema_version"],
        training_run_id=payload["training_run_id"],
        algorithm=payload["algorithm"],
        feature_order=tuple(feature_order),
        hyperparameters=dict(hyperparameters),
        sample_count=payload["sample_count"],
        metrics=ModelMetrics(**{name: (
            int(metrics_payload[name]) if name in {"fold_count", "temporal_sample_count", "bootstrap_iterations"}
            else float(metrics_payload[name])
        ) for name in metric_fields}),
        model_data=HistGradientBoostingModelData(
            schema_version=model_payload["schema_version"],
            baseline=float(model_payload["baseline"]),
            trees=tuple(trees),
        ),
        gate_recommendation=payload["gate_recommendation"],
        decision_audit=decision_audit,
        status=payload["status"],
        model_hash=payload["model_hash"],
    )
    artifact.validate()
    return artifact


def artifact_bytes(artifact: ModelArtifact) -> bytes:
    artifact.validate()
    return (json.dumps(artifact.to_dict(), indent=2, sort_keys=True) + "\n").encode("utf-8")


def artifact_from_bytes(payload: bytes) -> ModelArtifact:
    return artifact_from_dict(_strict_json_loads(payload))


def load_artifact(path: Path) -> ModelArtifact:
    try:
        payload = path.read_bytes()
    except OSError as error:
        raise ValueError("artifact-file-invalid") from error
    return artifact_from_bytes(payload)


def write_immutable_artifact(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with lock_path.open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            if path.is_symlink():
                raise ValueError("artifact-output-invalid")
            if path.exists():
                try:
                    existing = path.read_bytes()
                except OSError as error:
                    raise ValueError("artifact-output-invalid") from error
                if existing == payload:
                    return
                raise ValueError("artifact-output-conflict")
            descriptor, temporary_name = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
            temporary = Path(temporary_name)
            try:
                with os.fdopen(descriptor, "wb") as output:
                    output.write(payload)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, path)
                directory = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
            finally:
                temporary.unlink(missing_ok=True)
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def train_model(input_path: Path, output_path: Path, training_run_id: str) -> ModelArtifact:
    canonical_run_id = _canonical_uuid7(training_run_id)
    samples = sorted(
        load_samples(input_path),
        key=lambda sample: (sample.exposed_at, sample.request_id.bytes, sample.exposure_id.bytes),
    )
    metrics = _evaluate(samples)
    gate_recommendation = _gate_recommendation_for(metrics)
    model = _new_model()
    model.fit([sample.features for sample in samples], [sample.clicked for sample in samples])
    model_data = _export_model(model)
    body: dict[str, object] = {
        "algorithm": ALGORITHM,
        "decision_audit": None,
        "feature_order": list(FEATURE_ORDER),
        "gate_recommendation": gate_recommendation,
        "hyperparameters": dict(MODEL_HYPERPARAMETERS),
        "metrics": metrics.to_dict(),
        "model_data": model_data.to_dict(),
        "sample_count": len(samples),
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "status": "candidate",
        "training_run_id": canonical_run_id,
    }
    artifact = ModelArtifact(
        schema_version=ARTIFACT_SCHEMA_VERSION,
        training_run_id=canonical_run_id,
        algorithm=ALGORITHM,
        feature_order=FEATURE_ORDER,
        hyperparameters=dict(MODEL_HYPERPARAMETERS),
        sample_count=len(samples),
        metrics=metrics,
        model_data=model_data,
        gate_recommendation=gate_recommendation,
        decision_audit=None,
        status="candidate",
        model_hash=_content_hash(body),
    )
    artifact.validate()
    write_immutable_artifact(output_path, artifact_bytes(artifact))
    return artifact


def main() -> None:
    parser = argparse.ArgumentParser(description="Train one Agent Market CTR model")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--training-run-id", required=True)
    args = parser.parse_args()
    train_model(args.input, args.output, args.training_run_id)


if __name__ == "__main__":
    main()
