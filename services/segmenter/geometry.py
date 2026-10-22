"""Line / edge geometry helpers used for roof orientation hints and plane splitting."""

import math
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

from postprocess import clamp_angle_90

# (x1, y1, x2, y2, length, angleDeg in [-90, 90])
LineSegment = Tuple[int, int, int, int, float, float]
Point = Tuple[int, int]

MIN_MASK_PIXELS = 50
ROI_MARGIN = 10
ANGLE_BIN_DEG = 5.0


def _mask_bbox(mask: np.ndarray, w: int, h: int) -> Optional[Tuple[int, int, int, int]]:
    ys, xs = np.where(mask > 0)
    if len(xs) < MIN_MASK_PIXELS:
        return None
    x0 = int(max(0, xs.min() - ROI_MARGIN))
    x1 = int(min(w, xs.max() + ROI_MARGIN + 1))
    y0 = int(max(0, ys.min() - ROI_MARGIN))
    y1 = int(min(h, ys.max() + ROI_MARGIN + 1))
    return x0, y0, x1, y1


def edge_lines(img_bgr: np.ndarray, mask: np.ndarray) -> List[LineSegment]:
    """Returns Hough line segments inside ``mask``, longest first."""
    h, w = img_bgr.shape[:2]
    m = (mask > 0).astype(np.uint8)
    if int(m.sum()) < MIN_MASK_PIXELS:
        return []
    bbox = _mask_bbox(m, w, h)
    if bbox is None:
        return []
    x0, y0, x1, y1 = bbox

    gray = cv2.cvtColor(img_bgr[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 60, 150)
    edges = cv2.bitwise_and(edges, edges, mask=m[y0:y1, x0:x1])

    lines = cv2.HoughLinesP(
        edges, 1, np.pi / 180.0, threshold=45, minLineLength=28, maxLineGap=8
    )
    if lines is None:
        return []

    out: List[LineSegment] = []
    for line in lines.reshape(-1, 4):
        x1l, y1l, x2l, y2l = [int(v) for v in line]
        dx = float(x2l - x1l)
        dy = float(y2l - y1l)
        length = math.hypot(dx, dy)
        if length < 10:
            continue
        ang = clamp_angle_90(math.degrees(math.atan2(dy, dx)))
        out.append((x1l + x0, y1l + y0, x2l + x0, y2l + y0, length, ang))
    out.sort(key=lambda t: t[4], reverse=True)
    return out


def dominant_angle(lines: List[LineSegment]) -> Optional[float]:
    """Length-weighted mean angle of the strongest 5-degree bin (+-1 neighbour bin)."""
    if not lines:
        return None
    bins: Dict[int, float] = {}
    for *_, length, ang in lines:
        b = int(round(ang / ANGLE_BIN_DEG))
        bins[b] = bins.get(b, 0.0) + float(length)
    best_bin = max(bins.items(), key=lambda kv: kv[1])[0]
    num = 0.0
    den = 0.0
    for *_, length, ang in lines:
        b = int(round(ang / ANGLE_BIN_DEG))
        if abs(b - best_bin) <= 1:
            num += float(length) * float(ang)
            den += float(length)
    return clamp_angle_90(num / den) if den > 0 else None


def _farthest_pair(pts: List[Point]) -> Tuple[Point, Point]:
    best = (pts[0], pts[1])
    best_d = -1.0
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            d = (pts[i][0] - pts[j][0]) ** 2 + (pts[i][1] - pts[j][1]) ** 2
            if d > best_d:
                best_d = d
                best = (pts[i], pts[j])
    return best


def extend_segment_to_bounds(
    x1: int, y1: int, x2: int, y2: int, w: int, h: int
) -> Tuple[Point, Point]:
    """Extends a segment along its direction until it hits the image border."""
    dx = float(x2 - x1)
    dy = float(y2 - y1)
    if abs(dx) + abs(dy) < 1e-6:
        return (x1, y1), (x2, y2)
    # parametric line p = p0 + t*v, intersected with x=0, x=w-1, y=0, y=h-1
    ts: List[float] = []
    if abs(dx) > 1e-9:
        ts.append((0.0 - x1) / dx)
        ts.append(((w - 1) - x1) / dx)
    if abs(dy) > 1e-9:
        ts.append((0.0 - y1) / dy)
        ts.append(((h - 1) - y1) / dy)
    pts: List[Point] = []
    for t in ts:
        x = x1 + t * dx
        y = y1 + t * dy
        if -1e-6 <= x <= w - 1 + 1e-6 and -1e-6 <= y <= h - 1 + 1e-6:
            pts.append((int(round(x)), int(round(y))))
    if len(pts) < 2:
        return (x1, y1), (x2, y2)
    return _farthest_pair(pts)
