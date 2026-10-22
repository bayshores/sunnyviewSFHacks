import unittest

import os
import sys

import cv2
import numpy as np

_SEGMENTER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _SEGMENTER_DIR not in sys.path:
    sys.path.insert(0, _SEGMENTER_DIR)

from geometry import dominant_angle, edge_lines, extend_segment_to_bounds


class TestEdgeLines(unittest.TestCase):
    def test_small_or_empty_mask_returns_no_lines(self) -> None:
        img = np.zeros((50, 50, 3), dtype=np.uint8)
        self.assertEqual(edge_lines(img, np.zeros((50, 50), np.uint8)), [])
        tiny = np.zeros((50, 50), dtype=np.uint8)
        tiny[0:7, 0:7] = 1  # 49 px < 50
        self.assertEqual(edge_lines(img, tiny), [])

    def test_detects_horizontal_ridge_in_full_image_coords(self) -> None:
        img = np.full((120, 160, 3), 40, dtype=np.uint8)
        img[30:90, 40:140] = 200
        img[30:60, 40:140] = 240
        cv2.line(img, (40, 60), (140, 60), (90, 90, 90), 2)
        mask = np.zeros((120, 160), dtype=np.uint8)
        mask[30:90, 40:140] = 1

        lines = edge_lines(img, mask)

        self.assertGreater(len(lines), 0)
        lengths = [seg[4] for seg in lines]
        self.assertEqual(lengths, sorted(lengths, reverse=True))
        x1, y1, x2, y2, length, ang = lines[0]
        self.assertGreaterEqual(length, 28.0)
        self.assertLess(abs(ang), 5.0)
        # Offsets are added back: the ridge sits around y=60 in the full image.
        self.assertTrue(any(abs(seg[1] - 60) <= 3 for seg in lines))
        self.assertTrue(all(-90.0 <= seg[5] <= 90.0 for seg in lines))


class TestDominantAngle(unittest.TestCase):
    def test_empty(self) -> None:
        self.assertIsNone(dominant_angle([]))

    def test_length_weighted_mean_of_strongest_bin(self) -> None:
        lines = [
            (0, 0, 1, 1, 100.0, 2.0),
            (0, 0, 1, 1, 50.0, -2.0),
            (0, 0, 1, 1, 30.0, 60.0),  # different bin, ignored
        ]
        self.assertAlmostEqual(dominant_angle(lines), (200.0 - 100.0) / 150.0)

    def test_neighbouring_bins_are_included(self) -> None:
        lines = [(0, 0, 1, 1, 100.0, 0.0), (0, 0, 1, 1, 100.0, 5.0)]
        self.assertAlmostEqual(dominant_angle(lines), 2.5)


class TestExtendSegment(unittest.TestCase):
    def test_horizontal_segment_spans_width(self) -> None:
        self.assertEqual(
            extend_segment_to_bounds(10, 20, 30, 20, w=100, h=50), ((0, 20), (99, 20))
        )

    def test_vertical_segment_spans_height(self) -> None:
        self.assertEqual(
            extend_segment_to_bounds(5, 10, 5, 20, w=100, h=50), ((5, 0), (5, 49))
        )

    def test_diagonal_segment_clipped_to_image(self) -> None:
        self.assertEqual(
            extend_segment_to_bounds(0, 0, 10, 10, w=100, h=50), ((0, 0), (49, 49))
        )

    def test_degenerate_segment_unchanged(self) -> None:
        self.assertEqual(
            extend_segment_to_bounds(3, 4, 3, 4, w=100, h=50), ((3, 4), (3, 4))
        )


if __name__ == "__main__":
    unittest.main()
