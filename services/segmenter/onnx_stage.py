"""ONNX (RoofSat) stage: threshold sweep + footprint/click-aware mask selection."""

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Protocol, Tuple

import cv2
import numpy as np

from env_config import env_enabled, env_float
from postprocess import (
    RoiBounds,
    choose_component_by_footprint,
    click_distance_to_mask,
    intersect_masks,
    keep_component,
    mask_iou,
    mask_to_polygon_norm,
    pad_footprint,
    roi_mask,
    smooth_mask,
)
from segment_context import SegmentContext

DEFAULT_WHITE_BOOST = 0.18
DEFAULT_THRESHOLD = 0.5
THRESHOLD_MIN = 0.05
THRESHOLD_MAX = 0.95
SWEEP_OFFSETS = (-0.08, -0.16, 0.08)
SWEEP_ABSOLUTE = (0.35, 0.45)
MIN_COMPONENT_AREA = 30
MIN_CANDIDATE_AREA = 260
MAX_CANDIDATES = 5


class RoofProbabilityModel(Protocol):
    def predict_prob(self, img_bgr: np.ndarray) -> np.ndarray: ...

    def predict_prob_roi(
        self, img_bgr: np.ndarray, roi_bounds: RoiBounds
    ) -> Tuple[np.ndarray, RoiBounds]: ...


@dataclass(frozen=True)
class ThresholdPick:
    score: float
    threshold: float
    iou: float
    mean_prob: float
    mask: np.ndarray
    candidate_mask: np.ndarray
    debug: Dict[str, Any]


def threshold_list(base: float, sweep: bool) -> List[float]:
    """Base threshold plus (optionally) a sweep; clamped, de-duplicated and sorted."""
    thresholds = [base]
    if sweep:
        thresholds.extend(base + offset for offset in SWEEP_OFFSETS)
        thresholds.extend(SWEEP_ABSOLUTE)
    clamped = [float(np.clip(t, THRESHOLD_MIN, THRESHOLD_MAX)) for t in thresholds]
    return sorted({round(t, 4) for t in clamped})


def _evaluate_threshold(
    ctx: SegmentContext,
    prob: np.ndarray,
    threshold: float,
    keep_mask: Optional[np.ndarray],
    footprint_pad: Optional[np.ndarray],
) -> Optional[ThresholdPick]:
    full_mask = (prob >= float(threshold)).astype(np.uint8)
    # Apply ROI early so candidate components stay within it.
    if keep_mask is not None:
        full_mask = intersect_masks(full_mask, keep_mask)

    chosen = full_mask
    iou = -1.0
    if ctx.footprint_mask is not None and footprint_pad is not None:
        chosen = choose_component_by_footprint(chosen, footprint_pad)
        iou = mask_iou(chosen, ctx.footprint_mask)
        chosen = intersect_masks(chosen, footprint_pad)

    # Keep a copy for candidate polygons (before the single-component selection).
    candidate_mask = chosen
    chosen = keep_component(chosen, ctx.cx, ctx.cy)
    area = int(chosen.sum())
    if area < MIN_COMPONENT_AREA:
        return None

    chosen = smooth_mask(chosen)
    if mask_to_polygon_norm(chosen, ctx.w, ctx.h) is None:
        return None

    mean_p = float(prob[chosen > 0].mean()) if area > 0 else 0.0
    click_d = click_distance_to_mask(chosen, ctx.cx, ctx.cy, ctx.has_click)
    score = (
        1.25 * mean_p + 0.55 * float(max(iou, 0.0)) - 0.006 * float(min(click_d, 120.0))
    )
    return ThresholdPick(
        score=score,
        threshold=float(threshold),
        iou=float(iou),
        mean_prob=float(mean_p),
        mask=chosen,
        candidate_mask=candidate_mask,
        debug={
            "threshold": float(threshold),
            "meanProb": float(mean_p),
            "iou": float(max(iou, 0.0)),
            "clickDist": float(click_d),
            "area": int(area),
        },
    )


def select_best_threshold(
    ctx: SegmentContext, prob: np.ndarray, thresholds: List[float]
) -> Optional[ThresholdPick]:
    """Scores each threshold's mask and keeps the first highest-scoring one."""
    keep_mask = (
        roi_mask(ctx.h, ctx.w, ctx.roi_bounds) if ctx.roi_bounds is not None else None
    )
    footprint_pad = (
        pad_footprint(ctx.footprint_mask) if ctx.footprint_mask is not None else None
    )
    best: Optional[ThresholdPick] = None
    for t in thresholds:
        pick = _evaluate_threshold(ctx, prob, t, keep_mask, footprint_pad)
        if pick is not None and (best is None or pick.score > best.score):
            best = pick
    return best


def onnx_candidates(
    ctx: SegmentContext, prob: np.ndarray, mask: np.ndarray
) -> List[Dict[str, Any]]:
    """Polygons for the largest connected components of the selected threshold mask."""
    try:
        ncc, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8))
        comps = []
        for lab in range(1, ncc):
            area = int(stats[lab, cv2.CC_STAT_AREA])
            if area >= MIN_CANDIDATE_AREA:
                comps.append((area, lab))
        comps.sort(reverse=True)

        candidates: List[Dict[str, Any]] = []
        for idx, (area, lab) in enumerate(comps[:MAX_CANDIDATES]):
            cm = (labels == lab).astype(np.uint8)
            poly = mask_to_polygon_norm(cm, ctx.w, ctx.h)
            if poly is None:
                continue
            mean_p = float(prob[cm > 0].mean()) if area > 0 else 0.0
            candidates.append({"id": f"cv_{idx + 1}", "polygon": poly, "score": mean_p})
        return candidates
    except Exception:
        return []


def _predict_prob(ctx: SegmentContext, model: RoofProbabilityModel) -> np.ndarray:
    if ctx.roi_bounds is not None:
        prob, _ = model.predict_prob_roi(ctx.img_bgr, ctx.roi_bounds)
        return prob
    return model.predict_prob(ctx.img_bgr)


def _segment_with_onnx(
    ctx: SegmentContext, model: RoofProbabilityModel
) -> Optional[Dict[str, Any]]:
    prob = _predict_prob(ctx, model)

    boost = env_float("ROOFSEG_WHITE_BOOST", DEFAULT_WHITE_BOOST, 0.0, 0.5)
    boosted = ctx.white_prob is not None and boost > 0
    if boosted:
        prob = np.clip(prob + boost * ctx.white_prob, 0.0, 1.0).astype(np.float32)

    thr = env_float(
        "ROOFSEG_THRESHOLD", DEFAULT_THRESHOLD, THRESHOLD_MIN, THRESHOLD_MAX
    )
    # Sweep a few thresholds to be robust to very bright (white) roofs.
    sweep = env_enabled("ROOFSEG_THRESHOLD_SWEEP", "1")
    best = select_best_threshold(ctx, prob, threshold_list(thr, sweep))
    if best is None:
        return None

    candidates = onnx_candidates(ctx, prob, best.candidate_mask)
    poly = mask_to_polygon_norm(best.mask, ctx.w, ctx.h)
    if poly is None:
        return None

    iou = float(max(best.iou, 0.0))
    conf = float(np.clip(0.15 + 0.75 * best.mean_prob + 0.10 * iou, 0.0, 1.0))
    return {
        "roofPolygon": poly,
        "confidence": conf,
        "source": "roofsat_onnx",
        "candidates": candidates if candidates else None,
        "debug": {
            "onnx": True,
            "threshold": float(best.threshold),
            "thresholdBase": float(thr),
            "thresholdSweep": bool(sweep),
            "whiteBoost": float(boost) if boosted else 0.0,
            "meanProb": float(best.mean_prob),
            "iou": iou,
            **best.debug,
        },
    }


def run_onnx_stage(
    ctx: SegmentContext, model: RoofProbabilityModel
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Returns (response, error). response is None when ONNX found no usable roof."""
    try:
        return _segment_with_onnx(ctx, model), None
    except Exception as e:
        return None, str(e)
