"""Pure mask / GeoJSON post-processing helpers shared by the segmentation stages."""

import math
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

RoiBounds = Tuple[int, int, int, int]  # (x0, y0, x1, y1), exclusive upper bounds

FOOTPRINT_PAD_KERNEL = (9, 9)
SMOOTH_KERNEL = (7, 7)
CLICK_DISTANCE_OUTSIDE = 1e9


def extract_geojson_ring(poly: Any) -> Optional[List[Tuple[float, float]]]:
    """Returns the first ring of a GeoJSON Polygon/MultiPolygon as [(x, y), ...].

    Coordinates are expected to be normalized (0..1); a closing duplicate point is
    dropped.
    """
    if not poly or not isinstance(poly, dict):
        return None
    if poly.get("type") == "Feature" and isinstance(poly.get("geometry"), dict):
        return extract_geojson_ring(poly.get("geometry"))

    typ = poly.get("type")
    coords = poly.get("coordinates")
    if not isinstance(coords, list):
        return None

    ring: Any = None
    if typ == "Polygon" and len(coords) >= 1:
        ring = coords[0]
    elif (
        typ == "MultiPolygon"
        and len(coords) >= 1
        and isinstance(coords[0], list)
        and len(coords[0]) >= 1
    ):
        ring = coords[0][0]
    elif typ is None and len(coords) >= 3:
        # tolerate {coordinates:[[x,y],...]} without type
        ring = coords
    else:
        return None

    if not isinstance(ring, list):
        return None

    pts: List[Tuple[float, float]] = []
    for item in ring:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            return None
        x = float(item[0])
        y = float(item[1])
        pts.append((x, y))

    if (
        len(pts) >= 2
        and abs(pts[0][0] - pts[-1][0]) < 1e-9
        and abs(pts[0][1] - pts[-1][1]) < 1e-9
    ):
        pts.pop()
    return pts if len(pts) >= 3 else None


def ring_norm_to_mask(
    ring_norm: List[Tuple[float, float]], w: int, h: int
) -> np.ndarray:
    pts = np.array([[x * w, y * h] for (x, y) in ring_norm], dtype=np.float32)
    pts_i = np.round(pts).astype(np.int32)
    pts_i[:, 0] = np.clip(pts_i[:, 0], 0, w - 1)
    pts_i[:, 1] = np.clip(pts_i[:, 1], 0, h - 1)
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(mask, [pts_i], 1)
    return mask


def mask_iou(a: np.ndarray, b: np.ndarray) -> float:
    inter = float(np.logical_and(a, b).sum())
    union = float(np.logical_or(a, b).sum())
    return inter / union if union > 0 else 0.0


def keep_component(mask: np.ndarray, cx: int, cy: int) -> np.ndarray:
    m = (mask > 0).astype(np.uint8)
    n, labels, stats, centroids = cv2.connectedComponentsWithStats(m)
    if n <= 1:
        return m
    cx = int(np.clip(cx, 0, labels.shape[1] - 1))
    cy = int(np.clip(cy, 0, labels.shape[0] - 1))
    lab = int(labels[cy, cx])
    if lab != 0:
        return (labels == lab).astype(np.uint8)

    # Click is outside (or inside a hole). Choose the component whose centroid is
    # closest to the click. This is much more robust for courtyard-style apartment
    # roofs where the click often lands in the interior void.
    best_lab = 0
    best_d2 = 1e30
    best_area = -1
    for i in range(1, n):
        ccx, ccy = centroids[i]
        d2 = float(ccx - float(cx)) ** 2 + float(ccy - float(cy)) ** 2
        area = int(stats[i, cv2.CC_STAT_AREA])
        if d2 < best_d2 - 1e-9 or (abs(d2 - best_d2) <= 1e-9 and area > best_area):
            best_lab = i
            best_d2 = d2
            best_area = area

    return (labels == best_lab).astype(np.uint8) if best_lab != 0 else m


def mask_to_polygon_norm(mask: np.ndarray, w: int, h: int) -> Optional[Dict[str, Any]]:
    m = (mask > 0).astype(np.uint8)
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    cnt = max(contours, key=cv2.contourArea)
    if cv2.contourArea(cnt) < 20:
        return None

    peri = cv2.arcLength(cnt, True)
    eps = max(1.0, 0.0025 * peri)
    approx = cv2.approxPolyDP(cnt, eps, True)
    pts = (
        approx.reshape(-1, 2)
        if approx is not None and len(approx) >= 3
        else cnt.reshape(-1, 2)
    )
    if pts is None or len(pts) < 3:
        return None

    pts = pts.astype(np.float32)
    pts[:, 0] = np.clip(pts[:, 0] / float(w), 0.0, 1.0)
    pts[:, 1] = np.clip(pts[:, 1] / float(h), 0.0, 1.0)
    coords = [[float(x), float(y)] for (x, y) in pts]
    return {"type": "Polygon", "coordinates": [coords]}


def choose_component_by_footprint(
    mask: np.ndarray, footprint_mask: np.ndarray
) -> np.ndarray:
    """Pick the connected component with best IoU against the footprint.

    If no components exist, returns the input mask.
    """

    m = (mask > 0).astype(np.uint8)
    n, labels = cv2.connectedComponents(m)
    if n <= 1:
        return m

    best_lab = 0
    best_iou = -1.0
    for lab in range(1, n):
        cm = (labels == lab).astype(np.uint8)
        iou = mask_iou(cm, footprint_mask)
        if iou > best_iou:
            best_iou = iou
            best_lab = lab

    return (labels == best_lab).astype(np.uint8) if best_lab != 0 else m


def clamp_angle_90(deg: float) -> float:
    d = float(deg)
    while d > 90.0:
        d -= 180.0
    while d < -90.0:
        d += 180.0
    return d


def azimuth_from_vector(dx: float, dy: float) -> float:
    # dx: east, dy: south (image coords). North-up image.
    az = math.degrees(math.atan2(dx, -dy))
    az = (az + 360.0) % 360.0
    return float(az)


def clamp_roi_bounds(
    x: int, y: int, roi_w: int, roi_h: int, w: int, h: int
) -> Optional[RoiBounds]:
    """Clamps an (x, y, w, h) ROI to the image; returns None when it collapses."""
    x0 = int(np.clip(x, 0, w - 1))
    y0 = int(np.clip(y, 0, h - 1))
    x1 = int(np.clip(x + roi_w, 1, w))
    y1 = int(np.clip(y + roi_h, 1, h))
    if x1 > x0 and y1 > y0:
        return (x0, y0, x1, y1)
    return None


def roi_mask(
    h: int, w: int, roi_bounds: RoiBounds, dtype: Any = np.uint8
) -> np.ndarray:
    """Builds an (h, w) mask that is 1 inside ``roi_bounds`` and 0 elsewhere."""
    x0, y0, x1, y1 = roi_bounds
    mask = np.zeros((h, w), dtype=dtype)
    mask[y0:y1, x0:x1] = 1
    return mask


def intersect_masks(mask: np.ndarray, keep: np.ndarray) -> np.ndarray:
    """Returns the uint8 intersection of two masks (non-zero = inside)."""
    return (np.logical_and(mask > 0, keep > 0)).astype(np.uint8)


def pad_footprint(footprint_mask: np.ndarray) -> np.ndarray:
    """Dilates a footprint mask slightly to tolerate imagery/footprint misalignment."""
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, FOOTPRINT_PAD_KERNEL)
    return cv2.dilate(footprint_mask.astype(np.uint8), kernel, iterations=1)


def smooth_mask(mask: np.ndarray) -> np.ndarray:
    """Morphological close (x2) then open (x1) to fill gaps and drop speckles."""
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, SMOOTH_KERNEL)
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    return cv2.morphologyEx(closed, cv2.MORPH_OPEN, kernel, iterations=1)


def mask_centroid(mask: np.ndarray) -> Tuple[float, float]:
    ys, xs = np.where(mask > 0)
    if len(xs) == 0:
        return 0.0, 0.0
    return float(xs.mean()), float(ys.mean())


def click_distance_to_mask(
    mask: np.ndarray, cx: int, cy: int, has_click: bool
) -> float:
    """Pixel distance from the click to the mask (0 inside / when there is no click)."""
    if not has_click:
        return 0.0
    if not (0 <= cy < mask.shape[0] and 0 <= cx < mask.shape[1]):
        return CLICK_DISTANCE_OUTSIDE
    if bool(mask[cy, cx]):
        return 0.0
    inv = (mask == 0).astype(np.uint8)
    dist = cv2.distanceTransform(inv, cv2.DIST_L2, 3)
    return float(dist[cy, cx])


def white_roof_probability(
    img_bgr: np.ndarray, roi_bounds: Optional[RoiBounds]
) -> np.ndarray:
    """Soft "bright, low-saturation" prior in [0, 1] (helps on white flat roofs)."""
    h, w = img_bgr.shape[:2]
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
    sat = hsv[:, :, 1] / 255.0
    val = hsv[:, :, 2] / 255.0
    wp = np.clip((val - 0.55) / 0.45, 0.0, 1.0) * np.clip((0.35 - sat) / 0.35, 0.0, 1.0)
    wp = cv2.GaussianBlur(wp, (0, 0), 1.2).astype(np.float32)
    if roi_bounds is not None:
        wp = wp * roi_mask(h, w, roi_bounds, dtype=np.float32)
    return wp
