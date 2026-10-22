import base64
import importlib.util
import unittest
from typing import Any, Dict, Optional, Tuple
from unittest import mock

import os
import sys

import cv2
import numpy as np

_SEGMENTER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _SEGMENTER_DIR not in sys.path:
    sys.path.insert(0, _SEGMENTER_DIR)

_HAS_DEPS = all(
    importlib.util.find_spec(name) is not None
    for name in ("fastapi", "httpx", "pydantic")
)

if _HAS_DEPS:
    from fastapi.testclient import TestClient

    import main
    from onnx_roofseg import OnnxRoofSeg
    from sam_model import SamState

# Variables that would enable ONNX/SAM or change heuristic thresholds.
_MODEL_ENV_VARS = (
    "ROOFSEG_ONNX_PATH",
    "SAM_CHECKPOINT",
    "SAM_MODEL_TYPE",
    "ROOFSEG_WHITE_BOOST",
    "ROOFSEG_THRESHOLD",
    "ROOFSEG_THRESHOLD_SWEEP",
    "ROOFSEG_WHITE_THRESHOLD",
    # Security knobs: unset so a developer's shell cannot change expectations.
    "SEGMENT_SHARED_SECRET",
    "SEGMENT_DEBUG",
    "SEGMENT_MAX_DATA_URL_CHARS",
    "SEGMENT_MAX_PIXELS",
    "SEGMENT_MAX_BODY_BYTES",
)

_FOOTPRINT = {
    "type": "Polygon",
    "coordinates": [
        [[0.25, 0.25], [0.75, 0.25], [0.75, 0.75], [0.25, 0.75], [0.25, 0.25]]
    ],
}


def _data_url(img_bgr: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", img_bgr)
    assert ok
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode("ascii")


def _bright_square() -> np.ndarray:
    img = np.full((160, 200, 3), 40, dtype=np.uint8)
    img[40:120, 50:150] = 245
    return img


def _dark() -> np.ndarray:
    return np.full((120, 140, 3), 20, dtype=np.uint8)


def _gable() -> np.ndarray:
    img = np.full((180, 220, 3), 35, dtype=np.uint8)
    img[40:140, 40:180] = (200, 200, 200)
    img[40:90, 40:180] = (235, 235, 235)
    cv2.line(img, (40, 90), (180, 90), (90, 90, 90), 2)
    return img


class _FakeOnnx:
    """Stands in for OnnxRoofSeg: probability = blurred grayscale."""

    def __init__(self) -> None:
        self.ready = True
        self.error: Optional[str] = None
        self.path = "/fake/model.onnx"
        self.size = 512

    def ensure_loaded(self) -> bool:
        return True

    def predict_prob(self, img_bgr: np.ndarray) -> np.ndarray:
        gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
        return cv2.GaussianBlur(gray, (0, 0), 2.0).astype(np.float32)

    def predict_prob_roi(
        self, img_bgr: np.ndarray, roi_bounds: Tuple[int, int, int, int]
    ) -> Tuple[np.ndarray, Tuple[int, int, int, int]]:
        x0, y0, x1, y1 = roi_bounds
        full = np.zeros(img_bgr.shape[:2], dtype=np.float32)
        full[y0:y1, x0:x1] = self.predict_prob(img_bgr[y0:y1, x0:x1])
        return full, roi_bounds


class _FakeSam:
    """Stands in for SamState: three brightness-threshold masks with fixed scores."""

    def __init__(self, fail: bool = False) -> None:
        self.ready = True
        self.error: Optional[str] = None
        self.model_type = "vit_h"
        self.device = "cpu"
        self.fail = fail

    def ensure_loaded(self) -> bool:
        return True

    def predict(
        self,
        image_rgb: np.ndarray,
        point_coords: Optional[np.ndarray],
        point_labels: Optional[np.ndarray],
        box: Optional[np.ndarray],
    ) -> Tuple[np.ndarray, np.ndarray]:
        if self.fail:
            raise RuntimeError("sam exploded")
        gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
        masks = np.stack([gray > 220, gray > 150, gray > 60])
        return masks, np.array([0.91, 0.84, 0.42], dtype=np.float32)


@unittest.skipUnless(_HAS_DEPS, "fastapi/httpx/pydantic not installed")
class _EndpointTestCase(unittest.TestCase):
    """Runs with ONNX and SAM unavailable unless a test swaps in a fake."""

    def setUp(self) -> None:
        patches = [
            mock.patch.dict(os.environ),  # restores the environment afterwards
            mock.patch.object(main, "SAM", SamState()),
            mock.patch.object(main, "ONNX", OnnxRoofSeg()),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        for name in _MODEL_ENV_VARS:
            os.environ.pop(name, None)
        self.client = TestClient(main.app)

    def _segment(self, body: Dict[str, Any]) -> Any:
        return self.client.post("/segment", json=body)


class TestHealthz(_EndpointTestCase):
    def test_reports_models_unavailable(self) -> None:
        res = self.client.get("/healthz")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data["ok"])
        self.assertEqual(
            data["onnx"],
            {"ready": False, "error": None, "path": None, "inputSize": None},
        )
        self.assertEqual(
            data["sam"],
            {
                "ready": False,
                "error": "unavailable",  # raw error only with SEGMENT_DEBUG=1
                "modelType": None,
                "device": None,
            },
        )


class TestSegmentValidation(_EndpointTestCase):
    def test_missing_image_is_400(self) -> None:
        res = self._segment({})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["detail"], "Provide imageDataUrl or imageRef")

    def test_blank_image_is_400(self) -> None:
        res = self._segment({"imageDataUrl": "   "})
        self.assertEqual(res.status_code, 400)

    def test_invalid_data_url_is_400(self) -> None:
        with self.assertLogs("segmenter", level="WARNING"):
            res = self._segment({"imageDataUrl": "https://example.com/roof.png"})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["detail"], "Invalid image")

    def test_undecodable_image_is_400(self) -> None:
        with self.assertLogs("segmenter", level="WARNING"):
            res = self._segment({"imageDataUrl": "data:image/png;base64,AAAA"})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json()["detail"], "Invalid image")

    def test_invalid_click_type_is_422(self) -> None:
        body = {
            "imageDataUrl": _data_url(_dark()),
            "clicks": [{"x": 1, "y": 1, "type": "maybe"}],
        }
        self.assertEqual(self._segment(body).status_code, 422)


class TestSegmentWithoutModels(_EndpointTestCase):
    def test_bright_square_uses_white_roof_heuristic(self) -> None:
        res = self._segment({"imageDataUrl": _data_url(_bright_square())})
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["source"], "white_roof_heuristic")
        debug = data["debug"]
        self.assertEqual(debug["sam"], False)
        self.assertEqual(debug["onnx"], False)
        self.assertEqual(debug["samError"], "SAM_CHECKPOINT not set")
        self.assertIsNone(debug["onnxError"])
        self.assertAlmostEqual(debug["whiteThr"], 0.42)
        self.assertAlmostEqual(
            data["confidence"], min(1.0, 0.15 + 0.85 * debug["meanWhite"])
        )
        ring = np.array(data["roofPolygon"]["coordinates"][0])
        self.assertEqual(data["roofPolygon"]["type"], "Polygon")
        # Square spans x 50..150 of 200 and y 40..120 of 160.
        np.testing.assert_allclose(ring[:, 0].min(), 0.25, atol=0.02)
        np.testing.assert_allclose(ring[:, 0].max(), 0.75, atol=0.02)
        np.testing.assert_allclose(ring[:, 1].min(), 0.25, atol=0.02)
        np.testing.assert_allclose(ring[:, 1].max(), 0.75, atol=0.02)

    def test_white_threshold_env_is_reported(self) -> None:
        with mock.patch.dict(os.environ, {"ROOFSEG_WHITE_THRESHOLD": "5"}):
            data = self._segment({"imageDataUrl": _data_url(_bright_square())}).json()
        self.assertEqual(data["source"], "white_roof_heuristic")
        self.assertAlmostEqual(data["debug"]["whiteThr"], 0.9)

    def test_dark_image_with_footprint_passes_footprint_through(self) -> None:
        body = {
            "imageDataUrl": _data_url(_dark()),
            "meta": {"osmFootprint": _FOOTPRINT},
        }
        res = self._segment(body)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["source"], "osm_footprint_passthrough")
        self.assertEqual(data["roofPolygon"], _FOOTPRINT)
        self.assertEqual(data["confidence"], 0.55)
        self.assertEqual(
            data["debug"],
            {
                "sam": False,
                "samError": "SAM_CHECKPOINT not set",
                "onnx": False,
                "onnxError": None,
            },
        )

    def test_dark_image_without_footprint_returns_fallback_rect(self) -> None:
        res = self._segment({"imageDataUrl": _data_url(_dark())})
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["source"], "fallback_rect")
        self.assertEqual(data["confidence"], 0.2)
        ring = data["roofPolygon"]["coordinates"][0]
        np.testing.assert_allclose(
            ring, [[0.32, 0.36], [0.68, 0.36], [0.68, 0.64], [0.32, 0.64]]
        )

    def test_non_roof_mode_skips_heuristic(self) -> None:
        body = {"imageDataUrl": _data_url(_bright_square()), "mode": "tree"}
        self.assertEqual(self._segment(body).json()["source"], "fallback_rect")

    def test_image_ref_is_accepted(self) -> None:
        data = self._segment({"imageRef": _data_url(_dark())}).json()
        self.assertEqual(data["source"], "fallback_rect")


class TestSegmentWithFakeModels(_EndpointTestCase):
    def test_onnx_stage(self) -> None:
        with mock.patch.object(main, "ONNX", _FakeOnnx()):
            data = self._segment({"imageDataUrl": _data_url(_bright_square())}).json()
        self.assertEqual(data["source"], "roofsat_onnx")
        debug = data["debug"]
        self.assertTrue(debug["onnx"])
        self.assertEqual(debug["thresholdBase"], 0.5)
        self.assertTrue(debug["thresholdSweep"])
        self.assertAlmostEqual(debug["whiteBoost"], 0.18)
        expected = 0.15 + 0.75 * debug["meanProb"] + 0.10 * debug["iou"]
        self.assertAlmostEqual(data["confidence"], min(1.0, expected))

    def test_sam_stage(self) -> None:
        with mock.patch.object(main, "SAM", _FakeSam()):
            data = self._segment({"imageDataUrl": _data_url(_bright_square())}).json()
        self.assertEqual(data["source"], "sam")
        self.assertAlmostEqual(data["debug"]["score"], 0.91, places=5)
        self.assertEqual(data["debug"]["iou"], 0.0)
        self.assertAlmostEqual(data["confidence"], 0.55 * 0.91, places=5)
        self.assertEqual(data["suggestedOrientationDeg"], 0.0)
        self.assertIsNone(data["suggestedAzimuthDeg"])
        self.assertTrue(all(c["id"].startswith("sam_") for c in data["candidates"]))

    def test_sam_error_falls_back_to_footprint(self) -> None:
        body = {
            "imageDataUrl": _data_url(_bright_square()),
            "meta": {"osmFootprint": _FOOTPRINT},
        }
        with mock.patch.object(main, "SAM", _FakeSam(fail=True)):
            with self.assertLogs("segmenter", level="WARNING"):
                data = self._segment(body).json()
        self.assertEqual(data["source"], "osm_footprint_after_sam_error")
        self.assertEqual(data["confidence"], 0.5)
        self.assertEqual(data["debug"], {"sam": True, "error": "sam exploded"})

    def test_sam_error_without_footprint_is_502(self) -> None:
        with mock.patch.object(main, "SAM", _FakeSam(fail=True)):
            with self.assertLogs("segmenter", level="WARNING"):
                res = self._segment({"imageDataUrl": _data_url(_bright_square())})
        self.assertEqual(res.status_code, 502)
        # The exception text is logged, never returned in `detail`.
        self.assertEqual(res.json()["detail"], "SAM inference failed")

    def test_sam_plane_split(self) -> None:
        body = {
            "imageDataUrl": _data_url(_gable()),
            "mode": "plane",
            "meta": {"osmFootprint": _FOOTPRINT},
        }
        with mock.patch.object(main, "SAM", _FakeSam()):
            data = self._segment(body).json()
        self.assertEqual(data["source"], "sam_plane_split")
        self.assertIsNotNone(data["suggestedAzimuthDeg"])
        ids = [c["id"] for c in data["candidates"]]
        self.assertIn("plane_1", ids)
        self.assertIn("plane_2", ids)
        # Regression: plane mode used to report the ridge-line pixel length as the
        # score, pinning confidence at 1.0. It must stay the 0..1 SAM score.
        self.assertLessEqual(data["debug"]["score"], 1.0)
        self.assertGreaterEqual(data["debug"]["score"], 0.0)
        self.assertLess(data["confidence"], 1.0)


if __name__ == "__main__":
    unittest.main()
