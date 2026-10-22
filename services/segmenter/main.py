# ruff: noqa: E402 -- OpenCV's pixel cap must be in the environment before cv2 loads.
import os

from image_limits import OPENCV_MAX_PIXELS_ENV, max_pixels

# OpenCV reads this once, when the cv2 extension is loaded. It backs up the
# header check in image_limits for formats that check does not parse.
os.environ.setdefault(OPENCV_MAX_PIXELS_ENV, str(max_pixels()))

import base64
import hmac
import logging
import re
from typing import Any, Dict, List, Literal, Optional

import cv2
import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

from body_limit import BodySizeLimitMiddleware
from env_config import env_truthy
from heuristic_stage import run_without_sam
from image_limits import (
    ImageTooLarge,
    check_data_url_length,
    check_pixel_count,
    image_dimensions,
    max_body_bytes,
)
from onnx_roofseg import OnnxRoofSeg
from onnx_stage import run_onnx_stage
from sam_model import SamState
from sam_stage import run_sam_stage
from segment_context import ROOF_MODES, SegmentFailure, build_context

SHARED_SECRET_ENV = "SEGMENT_SHARED_SECRET"
DEBUG_ENV = "SEGMENT_DEBUG"
# Shown by /healthz instead of raw model-load errors unless SEGMENT_DEBUG=1.
REDACTED_ERROR = "unavailable"

logger = logging.getLogger("segmenter")

app = FastAPI(title="sunnyview-segmenter", version="0.2.0")
app.add_middleware(BodySizeLimitMiddleware, max_bytes=max_body_bytes)


class Click(BaseModel):
    x: float
    y: float
    type: Literal["pos", "neg"]


class Roi(BaseModel):
    x: int
    y: int
    w: int
    h: int


class SegmentRequest(BaseModel):
    imageDataUrl: Optional[str] = None
    imageRef: Optional[str] = None
    mode: Optional[str] = "roof"
    clicks: Optional[List[Click]] = None
    roi: Optional[Roi] = None
    meta: Optional[Dict[str, Any]] = None


def _decode_data_url(s: str) -> bytes:
    check_data_url_length(s)
    m = re.match(r"^data:[^;]+;base64,(.*)$", s, flags=re.IGNORECASE | re.DOTALL)
    if not m:
        raise ValueError("invalid data URL")
    return base64.b64decode(m.group(1))


def _decode_image_bgr(img_bytes: bytes) -> np.ndarray:
    # Reject decompression bombs from the header before OpenCV allocates pixels.
    dims = image_dimensions(img_bytes)
    if dims is not None:
        check_pixel_count(*dims)
    buf = np.frombuffer(img_bytes, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("failed to decode image")
    # Formats without a parsed header (WebP, BMP, TIFF, ...) are checked here.
    h, w = img.shape[:2]
    check_pixel_count(w, h)
    return img


def _load_request_image(req: SegmentRequest) -> np.ndarray:
    data_url = (req.imageDataUrl or req.imageRef or "").strip()
    if not data_url:
        raise HTTPException(status_code=400, detail="Provide imageDataUrl or imageRef")
    try:
        return _decode_image_bgr(_decode_data_url(data_url))
    except ImageTooLarge as e:
        logger.warning("Rejected oversized image: %s", e)
        raise HTTPException(status_code=413, detail="Image too large") from e
    except Exception as e:
        logger.warning("Rejected invalid image: %s: %s", type(e).__name__, e)
        raise HTTPException(status_code=400, detail="Invalid image") from e


def require_shared_secret(
    x_segment_secret: Optional[str] = Header(default=None),
) -> None:
    """When SEGMENT_SHARED_SECRET is set, requires a matching x-segment-secret."""
    expected = os.getenv(SHARED_SECRET_ENV, "").strip()
    if not expected:
        return
    provided = (x_segment_secret or "").encode("utf-8")
    if not hmac.compare_digest(provided, expected.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _public_error(error: Optional[str], debug: bool) -> Optional[str]:
    if debug or error is None:
        return error
    return REDACTED_ERROR


SAM = SamState()
ONNX = OnnxRoofSeg()


@app.get("/healthz")
def healthz() -> Dict[str, Any]:
    sam_ready = SAM.ensure_loaded()
    onnx_ready = ONNX.ensure_loaded()
    # Raw errors and model paths can expose filesystem layout; opt in to see them.
    debug = env_truthy(DEBUG_ENV)
    return {
        "ok": True,
        "onnx": {
            "ready": onnx_ready,
            "error": _public_error(ONNX.error, debug),
            "path": ONNX.path if debug else None,
            "inputSize": ONNX.size if onnx_ready else None,
        },
        "sam": {
            "ready": sam_ready,
            "error": _public_error(SAM.error, debug),
            "modelType": SAM.model_type,
            "device": SAM.device,
        },
    }


@app.post("/segment", dependencies=[Depends(require_shared_secret)])
def segment(req: SegmentRequest) -> Dict[str, Any]:
    """ONNX (if configured) -> SAM (if configured) -> heuristic / footprint / rect."""
    img_bgr = _load_request_image(req)
    roi = (req.roi.x, req.roi.y, req.roi.w, req.roi.h) if req.roi else None
    ctx = build_context(img_bgr, req.clicks or [], roi, req.mode, req.meta or {})

    onnx_error: Optional[str] = None
    if ctx.mode in ROOF_MODES and ONNX.ensure_loaded():
        response, onnx_error = run_onnx_stage(ctx, ONNX)
        if response is not None:
            return response

    # If SAM isn't ready, still return something usable (heuristic / footprint / rect).
    if not SAM.ensure_loaded():
        return run_without_sam(ctx, SAM.error, onnx_error or ONNX.error)

    try:
        return run_sam_stage(ctx, SAM)
    except SegmentFailure as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail) from e
