from __future__ import annotations

import fcntl
import json
import os
import re
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Iterator, Literal

from .train import (
    ARTIFACT_SCHEMA_VERSION,
    ActiveModel,
    ModelArtifact,
    artifact_bytes,
    artifact_from_bytes,
    decide_candidate,
    load_artifact,
    write_immutable_artifact,
)


REGISTRY_SCHEMA_VERSION = "model-registry.v3"
LifecycleStatus = Literal["candidate", "approved", "rejected", "active", "retired"]
_ALLOWED_STATUSES = {"candidate", "approved", "rejected", "active", "retired"}
_VERSION_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class StoredModel:
    version: str
    model_hash: str
    artifact_digest: str
    artifact_path: str
    artifact_schema_version: str
    status: LifecycleStatus


def _strict_registry_json(payload: str) -> object:
    def reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate-key")
            result[key] = value
        return result
    return json.loads(payload, object_pairs_hook=reject_duplicate_keys)


class FileModelStore:
    """Validated local registry with explicit activation and cross-process locking."""

    def __init__(self, registry_path: Path) -> None:
        self.registry_path = registry_path
        self.lock_path = registry_path.with_suffix(registry_path.suffix + ".lock")
        self.artifact_dir = registry_path.parent / f"{registry_path.stem}.artifacts"
        self._handle_token = object()
        self._epoch_floor = 0

    def register(self, version: str, artifact_path: Path) -> StoredModel:
        self._validate_version(version)
        if not isinstance(artifact_path, Path):
            raise ValueError("model-artifact-invalid")
        try:
            artifact = load_artifact(artifact_path)
        except ValueError as error:
            raise ValueError("model-artifact-invalid") from error
        if artifact.status not in ("candidate", "approved", "rejected"):
            raise ValueError("artifact-status-invalid")
        canonical_artifact = artifact_bytes(artifact)
        artifact_digest = sha256(canonical_artifact).hexdigest()
        relative_path = self._relative_artifact_path(artifact_digest)
        candidate = {
            "artifact_digest": artifact_digest,
            "artifact_path": relative_path,
            "artifact_schema_version": artifact.schema_version,
            "model_hash": artifact.model_hash,
            "status": artifact.status,
        }
        with self._lock():
            managed_path = self._managed_artifact_path(relative_path, artifact_digest)
            self._ensure_artifact_dir_unlocked()
            try:
                write_immutable_artifact(managed_path, canonical_artifact)
                self._validate_bound_artifact_unlocked(candidate)
            except ValueError as error:
                raise ValueError("model-artifact-invalid") from error
            records, active_epoch = self._read_unlocked()
            if version in records and records[version] != candidate:
                raise ValueError("model-version-conflict")
            records[version] = candidate
            self._write_unlocked(records, active_epoch)
        return self._stored_model(version, candidate)

    def decide(
        self,
        version: str,
        outcome: Literal["approved", "rejected"],
        decision_event_id: str,
        reviewer_event_id: str,
        reason_code: str,
    ) -> StoredModel:
        self._validate_version(version)
        with self._lock():
            records, active_epoch = self._read_unlocked()
            record = records.get(version)
            if record is None:
                raise ValueError("model-version-not-found")
            artifact = self._validate_bound_artifact_unlocked(record)
            decided = decide_candidate(
                artifact, outcome, decision_event_id, reviewer_event_id, reason_code,
            )
            if decided == artifact:
                return self._stored_model(version, record)
            canonical_artifact = artifact_bytes(decided)
            artifact_digest = sha256(canonical_artifact).hexdigest()
            relative_path = self._relative_artifact_path(artifact_digest)
            candidate = {
                "artifact_digest": artifact_digest,
                "artifact_path": relative_path,
                "artifact_schema_version": decided.schema_version,
                "model_hash": decided.model_hash,
                "status": decided.status,
            }
            managed_path = self._managed_artifact_path(relative_path, artifact_digest)
            self._ensure_artifact_dir_unlocked()
            try:
                write_immutable_artifact(managed_path, canonical_artifact)
                self._validate_bound_artifact_unlocked(candidate)
            except ValueError as error:
                raise ValueError("model-artifact-invalid") from error
            records[version] = candidate
            self._write_unlocked(records, active_epoch)
            return self._stored_model(version, candidate)

    def activate(self, version: str) -> StoredModel:
        self._validate_version(version)
        with self._lock():
            records, active_epoch = self._read_unlocked()
            record = records.get(version)
            if record is None:
                raise ValueError("model-version-not-found")
            if record["status"] == "active":
                self._validate_bound_artifact_unlocked(record)
                return self._stored_model(version, record)
            if record["status"] != "approved":
                raise ValueError("model-not-approved")
            self._validate_bound_artifact_unlocked(record)
            for current in records.values():
                if current["status"] == "active":
                    current["status"] = "retired"
            record["status"] = "active"
            self._write_unlocked(records, active_epoch + 1)
            return self._stored_model(version, record)

    def load_active(self) -> ActiveModel:
        with self._lock():
            records, active_epoch = self._read_unlocked()
            active = [(version, record) for version, record in records.items() if record["status"] == "active"]
            if not active:
                raise ValueError("active-model-not-found")
            version, record = active[0]
            self._validate_bound_artifact_unlocked(record)
            active_model = object.__new__(ActiveModel)
            object.__setattr__(active_model, "_ActiveModel__registry", self)
            object.__setattr__(active_model, "_ActiveModel__registry_token", self._handle_token)
            object.__setattr__(active_model, "version", version)
            object.__setattr__(active_model, "active_epoch", active_epoch)
            object.__setattr__(active_model, "version_hash", self._active_version_hash(version, record))
            object.__setattr__(active_model, "artifact_digest", record["artifact_digest"])
            return active_model

    def list_models(self) -> dict[str, StoredModel]:
        with self._lock():
            records, _ = self._read_unlocked()
            return {version: self._stored_model(version, record) for version, record in records.items()}

    @contextmanager
    def _lock(self) -> Iterator[None]:
        self.registry_path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock_path.open("a+", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def _read_unlocked(self) -> tuple[dict[str, dict[str, str]], int]:
        if not self.registry_path.exists():
            if self._epoch_floor != 0:
                raise ValueError("model-registry-invalid")
            return {}, 0
        try:
            payload = _strict_registry_json(self.registry_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
            raise ValueError("model-registry-invalid") from error
        if not isinstance(payload, dict) or set(payload) != {"active_epoch", "models", "schema_version"}:
            raise ValueError("model-registry-invalid")
        active_epoch = payload["active_epoch"]
        if (
            payload["schema_version"] != REGISTRY_SCHEMA_VERSION
            or not isinstance(payload["models"], dict)
            or type(active_epoch) is not int
            or active_epoch < self._epoch_floor
        ):
            raise ValueError("model-registry-invalid")
        records: dict[str, dict[str, str]] = {}
        active_count = 0
        for version, raw_record in payload["models"].items():
            try:
                self._validate_version(version)
            except ValueError as error:
                raise ValueError("model-registry-invalid") from error
            if not isinstance(raw_record, dict) or set(raw_record) != {
                "artifact_digest", "artifact_path", "artifact_schema_version", "model_hash", "status",
            }:
                raise ValueError("model-registry-invalid")
            if (
                raw_record["artifact_schema_version"] != ARTIFACT_SCHEMA_VERSION
                or not isinstance(raw_record["artifact_digest"], str)
                or not _HASH_PATTERN.fullmatch(raw_record["artifact_digest"])
                or not isinstance(raw_record["artifact_path"], str)
                or raw_record["artifact_path"] != self._relative_artifact_path(raw_record["artifact_digest"])
                or not isinstance(raw_record["model_hash"], str)
                or not _HASH_PATTERN.fullmatch(raw_record["model_hash"])
                or not isinstance(raw_record["status"], str)
                or raw_record["status"] not in _ALLOWED_STATUSES
            ):
                raise ValueError("model-registry-invalid")
            if raw_record["status"] == "active":
                active_count += 1
            records[version] = dict(raw_record)
        if active_count > 1 or (active_count == 0) != (active_epoch == 0):
            raise ValueError("model-registry-invalid")
        self._epoch_floor = active_epoch
        return records, active_epoch

    def _artifact_for_active_handle(self, active: ActiveModel) -> ModelArtifact:
        try:
            if (
                type(active) is not ActiveModel
                or object.__getattribute__(active, "_ActiveModel__registry") is not self
                or object.__getattribute__(active, "_ActiveModel__registry_token") is not self._handle_token
            ):
                raise ValueError("active-model-required")
            with self._lock():
                records, active_epoch = self._read_unlocked()
                record = records.get(active.version)
                if (
                    active.active_epoch != active_epoch
                    or record is None
                    or record["status"] != "active"
                    or active.artifact_digest != record["artifact_digest"]
                    or active.version_hash != self._active_version_hash(active.version, record)
                ):
                    raise ValueError("active-model-required")
                return self._validate_bound_artifact_unlocked(record)
        except (AttributeError, OSError, TypeError, ValueError) as error:
            raise ValueError("active-model-required") from error

    @staticmethod
    def _active_version_hash(version: str, record: dict[str, str]) -> str:
        payload = {"record": record, "version": version}
        canonical = json.dumps(payload, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("utf-8")
        return sha256(canonical).hexdigest()

    def _validate_bound_artifact_unlocked(self, record: dict[str, str]) -> ModelArtifact:
        path = self._managed_artifact_path(record["artifact_path"], record["artifact_digest"])
        if path.is_symlink() or not path.is_file():
            raise ValueError("model-artifact-invalid")
        try:
            payload = path.read_bytes()
        except OSError as error:
            raise ValueError("model-artifact-invalid") from error
        if sha256(payload).hexdigest() != record["artifact_digest"]:
            raise ValueError("model-artifact-invalid")
        try:
            artifact = artifact_from_bytes(payload)
        except ValueError as error:
            raise ValueError("model-artifact-invalid") from error
        expected_status = (
            record["status"] if record["status"] in {"candidate", "rejected"} else "approved"
        )
        if (
            artifact.model_hash != record["model_hash"]
            or artifact.schema_version != record["artifact_schema_version"]
            or artifact.status != expected_status
        ):
            raise ValueError("model-artifact-invalid")
        return artifact

    def _ensure_artifact_dir_unlocked(self) -> None:
        if self.artifact_dir.is_symlink():
            raise ValueError("model-artifact-directory-invalid")
        self.artifact_dir.mkdir(parents=True, exist_ok=True)
        if not self.artifact_dir.is_dir():
            raise ValueError("model-artifact-directory-invalid")

    def _relative_artifact_path(self, artifact_digest: str) -> str:
        return f"{self.artifact_dir.name}/{artifact_digest}.json"

    def _managed_artifact_path(self, relative_path: str, artifact_digest: str) -> Path:
        expected = self._relative_artifact_path(artifact_digest)
        if relative_path != expected:
            raise ValueError("model-artifact-path-invalid")
        path = self.registry_path.parent / relative_path
        if path.parent != self.artifact_dir:
            raise ValueError("model-artifact-path-invalid")
        return path

    @staticmethod
    def _stored_model(version: str, record: dict[str, str]) -> StoredModel:
        return StoredModel(
            version, record["model_hash"], record["artifact_digest"], record["artifact_path"],
            record["artifact_schema_version"], record["status"],
        )

    def _write_unlocked(self, records: dict[str, dict[str, str]], active_epoch: int) -> None:
        payload = {"active_epoch": active_epoch, "models": records, "schema_version": REGISTRY_SCHEMA_VERSION}
        self.registry_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            dir=self.registry_path.parent, prefix=self.registry_path.name + ".", suffix=".tmp",
        )
        temporary = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                json.dump(payload, output, indent=2, sort_keys=True)
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.registry_path)
            self._epoch_floor = active_epoch
            directory = os.open(self.registry_path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _validate_version(version: object) -> None:
        if not isinstance(version, str) or not _VERSION_PATTERN.fullmatch(version):
            raise ValueError("model-version-invalid")
