"""Offline, deterministic CTR training package for Agent Market."""

from typing import Any

__all__ = [
    "ActiveModel",
    "DecisionAudit",
    "ModelArtifact",
    "decide_candidate",
    "predict_probability",
    "train_model",
]


def __getattr__(name: str) -> Any:
    if name in __all__:
        from . import train

        return getattr(train, name)
    raise AttributeError(name)
