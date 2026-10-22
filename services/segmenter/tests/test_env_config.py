import unittest
from typing import Optional
from unittest import mock

import os
import sys

_SEGMENTER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _SEGMENTER_DIR not in sys.path:
    sys.path.insert(0, _SEGMENTER_DIR)

from env_config import env_enabled, env_float

_VAR = "SEGMENTER_TEST_ENV_VALUE"


class TestEnvFloat(unittest.TestCase):
    def _read(self, raw: Optional[str]) -> float:
        env = {} if raw is None else {_VAR: raw}
        with mock.patch.dict(os.environ, env, clear=False):
            if raw is None:
                os.environ.pop(_VAR, None)
            return env_float(_VAR, 0.42, 0.15, 0.9)

    def test_unset_uses_default(self) -> None:
        self.assertEqual(self._read(None), 0.42)

    def test_valid_value_with_whitespace(self) -> None:
        self.assertEqual(self._read(" 0.5 "), 0.5)

    def test_invalid_or_empty_uses_default(self) -> None:
        self.assertEqual(self._read("abc"), 0.42)
        self.assertEqual(self._read(""), 0.42)

    def test_clamped_to_range(self) -> None:
        self.assertEqual(self._read("2"), 0.9)
        self.assertEqual(self._read("-1"), 0.15)
        self.assertEqual(self._read("inf"), 0.9)

    def test_returns_builtin_float(self) -> None:
        self.assertIs(type(self._read("0.3")), float)


class TestEnvEnabled(unittest.TestCase):
    def _read(self, raw: Optional[str]) -> bool:
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(_VAR, None)
            if raw is not None:
                os.environ[_VAR] = raw
            return env_enabled(_VAR, "1")

    def test_default_on(self) -> None:
        self.assertTrue(self._read(None))

    def test_falsy_values(self) -> None:
        for raw in ("0", "false", "OFF", " no "):
            self.assertFalse(self._read(raw), raw)

    def test_anything_else_is_enabled(self) -> None:
        for raw in ("1", "yes", "true", "", "maybe"):
            self.assertTrue(self._read(raw), raw)


if __name__ == "__main__":
    unittest.main()
