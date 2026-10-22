"""Per-request state shared by the segmentation stages."""

from dataclasses import dataclass
from typing import Any, Dict, Optional, Protocol, Sequence, Tuple

import numpy as np

from postprocess import (
    RoiBounds,
    clamp_roi_bounds,
    extract_geojson_ring,
    ring_norm_to_mask,
    white_roof_probability,
)

ROOF_MODES = ("roof", "building")
PLANE_MODES = ("plane", "roof_plane")
DEFAULT_MODE = "roof"


class ClickLike(Protocol):
    x: float
    y: float
    type: str


class SegmentFailure(Exception):
    """Raised by a stage when the request cannot be served (mapped to an HTTP error)."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class SegmentContext:
    img_bgr: np.ndarray
    w: int
    h: int
    cx: int
    cy: int
    has_click: bool
    clicks: Tuple[ClickLike, ...]
    mode: str
    meta: Dict[str, Any]
    footprint_mask: Optional[np.ndarray]
    roi_bounds: Optional[RoiBounds]
    white_prob: Optional[np.ndarray]

    @property
    def osm_footprint(self) -> Any:
        return self.meta.get("osmFootprint")

    @property
    def box(self) -> Optional[np.ndarray]:
        if self.roi_bounds is None:
            return None
        return np.array(self.roi_bounds, dtype=np.float32)


def _safe_white_prob(
    img_bgr: np.ndarray, roi_bounds: Optional[RoiBounds]
) -> Optional[np.ndarray]:
    try:
        return white_roof_probability(img_bgr, roi_bounds)
    except Exception:
        return None


def build_context(
    img_bgr: np.ndarray,
    clicks: Sequence[ClickLike],
    roi_xywh: Optional[Tuple[int, int, int, int]],
    mode: Optional[str],
    meta: Dict[str, Any],
) -> SegmentContext:
    """Derives click focus, footprint mask, ROI and white-roof prior for a request."""
    h, w = img_bgr.shape[:2]
    pos = next((c for c in clicks if c.type == "pos"), None)
    cx = int(round(pos.x)) if pos else w // 2
    cy = int(round(pos.y)) if pos else h // 2

    footprint_ring = extract_geojson_ring(meta.get("osmFootprint"))
    footprint_mask = ring_norm_to_mask(footprint_ring, w, h) if footprint_ring else None

    roi_bounds = clamp_roi_bounds(*roi_xywh, w, h) if roi_xywh is not None else None

    return SegmentContext(
        img_bgr=img_bgr,
        w=w,
        h=h,
        cx=cx,
        cy=cy,
        has_click=pos is not None,
        clicks=tuple(clicks),
        mode=(mode or DEFAULT_MODE).strip().lower(),
        meta=meta,
        footprint_mask=footprint_mask,
        roi_bounds=roi_bounds,
        white_prob=_safe_white_prob(img_bgr, roi_bounds),
    )


def footprint_response(
    ctx: SegmentContext, confidence: float, source: str, debug: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """Returns the forwarded OSM footprint as the roof polygon, if one was supplied."""
    if ctx.osm_footprint is None:
        return None
    return {
        "roofPolygon": ctx.osm_footprint,
        "confidence": confidence,
        "source": source,
        "debug": debug,
    }


def require_footprint_response(
    ctx: SegmentContext,
    confidence: float,
    source: str,
    debug: Dict[str, Any],
    error_detail: str,
) -> Dict[str, Any]:
    """Like ``footprint_response`` but raises a 502 failure when no footprint exists."""
    response = footprint_response(ctx, confidence, source, debug)
    if response is None:
        raise SegmentFailure(502, error_detail)
    return response
