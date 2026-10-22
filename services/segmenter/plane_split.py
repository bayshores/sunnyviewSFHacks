"""Gable roof plane split: cut the roof mask along the ridge line, keep one plane."""

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

from geometry import LineSegment, Point, extend_segment_to_bounds
from postprocess import azimuth_from_vector, mask_centroid, mask_to_polygon_norm

RIDGE_ANGLE_TOLERANCE_DEG = 7.0
MAX_RIDGE_LINES = 40
RIDGE_CENTER_PENALTY = 0.25
NO_RIDGE_SCORE = -1e18
CUT_THICKNESS = 10
MIN_PLANE_AREA = 260
MIN_PLANE_FRACTION = 0.18


@dataclass(frozen=True)
class PlaneSplit:
    """Outcome of a split attempt.

    ``ridge_score`` is the score of the selected ridge line (``NO_RIDGE_SCORE``
    when none matched). ``focus_mask`` is None unless the roof was cut into >= 2
    large planes.
    """

    ridge_score: float
    candidates: Tuple[Dict[str, Any], ...]
    focus_mask: Optional[np.ndarray]
    ridge: Optional[Tuple[Point, Point]]


def best_ridge_line(
    lines: List[LineSegment], dom: float, mx: float, my: float
) -> Tuple[Optional[LineSegment], float]:
    """Longest line near the dominant angle, penalised by distance from the centroid."""
    best_line: Optional[LineSegment] = None
    best_score = NO_RIDGE_SCORE
    for x1, y1, x2, y2, length, ang in lines[:MAX_RIDGE_LINES]:
        if abs(float(ang) - float(dom)) > RIDGE_ANGLE_TOLERANCE_DEG:
            continue
        dist_c = math.hypot(0.5 * (x1 + x2) - mx, 0.5 * (y1 + y2) - my)
        score = float(length) - RIDGE_CENTER_PENALTY * float(dist_c)
        if score > best_score:
            best_score = score
            best_line = (x1, y1, x2, y2, float(length), float(ang))
    return best_line, best_score


def _large_components(
    chosen: np.ndarray, p_a: Point, p_b: Point
) -> Tuple[np.ndarray, List[Tuple[int, int]]]:
    """Cuts the mask along p_a-p_b; returns labels and [(area, label)] of big pieces."""
    cut = chosen.copy()
    cv2.line(cut, p_a, p_b, 0, thickness=CUT_THICKNESS)
    ncc, labels = cv2.connectedComponents((cut > 0).astype(np.uint8))
    if ncc < 3:
        return labels, []
    areas = sorted(
        ((int((labels == lab).sum()), lab) for lab in range(1, ncc)), reverse=True
    )
    total = int((chosen > 0).sum())
    min_area = max(MIN_PLANE_AREA, int(MIN_PLANE_FRACTION * total))
    return labels, [(a, lab) for (a, lab) in areas if a >= min_area]


def _focus_label(
    labels: np.ndarray, keep: List[Tuple[int, int]], cx: int, cy: int
) -> int:
    h, w = labels.shape[:2]
    focus = int(labels[int(np.clip(cy, 0, h - 1)), int(np.clip(cx, 0, w - 1))])
    if focus != 0:
        return focus
    # Choose the component whose centroid is closest to the focus point.
    best_lab = keep[0][1]
    best_d = 1e18
    for _, lab in keep[:3]:
        ccx, ccy = mask_centroid((labels == lab).astype(np.uint8))
        d = (ccx - cx) ** 2 + (ccy - cy) ** 2
        if d < best_d:
            best_d = d
            best_lab = lab
    return best_lab


def split_roof_plane(
    chosen: np.ndarray, lines: List[LineSegment], dom: float, cx: int, cy: int
) -> PlaneSplit:
    h, w = chosen.shape[:2]
    mx, my = mask_centroid(chosen)
    ridge_line, ridge_score = best_ridge_line(lines, dom, mx, my)
    if ridge_line is None:
        return PlaneSplit(ridge_score, (), None, None)

    x1, y1, x2, y2, _, _ = ridge_line
    p_a, p_b = extend_segment_to_bounds(int(x1), int(y1), int(x2), int(y2), w, h)
    labels, keep = _large_components(chosen, p_a, p_b)
    if len(keep) < 2:
        return PlaneSplit(ridge_score, (), None, (p_a, p_b))

    focus_lab = _focus_label(labels, keep, cx, cy)
    candidates: List[Dict[str, Any]] = []
    for idx, (_, lab) in enumerate(keep[:2]):
        poly = mask_to_polygon_norm((labels == lab).astype(np.uint8), w, h)
        if poly is not None:
            candidates.append(
                {"id": f"plane_{idx + 1}", "polygon": poly, "score": None}
            )
    focus_mask = (labels == focus_lab).astype(np.uint8)
    return PlaneSplit(ridge_score, tuple(candidates), focus_mask, (p_a, p_b))


def plane_azimuth(plane_mask: np.ndarray, p_a: Point, p_b: Point) -> Optional[float]:
    """Plane direction: normal to the ridge line, pointing to the plane centroid."""
    vx = float(p_b[0] - p_a[0])
    vy = float(p_b[1] - p_a[1])
    nx = -vy
    ny = vx
    ccx, ccy = mask_centroid(plane_mask)
    sign = (ccx - float(p_a[0])) * nx + (ccy - float(p_a[1])) * ny
    if sign < 0:
        nx = -nx
        ny = -ny
    if abs(nx) + abs(ny) > 1e-6:
        return azimuth_from_vector(nx, ny)
    return None
