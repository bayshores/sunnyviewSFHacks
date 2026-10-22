import asyncio
import base64
import importlib.util
import os
import struct
import sys
import unittest
import zlib
from typing import Any, Dict, List
from unittest import mock

import cv2
import numpy as np

_SEGMENTER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _SEGMENTER_DIR not in sys.path:
    sys.path.insert(0, _SEGMENTER_DIR)

from env_config import env_int, env_truthy  # noqa: E402
from image_limits import (  # noqa: E402
    PNG_SIGNATURE,
    ImageTooLarge,
    check_pixel_count,
    image_dimensions,
    max_body_bytes,
)

_HAS_DEPS = all(
    importlib.util.find_spec(name) is not None
    for name in ("fastapi", "httpx", "pydantic")
)

if _HAS_DEPS:
    from fastapi.testclient import TestClient

    import main
    from body_limit import BodySizeLimitMiddleware
    from onnx_roofseg import OnnxRoofSeg
    from sam_model import SamState

_ENV_VARS = (
    "ROOFSEG_ONNX_PATH",
    "SAM_CHECKPOINT",
    "SAM_MODEL_TYPE",
    "SEGMENT_SHARED_SECRET",
    "SEGMENT_DEBUG",
    "SEGMENT_MAX_DATA_URL_CHARS",
    "SEGMENT_MAX_PIXELS",
    "SEGMENT_MAX_BODY_BYTES",
)


def _png_header_only(width: int, height: int) -> bytes:
    """Signature + IHDR chunk: enough to declare dimensions, no pixel data."""
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    chunk = b"IHDR" + ihdr
    crc = struct.pack(">I", zlib.crc32(chunk) & 0xFFFFFFFF)
    return PNG_SIGNATURE + struct.pack(">I", len(ihdr)) + chunk + crc


def _jpeg_segment(marker: int, payload: bytes) -> bytes:
    return bytes((0xFF, marker)) + struct.pack(">H", len(payload) + 2) + payload


def _sof_payload(width: int, height: int) -> bytes:
    # precision, height, width, 3 components (id, sampling, quant table).
    comps = b"\x01\x11\x00\x02\x11\x01\x03\x11\x01"
    return struct.pack(">BHHB", 8, height, width, 3) + comps


def _data_url(raw: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")


def _png_data_url(img_bgr: np.ndarray) -> str:
    ok, buf = cv2.imencode(".png", img_bgr)
    assert ok
    return _data_url(buf.tobytes())


def _small_image() -> np.ndarray:
    return np.full((40, 50, 3), 20, dtype=np.uint8)


class TestImageDimensions(unittest.TestCase):
    def test_png_ihdr(self) -> None:
        self.assertEqual(
            image_dimensions(_png_header_only(30000, 20000)), (30000, 20000)
        )

    def test_png_from_opencv(self) -> None:
        ok, buf = cv2.imencode(".png", np.zeros((37, 53, 3), dtype=np.uint8))
        self.assertTrue(ok)
        self.assertEqual(image_dimensions(buf.tobytes()), (53, 37))

    def test_jpeg_baseline_from_opencv(self) -> None:
        ok, buf = cv2.imencode(".jpg", np.zeros((61, 83, 3), dtype=np.uint8))
        self.assertTrue(ok)
        self.assertEqual(image_dimensions(buf.tobytes()), (83, 61))

    def test_jpeg_progressive_sof2_after_app_segments(self) -> None:
        data = (
            b"\xff\xd8"
            + _jpeg_segment(0xE0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")
            + _jpeg_segment(0xE1, b"Exif\x00\x00" + b"\x00" * 64)
            + b"\xff\xff"  # fill bytes before the next marker are legal
            + _jpeg_segment(0xC2, _sof_payload(40000, 30000))
        )
        self.assertEqual(image_dimensions(data), (40000, 30000))

    def test_jpeg_skips_dht_marker(self) -> None:
        # 0xC4 (DHT) sits in the SOF range but carries no frame size.
        data = (
            b"\xff\xd8"
            + _jpeg_segment(0xC4, b"\x00" * 20)
            + _jpeg_segment(0xC0, _sof_payload(640, 480))
        )
        self.assertEqual(image_dimensions(data), (640, 480))

    def test_jpeg_scan_before_frame_is_unknown(self) -> None:
        data = b"\xff\xd8" + _jpeg_segment(0xDA, b"\x00" * 10)
        self.assertIsNone(image_dimensions(data))

    def test_truncated_and_unknown_inputs(self) -> None:
        self.assertIsNone(image_dimensions(b""))
        self.assertIsNone(image_dimensions(PNG_SIGNATURE + b"\x00\x00"))
        self.assertIsNone(image_dimensions(b"\xff\xd8\xff\xc0\x00\x11\x08"))
        self.assertIsNone(image_dimensions(b"BM" + b"\x00" * 60))
        self.assertIsNone(image_dimensions(b"RIFF\x00\x00\x00\x00WEBPVP8 "))

    def test_zero_height_jpeg_is_unknown(self) -> None:
        data = b"\xff\xd8" + _jpeg_segment(0xC0, _sof_payload(640, 0))
        self.assertIsNone(image_dimensions(data))

    def test_check_pixel_count_uses_env_limit(self) -> None:
        with mock.patch.dict(os.environ, {"SEGMENT_MAX_PIXELS": "100"}):
            check_pixel_count(10, 10)
            with self.assertRaises(ImageTooLarge):
                check_pixel_count(10, 11)


class TestEnvHelpers(unittest.TestCase):
    def test_env_int(self) -> None:
        with mock.patch.dict(os.environ, {"SEG_TEST_INT": " 250 "}):
            self.assertEqual(env_int("SEG_TEST_INT", 5, 1, 1000), 250)
        with mock.patch.dict(os.environ, {"SEG_TEST_INT": "abc"}):
            self.assertEqual(env_int("SEG_TEST_INT", 5, 1, 1000), 5)
        with mock.patch.dict(os.environ, {"SEG_TEST_INT": "-3"}):
            self.assertEqual(env_int("SEG_TEST_INT", 5, 1, 1000), 1)
        with mock.patch.dict(os.environ, {"SEG_TEST_INT": "99999"}):
            self.assertEqual(env_int("SEG_TEST_INT", 5, 1, 1000), 1000)

    def test_env_truthy(self) -> None:
        for raw, expected in (("1", True), ("yes", True), ("0", False), ("x", False)):
            with mock.patch.dict(os.environ, {"SEG_TEST_FLAG": raw}):
                self.assertIs(env_truthy("SEG_TEST_FLAG"), expected)

    def test_body_limit_defaults_to_data_url_limit_plus_headroom(self) -> None:
        env = {"SEGMENT_MAX_DATA_URL_CHARS": "1000"}
        with mock.patch.dict(os.environ, env):
            os.environ.pop("SEGMENT_MAX_BODY_BYTES", None)
            self.assertEqual(max_body_bytes(), 4_001_000)


@unittest.skipUnless(_HAS_DEPS, "fastapi/httpx/pydantic not installed")
class _SecurityTestCase(unittest.TestCase):
    def setUp(self) -> None:
        patches = [
            mock.patch.dict(os.environ),  # restores the environment afterwards
            mock.patch.object(main, "SAM", SamState()),
            mock.patch.object(main, "ONNX", OnnxRoofSeg()),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        for name in _ENV_VARS:
            os.environ.pop(name, None)
        self.client = TestClient(main.app)

    def _segment(self, body: Dict[str, Any], **kwargs: Any) -> Any:
        return self.client.post("/segment", json=body, **kwargs)


class TestInputLimits(_SecurityTestCase):
    def test_data_url_over_char_limit_is_413(self) -> None:
        url = _png_data_url(_small_image())
        os.environ["SEGMENT_MAX_DATA_URL_CHARS"] = str(len(url) - 1)
        with self.assertLogs("segmenter", level="WARNING"):
            res = self._segment({"imageDataUrl": url})
        self.assertEqual(res.status_code, 413)
        self.assertEqual(res.json()["detail"], "Image too large")

    def test_data_url_at_char_limit_is_accepted(self) -> None:
        url = _png_data_url(_small_image())
        os.environ["SEGMENT_MAX_DATA_URL_CHARS"] = str(len(url))
        res = self._segment({"imageDataUrl": url})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["source"], "fallback_rect")

    def test_png_declaring_huge_dimensions_is_413_without_decoding(self) -> None:
        url = _data_url(_png_header_only(30000, 30000))
        with mock.patch.object(main.cv2, "imdecode") as imdecode:
            with self.assertLogs("segmenter", level="WARNING"):
                res = self._segment({"imageDataUrl": url})
        self.assertEqual(res.status_code, 413)
        self.assertEqual(res.json()["detail"], "Image too large")
        imdecode.assert_not_called()

    def test_jpeg_declaring_huge_dimensions_is_413(self) -> None:
        raw = b"\xff\xd8" + _jpeg_segment(0xC0, _sof_payload(65000, 65000))
        with self.assertLogs("segmenter", level="WARNING"):
            res = self._segment({"imageDataUrl": _data_url(raw, "image/jpeg")})
        self.assertEqual(res.status_code, 413)

    def test_unparsed_format_is_checked_after_decode(self) -> None:
        ok, buf = cv2.imencode(".bmp", _small_image())
        self.assertTrue(ok)
        os.environ["SEGMENT_MAX_PIXELS"] = "1000"  # image is 50x40 = 2000 px
        with self.assertLogs("segmenter", level="WARNING"):
            res = self._segment({"imageDataUrl": _data_url(buf.tobytes(), "image/bmp")})
        self.assertEqual(res.status_code, 413)

    def test_body_over_limit_is_413(self) -> None:
        os.environ["SEGMENT_MAX_BODY_BYTES"] = "512"
        res = self._segment({"imageDataUrl": "data:image/png;base64," + "A" * 600})
        self.assertEqual(res.status_code, 413)
        self.assertEqual(res.json()["detail"], "Request body too large")
        # Small bodies and GETs are unaffected.
        self.assertEqual(self.client.get("/healthz").status_code, 200)


@unittest.skipUnless(_HAS_DEPS, "fastapi/httpx/pydantic not installed")
class TestBodySizeLimitMiddleware(unittest.TestCase):
    """Chunked bodies without Content-Length are counted as they stream in."""

    def _run(self, chunks: List[bytes], limit: int) -> Dict[str, Any]:
        reached_app: List[bytes] = []

        async def app(scope: Any, receive: Any, send: Any) -> None:
            body = b""
            while True:
                message = await receive()
                body += message.get("body", b"")
                if not message.get("more_body", False):
                    break
            reached_app.append(body)
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"ok"})

        incoming = [
            {"type": "http.request", "body": c, "more_body": i < len(chunks) - 1}
            for i, c in enumerate(chunks)
        ]
        sent: List[Dict[str, Any]] = []

        async def receive() -> Dict[str, Any]:
            return incoming.pop(0) if incoming else {"type": "http.disconnect"}

        async def send(message: Dict[str, Any]) -> None:
            sent.append(message)

        scope = {"type": "http", "method": "POST", "path": "/segment", "headers": []}
        middleware = BodySizeLimitMiddleware(app, max_bytes=lambda: limit)
        asyncio.run(middleware(scope, receive, send))
        return {"status": sent[0]["status"], "app_body": reached_app}

    def test_streamed_body_over_limit_is_413(self) -> None:
        result = self._run([b"a" * 60, b"b" * 60], limit=100)
        self.assertEqual(result["status"], 413)
        self.assertEqual(result["app_body"], [])

    def test_streamed_body_within_limit_is_replayed(self) -> None:
        result = self._run([b"a" * 40, b"b" * 60], limit=100)
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["app_body"], [b"a" * 40 + b"b" * 60])


class TestErrorDetails(_SecurityTestCase):
    def test_decode_error_detail_is_generic_and_logged(self) -> None:
        with self.assertLogs("segmenter", level="WARNING") as logs:
            res = self._segment({"imageDataUrl": "data:image/png;base64,AAAA"})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json(), {"detail": "Invalid image"})
        self.assertIn("failed to decode image", "\n".join(logs.output))

    def test_bad_base64_detail_is_generic(self) -> None:
        with self.assertLogs("segmenter", level="WARNING"):
            res = self._segment({"imageDataUrl": "data:image/png;base64,A"})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.json(), {"detail": "Invalid image"})


class TestHealthzRedaction(_SecurityTestCase):
    def _missing_model_path(self) -> str:
        return os.path.abspath(os.path.join(_SEGMENTER_DIR, "no-such-model.onnx"))

    def test_errors_and_paths_redacted_by_default(self) -> None:
        os.environ["ROOFSEG_ONNX_PATH"] = self._missing_model_path()
        os.environ["SAM_CHECKPOINT"] = self._missing_model_path() + ".pth"
        data = self.client.get("/healthz").json()
        self.assertEqual(
            data["onnx"],
            {"ready": False, "error": "unavailable", "path": None, "inputSize": None},
        )
        self.assertEqual(data["sam"]["error"], "unavailable")
        self.assertNotIn(_SEGMENTER_DIR, str(data))

    def test_debug_flag_restores_raw_errors(self) -> None:
        missing = self._missing_model_path()
        os.environ["ROOFSEG_ONNX_PATH"] = missing
        os.environ["SEGMENT_DEBUG"] = "1"
        data = self.client.get("/healthz").json()
        self.assertEqual(
            data["onnx"]["error"], f"ROOFSEG_ONNX_PATH not found: {missing}"
        )
        self.assertEqual(data["sam"]["error"], "SAM_CHECKPOINT not set")

    def test_ready_model_keeps_input_size_but_hides_path(self) -> None:
        onnx = OnnxRoofSeg()
        onnx.ready = True
        onnx.path = "/srv/models/roofsat.onnx"
        onnx.size = 384
        with mock.patch.object(main, "ONNX", onnx):
            data = self.client.get("/healthz").json()
            self.assertEqual(
                data["onnx"],
                {"ready": True, "error": None, "path": None, "inputSize": 384},
            )
            os.environ["SEGMENT_DEBUG"] = "1"
            debug_data = self.client.get("/healthz").json()
        self.assertEqual(debug_data["onnx"]["path"], "/srv/models/roofsat.onnx")


class TestSharedSecret(_SecurityTestCase):
    def _body(self) -> Dict[str, Any]:
        return {"imageDataUrl": _png_data_url(_small_image())}

    def test_no_secret_configured_allows_requests(self) -> None:
        self.assertEqual(self._segment(self._body()).status_code, 200)

    def test_missing_or_wrong_header_is_401(self) -> None:
        os.environ["SEGMENT_SHARED_SECRET"] = "s3cret-value"
        missing = self._segment(self._body())
        self.assertEqual(missing.status_code, 401)
        self.assertEqual(missing.json(), {"detail": "Unauthorized"})
        wrong = self._segment(self._body(), headers={"x-segment-secret": "nope"})
        self.assertEqual(wrong.status_code, 401)

    def test_matching_header_is_200(self) -> None:
        os.environ["SEGMENT_SHARED_SECRET"] = "s3cret-value"
        res = self._segment(self._body(), headers={"X-Segment-Secret": "s3cret-value"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["source"], "fallback_rect")

    def test_unauthorized_request_does_not_decode_image(self) -> None:
        os.environ["SEGMENT_SHARED_SECRET"] = "s3cret-value"
        with mock.patch.object(main, "_load_request_image") as load:
            res = self._segment(self._body())
        self.assertEqual(res.status_code, 401)
        load.assert_not_called()

    def test_healthz_stays_open(self) -> None:
        os.environ["SEGMENT_SHARED_SECRET"] = "s3cret-value"
        self.assertEqual(self.client.get("/healthz").status_code, 200)


if __name__ == "__main__":
    unittest.main()
