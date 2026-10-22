"""SAM segmentation stage: prompt SAM, pick the best mask, constrain it, add hints."""

import logging
from dataclasses import dataclass, replace
from typing import Any, Dict, List, NamedTuple, Optional, Protocol, Sequence, Tuple

import cv2
import numpy as np

from geometry import dominant_angle, edge_lines
from plane_split import plane_azimuth, split_roof_plane
from postprocess import (
    click_distance_to_mask,
    intersect_masks,
    keep_component,
    mask_iou,
    mask_to_polygon_norm,
    pad_footprint,
    roi_mask,
    smooth_mask,
)
from segment_context import (
    PLANE_MODES,
    ClickLike,
    SegmentContext,
    SegmentFailure,
    footprint_response,
    require_footprint_response,
)

logger = logging.getLogger("segmenter")

MAX_CLICK_DISTANCE = 60.0
MIN_MASK_AREA = 30
MAX_SAM_CANDIDATES = 5


class SamPredictorLike(Protocol):
    model_type: Optional[str]
    device: Optional[str]

    def predict(
        self,
        image_rgb: np.ndarray,
        point_coords: Optional[np.ndarray],
        point_labels: Optional[np.ndarray],
        box: Optional[np.ndarray],
    ) -> Tuple[np.ndarray, np.ndarray]: ...


class MaskItem(NamedTuple):
    index: int
    mask: np.ndarray
    contains_click: bool
    score: float
    click_dist: float
    area: int
    mean_white: float


@dataclass(frozen=True)
class SamSelection:
    mask: np.ndarray
    sam_score: float
    iou: float


def sam_point_prompts(
    clicks: Sequence[ClickLike],
) -> Tuple[Optional[np.ndarray], Optional[np.ndarray]]:
    if not clicks:
        return None, None
    pts = [[float(c.x), float(c.y)] for c in clicks]
    labels = [1 if c.type == "pos" else 0 for c in clicks]
    return np.array(pts, dtype=np.float32), np.array(labels, dtype=np.int32)


def collect_mask_items(ctx: SegmentContext, masks: Any, scores: Any) -> List[MaskItem]:
    items: List[MaskItem] = []
    for i in range(len(masks)):
        m = masks[i]
        if m is None:
            continue
        m_u8 = (m > 0).astype(np.uint8)
        contains_click = False
        if 0 <= ctx.cy < m_u8.shape[0] and 0 <= ctx.cx < m_u8.shape[1]:
            contains_click = bool(m_u8[ctx.cy, ctx.cx])
        score = float(scores[i]) if i < len(scores) else 0.0
        dist = click_distance_to_mask(m_u8, ctx.cx, ctx.cy, ctx.has_click)
        area = int(m_u8.sum())
        mean_white = (
            float(ctx.white_prob[m_u8 > 0].mean())
            if (ctx.white_prob is not None and area > 0)
            else 0.0
        )
        items.append(MaskItem(i, m_u8, contains_click, score, dist, area, mean_white))
    return items


def rank_mask(item: MaskItem, has_click: bool) -> float:
    # If we don't have a click, do not penalize click distance.
    click_d = float(item.click_dist) if has_click else 0.0
    # Pool/water masks tend to be low "white"; roofs tend to be higher.
    return (
        1.05 * float(item.score)
        + 0.85 * float(item.mean_white)
        + 0.00022 * float(item.area)
        - 0.004 * float(min(click_d, 120.0))
    )


def pick_best_mask(
    items: List[MaskItem], footprint_mask: Optional[np.ndarray], has_click: bool
) -> Tuple[MaskItem, float]:
    """Best footprint IoU (ties: nearer click) with a footprint, else best rank."""
    best = items[0]
    best_iou = (
        mask_iou(best.mask, footprint_mask) if footprint_mask is not None else -1.0
    )
    best_rank = rank_mask(best, has_click)
    for it in items[1:]:
        if footprint_mask is not None:
            iou = mask_iou(it.mask, footprint_mask)
            if iou > best_iou + 1e-9 or (
                abs(iou - best_iou) <= 1e-9 and it.click_dist < best.click_dist
            ):
                best = it
                best_iou = iou
            continue
        r = rank_mask(it, has_click)
        if r > best_rank + 1e-9:
            best = it
            best_rank = r
    return best, best_iou


def _clip_to_footprint_and_roi(ctx: SegmentContext, mask: np.ndarray) -> np.ndarray:
    """Hard constraints: keep the mask on the address footprint and inside the ROI."""
    out = mask
    if ctx.footprint_mask is not None:
        out = intersect_masks(out, pad_footprint(ctx.footprint_mask))
    if ctx.roi_bounds is not None:
        out = intersect_masks(out, roi_mask(ctx.h, ctx.w, ctx.roi_bounds))
    return out


def sam_candidates(ctx: SegmentContext, items: List[MaskItem]) -> List[Dict[str, Any]]:
    """Candidate roof polygons from the alternate SAM masks."""
    try:
        candidates: List[Dict[str, Any]] = []
        for idx, it in enumerate(items[:MAX_SAM_CANDIDATES]):
            cm = _clip_to_footprint_and_roi(ctx, it.mask.astype(np.uint8))
            if int(cm.sum()) < MIN_MASK_AREA:
                continue
            poly = mask_to_polygon_norm(smooth_mask(cm), ctx.w, ctx.h)
            if poly is None:
                continue
            candidates.append(
                {"id": f"sam_{idx + 1}", "polygon": poly, "score": float(it.score)}
            )
        return candidates
    except Exception:
        return []


def _predict_items(
    ctx: SegmentContext, sam: SamPredictorLike
) -> Tuple[Optional[List[MaskItem]], Optional[Dict[str, Any]]]:
    """Runs SAM. Returns (items, None) or (None, footprint fallback response)."""
    img_rgb = cv2.cvtColor(ctx.img_bgr, cv2.COLOR_BGR2RGB)
    point_coords, point_labels = sam_point_prompts(ctx.clicks)
    try:
        masks, scores = sam.predict(
            img_rgb, point_coords=point_coords, point_labels=point_labels, box=ctx.box
        )
    except Exception as e:
        # Keep the app unblocked. The 502 detail stays generic; details go to logs.
        logger.warning("SAM inference failed", exc_info=True)
        debug = {"sam": True, "error": str(e)}
        detail = "SAM inference failed"
        return None, require_footprint_response(
            ctx, 0.5, "osm_footprint_after_sam_error", debug, detail
        )

    empty_source = "osm_footprint_after_empty_sam"
    if masks is None or len(masks) == 0:
        return None, require_footprint_response(
            ctx, 0.45, empty_source, {"sam": True}, "SAM returned no masks"
        )
    items = collect_mask_items(ctx, masks, scores)
    if not items:
        return None, require_footprint_response(
            ctx, 0.45, empty_source, {"sam": True}, "SAM returned no usable masks"
        )
    return items, None


def _select_mask(ctx: SegmentContext, items: List[MaskItem]) -> SamSelection:
    # First pass: require click proximity (when provided). Second pass: relax.
    filtered = [
        it
        for it in items
        if (
            not ctx.has_click
            or it.contains_click
            or it.click_dist <= MAX_CLICK_DISTANCE
        )
    ]
    chosen_item, best_iou = pick_best_mask(
        filtered if filtered else items, ctx.footprint_mask, ctx.has_click
    )
    chosen = keep_component(chosen_item.mask, ctx.cx, ctx.cy)
    chosen = _clip_to_footprint_and_roi(ctx, chosen)
    return SamSelection(mask=chosen, sam_score=float(chosen_item.score), iou=best_iou)


def _sam_debug(iou: float, score: float) -> Dict[str, Any]:
    return {"sam": True, "iou": max(iou, 0.0), "score": score}


@dataclass(frozen=True)
class RoofShape:
    """Final mask plus orientation hints for the SAM response."""

    mask: np.ndarray
    source: str
    score: float
    dominant_angle: Optional[float]
    orientation: Optional[float]
    azimuth: Optional[float]
    candidates: List[Dict[str, Any]]


def _shape_roof(
    ctx: SegmentContext,
    selection: SamSelection,
    candidates: List[Dict[str, Any]],
) -> RoofShape:
    """Orientation hint from dominant edges; optional gable plane split."""
    lines = edge_lines(ctx.img_bgr, selection.mask)
    dom = dominant_angle(lines)
    orientation = float(dom) if dom is not None else None
    shape = RoofShape(
        selection.mask, "sam", selection.sam_score, dom, orientation, None, candidates
    )
    # mode="roof" keeps the whole roof; plane modes split a gable into one plane.
    if ctx.mode not in PLANE_MODES or dom is None:
        return shape

    split = split_roof_plane(selection.mask, lines, dom, ctx.cx, ctx.cy)
    # Confidence stays based on the SAM score; the ridge-line score is a pixel
    # length and must not leak into `confidence` / `debug.score`.
    all_candidates = candidates + list(split.candidates)
    shape = replace(shape, candidates=all_candidates)
    if split.focus_mask is None or split.ridge is None or not all_candidates:
        return shape

    dom2 = dominant_angle(edge_lines(ctx.img_bgr, split.focus_mask))
    return replace(
        shape,
        mask=split.focus_mask,
        source="sam_plane_split",
        orientation=float(dom2) if dom2 is not None else orientation,
        azimuth=plane_azimuth(split.focus_mask, *split.ridge),
    )


def _final_response(
    ctx: SegmentContext,
    sam: SamPredictorLike,
    selection: SamSelection,
    candidates: List[Dict[str, Any]],
) -> Dict[str, Any]:
    shape = _shape_roof(ctx, selection, candidates)
    poly = mask_to_polygon_norm(shape.mask, ctx.w, ctx.h)
    if poly is None:
        return require_footprint_response(
            ctx,
            0.45,
            "osm_footprint_after_polygonize_fail",
            _sam_debug(selection.iou, shape.score),
            "Failed to polygonize mask",
        )

    conf = 0.55 * float(shape.score) + 0.45 * float(max(selection.iou, 0.0))
    return {
        "roofPolygon": poly,
        "confidence": float(np.clip(conf, 0.0, 1.0)),
        "source": shape.source,
        "suggestedOrientationDeg": shape.orientation,
        "suggestedAzimuthDeg": shape.azimuth,
        "candidates": shape.candidates if shape.candidates else None,
        "debug": {
            "sam": True,
            "modelType": sam.model_type,
            "device": sam.device,
            "score": shape.score,
            "iou": max(selection.iou, 0.0),
            "dominantAngle": shape.dominant_angle,
        },
    }


def run_sam_stage(ctx: SegmentContext, sam: SamPredictorLike) -> Dict[str, Any]:
    """Full SAM path. Raises ``SegmentFailure`` when no footprint fallback exists."""
    items, fallback = _predict_items(ctx, sam)
    if items is None:
        if fallback is None:
            raise SegmentFailure(502, "SAM returned no usable masks")
        return fallback

    selection = _select_mask(ctx, items)
    if int(selection.mask.sum()) < MIN_MASK_AREA:
        clip_empty = footprint_response(
            ctx,
            0.5,
            "osm_footprint_after_clip_empty",
            _sam_debug(selection.iou, selection.sam_score),
        )
        if clip_empty is not None:
            return clip_empty

    selection = replace(selection, mask=smooth_mask(selection.mask))
    return _final_response(ctx, sam, selection, sam_candidates(ctx, items))
