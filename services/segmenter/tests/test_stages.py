import unittest
from types import SimpleNamespace
from typing import List

import os
import sys

import numpy as np

_SEGMENTER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _SEGMENTER_DIR not in sys.path:
    sys.path.insert(0, _SEGMENTER_DIR)

from heuristic_stage import fallback_rect_polygon
from onnx_stage import threshold_list
from plane_split import (
    NO_RIDGE_SCORE,
    best_ridge_line,
    plane_azimuth,
    split_roof_plane,
)
from sam_stage import MaskItem, pick_best_mask, rank_mask, sam_point_prompts
from segment_context import build_context


def _click(x: float, y: float, kind: str) -> SimpleNamespace:
    return SimpleNamespace(x=x, y=y, type=kind)


def _item(
    index: int, mask: np.ndarray, score: float, click_dist: float = 0.0
) -> MaskItem:
    return MaskItem(index, mask, True, score, click_dist, int(mask.sum()), 0.0)


class TestBuildContext(unittest.TestCase):
    def test_defaults_without_clicks_roi_or_footprint(self) -> None:
        img = np.zeros((40, 60, 3), dtype=np.uint8)
        ctx = build_context(img, [], None, None, {})
        self.assertEqual((ctx.w, ctx.h, ctx.cx, ctx.cy), (60, 40, 30, 20))
        self.assertFalse(ctx.has_click)
        self.assertEqual(ctx.mode, "roof")
        self.assertIsNone(ctx.footprint_mask)
        self.assertIsNone(ctx.roi_bounds)
        self.assertIsNone(ctx.box)
        self.assertIsNotNone(ctx.white_prob)

    def test_first_positive_click_roi_and_footprint(self) -> None:
        img = np.zeros((40, 60, 3), dtype=np.uint8)
        clicks = [_click(1, 1, "neg"), _click(10.6, 12.4, "pos"), _click(50, 30, "pos")]
        footprint = {"type": "Polygon", "coordinates": [[[0, 0], [0.5, 0], [0.5, 0.5]]]}
        ctx = build_context(
            img, clicks, (5, 5, 20, 20), " Plane ", {"osmFootprint": footprint}
        )
        self.assertEqual((ctx.cx, ctx.cy), (11, 12))
        self.assertTrue(ctx.has_click)
        self.assertEqual(ctx.mode, "plane")
        self.assertEqual(ctx.roi_bounds, (5, 5, 25, 25))
        assert ctx.box is not None
        self.assertEqual(ctx.box.tolist(), [5.0, 5.0, 25.0, 25.0])
        assert ctx.footprint_mask is not None
        self.assertEqual(ctx.footprint_mask.shape, (40, 60))
        self.assertIs(ctx.osm_footprint, footprint)


class TestFallbackRect(unittest.TestCase):
    def test_centered_rect_is_clamped(self) -> None:
        img = np.zeros((100, 100, 3), dtype=np.uint8)
        centred = fallback_rect_polygon(build_context(img, [], None, "roof", {}))
        ring = centred["coordinates"][0]
        np.testing.assert_allclose(ring[0], [0.32, 0.36])
        np.testing.assert_allclose(ring[2], [0.68, 0.64])

        corner = build_context(img, [_click(0, 0, "pos")], None, "roof", {})
        ring = fallback_rect_polygon(corner)["coordinates"][0]
        np.testing.assert_allclose(ring[0], [0.0, 0.0])
        np.testing.assert_allclose(ring[2], [0.18, 0.14])


class TestOnnxThresholds(unittest.TestCase):
    def test_no_sweep(self) -> None:
        self.assertEqual(threshold_list(0.5, False), [0.5])

    def test_sweep_is_sorted_unique_and_rounded(self) -> None:
        self.assertEqual(threshold_list(0.5, True), [0.34, 0.35, 0.42, 0.45, 0.5, 0.58])

    def test_sweep_clamps_low_values(self) -> None:
        self.assertEqual(threshold_list(0.1, True), [0.05, 0.1, 0.18, 0.35, 0.45])


class TestSamSelection(unittest.TestCase):
    def test_point_prompts(self) -> None:
        self.assertEqual(sam_point_prompts([]), (None, None))
        coords, labels = sam_point_prompts([_click(1, 2, "pos"), _click(3, 4, "neg")])
        assert coords is not None and labels is not None
        self.assertEqual(coords.dtype, np.float32)
        self.assertEqual(coords.tolist(), [[1.0, 2.0], [3.0, 4.0]])
        self.assertEqual(labels.tolist(), [1, 0])

    def test_rank_ignores_click_distance_without_click(self) -> None:
        m = np.ones((2, 2), dtype=np.uint8)
        item = MaskItem(0, m, False, 0.5, 100.0, 4, 0.2)
        self.assertAlmostEqual(rank_mask(item, has_click=False), 0.525 + 0.17 + 0.00088)
        self.assertAlmostEqual(
            rank_mask(item, has_click=True), 0.525 + 0.17 + 0.00088 - 0.4
        )

    def test_pick_best_prefers_footprint_iou(self) -> None:
        footprint = np.zeros((20, 20), dtype=np.uint8)
        footprint[5:15, 5:15] = 1
        off = np.zeros((20, 20), dtype=np.uint8)
        off[0:4, 0:4] = 1
        on = footprint.copy()
        items: List[MaskItem] = [_item(0, off, 0.99), _item(1, on, 0.1)]
        best, iou = pick_best_mask(items, footprint, has_click=False)
        self.assertEqual(best.index, 1)
        self.assertAlmostEqual(iou, 1.0)

    def test_pick_best_iou_tie_prefers_nearer_click(self) -> None:
        footprint = np.zeros((20, 20), dtype=np.uint8)
        footprint[5:15, 5:15] = 1
        items = [
            _item(0, footprint.copy(), 0.9, click_dist=10.0),
            _item(1, footprint.copy(), 0.1, click_dist=2.0),
        ]
        best, _ = pick_best_mask(items, footprint, has_click=True)
        self.assertEqual(best.index, 1)

    def test_pick_best_without_footprint_uses_rank(self) -> None:
        m = np.ones((4, 4), dtype=np.uint8)
        items = [_item(0, m, 0.2), _item(1, m, 0.8), _item(2, m, 0.5)]
        best, iou = pick_best_mask(items, None, has_click=False)
        self.assertEqual(best.index, 1)
        self.assertEqual(iou, -1.0)


class TestPlaneSplit(unittest.TestCase):
    def _roof(self) -> np.ndarray:
        mask = np.zeros((100, 100), dtype=np.uint8)
        mask[20:80, 20:80] = 1
        return mask

    def test_best_ridge_line_filters_by_angle(self) -> None:
        lines = [(20, 50, 79, 50, 59.0, 0.0), (20, 20, 20, 79, 59.0, 90.0)]
        line, score = best_ridge_line(lines, 0.0, 50.0, 50.0)
        self.assertEqual(line, lines[0])
        self.assertAlmostEqual(score, 59.0 - 0.25 * 0.5)
        none_line, none_score = best_ridge_line(lines, 45.0, 50.0, 50.0)
        self.assertIsNone(none_line)
        self.assertEqual(none_score, NO_RIDGE_SCORE)

    def test_split_picks_plane_containing_focus(self) -> None:
        lines = [(20, 50, 79, 50, 59.0, 0.0)]
        split = split_roof_plane(self._roof(), lines, 0.0, cx=50, cy=30)
        assert split.focus_mask is not None and split.ridge is not None
        self.assertEqual(split.ridge, ((0, 50), (99, 50)))
        self.assertEqual([c["id"] for c in split.candidates], ["plane_1", "plane_2"])
        self.assertEqual(int(split.focus_mask[30, 50]), 1)
        self.assertEqual(int(split.focus_mask[70, 50]), 0)
        # Top plane faces north (0 deg), bottom plane faces south (180 deg).
        self.assertAlmostEqual(plane_azimuth(split.focus_mask, *split.ridge), 0.0)
        bottom = np.zeros_like(split.focus_mask)
        bottom[60:80, 20:80] = 1
        self.assertAlmostEqual(plane_azimuth(bottom, *split.ridge), 180.0)

    def test_split_without_matching_ridge(self) -> None:
        split = split_roof_plane(self._roof(), [], 0.0, cx=50, cy=50)
        self.assertIsNone(split.focus_mask)
        self.assertIsNone(split.ridge)
        self.assertEqual(split.candidates, ())
        self.assertEqual(split.ridge_score, NO_RIDGE_SCORE)

    def test_split_rejects_small_pieces(self) -> None:
        # Ridge near the edge leaves one tiny piece -> no focus plane.
        lines = [(20, 24, 79, 24, 59.0, 0.0)]
        split = split_roof_plane(self._roof(), lines, 0.0, cx=50, cy=50)
        self.assertIsNone(split.focus_mask)
        self.assertIsNotNone(split.ridge)


if __name__ == "__main__":
    unittest.main()
