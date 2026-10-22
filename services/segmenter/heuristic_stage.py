"""Model-free fallbacks when SAM is unavailable: white roof, OSM footprint, rect."""

from typing import Any, Dict, Optional

import numpy as np

from env_config import env_float
from postprocess import (
    choose_component_by_footprint,
    intersect_masks,
    keep_component,
    mask_iou,
    mask_to_polygon_norm,
    pad_footprint,
    roi_mask,
    smooth_mask,
)
from segment_context import ROOF_MODES, SegmentContext, footprint_response

DEFAULT_WHITE_THRESHOLD = 0.42
MIN_FOOTPRINT_IOU = 0.08
MIN_WHITE_AREA = 60
RECT_HALF_WIDTH = 0.18
RECT_HALF_HEIGHT = 0.14


def _no_model_debug(
    sam_error: Optional[str], onnx_error: Optional[str]
) -> Dict[str, Any]:
    return {"sam": False, "samError": sam_error, "onnx": False, "onnxError": onnx_error}


def _white_roof_mask(
    ctx: SegmentContext, white_prob: np.ndarray, thr: float
) -> np.ndarray:
    m = (white_prob >= thr).astype(np.uint8)
    if ctx.roi_bounds is not None:
        m = intersect_masks(m, roi_mask(ctx.h, ctx.w, ctx.roi_bounds))

    # If we have a footprint and it overlaps, use it to disambiguate.
    if (
        ctx.footprint_mask is not None
        and mask_iou(m, ctx.footprint_mask) >= MIN_FOOTPRINT_IOU
    ):
        footprint_pad = pad_footprint(ctx.footprint_mask)
        m = choose_component_by_footprint(m, footprint_pad)
        m = intersect_masks(m, footprint_pad)

    return keep_component(m, ctx.cx, ctx.cy)


def _white_roof_response(
    ctx: SegmentContext, sam_error: Optional[str], onnx_error: Optional[str]
) -> Optional[Dict[str, Any]]:
    white_prob = ctx.white_prob
    if white_prob is None:
        return None
    thr_w = env_float("ROOFSEG_WHITE_THRESHOLD", DEFAULT_WHITE_THRESHOLD, 0.15, 0.9)
    m = _white_roof_mask(ctx, white_prob, thr_w)
    if int(m.sum()) < MIN_WHITE_AREA:
        return None

    m = smooth_mask(m)
    poly = mask_to_polygon_norm(m, ctx.w, ctx.h)
    if poly is None:
        return None

    mean_w = float(white_prob[m > 0].mean()) if int(m.sum()) > 0 else 0.0
    return {
        "roofPolygon": poly,
        "confidence": float(np.clip(0.15 + 0.85 * mean_w, 0.0, 1.0)),
        "source": "white_roof_heuristic",
        "debug": {
            **_no_model_debug(sam_error, onnx_error),
            "whiteThr": float(thr_w),
            "meanWhite": float(mean_w),
        },
    }


def run_white_roof_stage(
    ctx: SegmentContext, sam_error: Optional[str], onnx_error: Optional[str]
) -> Optional[Dict[str, Any]]:
    """Bright/white roof heuristic (useful when ONNX isn't configured)."""
    if ctx.mode not in ROOF_MODES or ctx.white_prob is None:
        return None
    try:
        return _white_roof_response(ctx, sam_error, onnx_error)
    except Exception:
        return None


def fallback_rect_polygon(ctx: SegmentContext) -> Dict[str, Any]:
    """Normalized rectangle around the focus point (last resort)."""
    w = float(ctx.w)
    h = float(ctx.h)
    rx0 = max(0.0, (ctx.cx - RECT_HALF_WIDTH * ctx.w) / w)
    ry0 = max(0.0, (ctx.cy - RECT_HALF_HEIGHT * ctx.h) / h)
    rx1 = min(1.0, (ctx.cx + RECT_HALF_WIDTH * ctx.w) / w)
    ry1 = min(1.0, (ctx.cy + RECT_HALF_HEIGHT * ctx.h) / h)
    return {
        "type": "Polygon",
        "coordinates": [[[rx0, ry0], [rx1, ry0], [rx1, ry1], [rx0, ry1]]],
    }


def run_without_sam(
    ctx: SegmentContext, sam_error: Optional[str], onnx_error: Optional[str]
) -> Dict[str, Any]:
    """Heuristic -> OSM footprint passthrough -> centered rectangle."""
    white = run_white_roof_stage(ctx, sam_error, onnx_error)
    if white is not None:
        return white

    debug = _no_model_debug(sam_error, onnx_error)
    passthrough = footprint_response(ctx, 0.55, "osm_footprint_passthrough", debug)
    if passthrough is not None:
        return passthrough

    return {
        "roofPolygon": fallback_rect_polygon(ctx),
        "confidence": 0.2,
        "source": "fallback_rect",
        "debug": debug,
    }
