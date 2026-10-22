"""Environment-variable parsing helpers for the segmenter service."""

import os

import numpy as np

_FALSY_VALUES = ("0", "false", "off", "no")
_TRUTHY_VALUES = ("1", "true", "on", "yes")


def env_float(name: str, default: float, lo: float, hi: float) -> float:
    """Reads a float env var (``default`` when unset/invalid), clamped to [lo, hi]."""
    raw = os.getenv(name)
    value = default
    if raw is not None:
        try:
            value = float(raw.strip())
        except Exception:
            value = default
    return float(np.clip(value, lo, hi))


def env_int(name: str, default: int, lo: int, hi: int) -> int:
    """Reads an int env var (``default`` when unset/invalid), clamped to [lo, hi]."""
    raw = os.getenv(name)
    value = default
    if raw is not None:
        try:
            value = int(raw.strip())
        except ValueError:
            value = default
    return max(lo, min(hi, value))


def env_enabled(name: str, default: str = "1") -> bool:
    """Returns False only for explicit falsy values ("0", "false", "off", "no")."""
    raw = os.getenv(name, default).strip().lower()
    return raw not in _FALSY_VALUES


def env_truthy(name: str) -> bool:
    """Returns True only for explicit truthy values ("1", "true", "on", "yes")."""
    return os.getenv(name, "").strip().lower() in _TRUTHY_VALUES
