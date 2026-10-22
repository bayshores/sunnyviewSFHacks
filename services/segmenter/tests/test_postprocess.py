import unittest

import os
import sys

import numpy as np

_SEGMENTER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _SEGMENTER_DIR not in sys.path:
    sys.path.insert(0, _SEGMENTER_DIR)

from postprocess import (
    CLICK_DISTANCE_OUTSIDE,
    azimuth_from_vector,
    choose_component_by_footprint,
    clamp_angle_90,
    clamp_roi_bounds,
    click_distance_to_mask,
    extract_geojson_ring,
    intersect_masks,
    keep_component,
    mask_centroid,
    mask_iou,
    mask_to_polygon_norm,
    pad_footprint,
    ring_norm_to_mask,
    roi_mask,
    smooth_mask,
    white_roof_probability,
)


class TestPostprocess(unittest.TestCase):
    def test_extract_geojson_ring_polygon(self) -> None:
        poly = {
            "type": "Polygon",
            "coordinates": [
                [
                    [0.1, 0.2],
                    [0.9, 0.2],
                    [0.9, 0.8],
                    [0.1, 0.8],
                    [0.1, 0.2],
                ]
            ],
        }
        ring = extract_geojson_ring(poly)
        self.assertIsNotNone(ring)
        assert ring is not None
        self.assertEqual(len(ring), 4)

    def test_ring_to_mask(self) -> None:
        ring = [(0.2, 0.2), (0.8, 0.2), (0.8, 0.8), (0.2, 0.8)]
        m = ring_norm_to_mask(ring, w=100, h=100)
        self.assertEqual(m.shape, (100, 100))
        self.assertGreater(int(m.sum()), 1000)

    def test_choose_component_by_footprint(self) -> None:
        # Two components; footprint overlaps the right one.
        m = np.zeros((64, 64), dtype=np.uint8)
        m[10:20, 10:20] = 1
        m[40:55, 40:55] = 1
        footprint = np.zeros((64, 64), dtype=np.uint8)
        footprint[42:54, 42:54] = 1
        chosen = choose_component_by_footprint(m, footprint)
        self.assertGreater(int(chosen[45:50, 45:50].sum()), 5)
        self.assertEqual(int(chosen[12:18, 12:18].sum()), 0)

    def test_mask_to_polygon_norm(self) -> None:
        m = np.zeros((80, 120), dtype=np.uint8)
        m[20:60, 30:100] = 1
        poly = mask_to_polygon_norm(m, w=120, h=80)
        self.assertIsNotNone(poly)
        assert poly is not None
        self.assertEqual(poly.get("type"), "Polygon")
        coords = poly.get("coordinates")
        self.assertTrue(isinstance(coords, list))

    def test_keep_component_click_in_hole_prefers_nearest(self) -> None:
        # Courtyard-style roof: click lands in a hole inside the roof mask.
        m = np.zeros((160, 160), dtype=np.uint8)

        # Large far-away component (would be selected by "largest" fallback).
        # Keep a 2px gap to avoid 8-connectivity diagonal merging.
        m[0:58, 0:58] = 1

        # Donut component around the click.
        m[70:110, 70:110] = 1
        m[80:100, 80:100] = 0

        chosen = keep_component(m, cx=90, cy=90)

        # Should pick the donut, not the far-away block.
        self.assertEqual(int(chosen[10:40, 10:40].sum()), 0)
        self.assertGreater(int(chosen[72:108, 72:108].sum()), 200)


class TestRuntimeHelperRegression(unittest.TestCase):
    """Pins behaviour of helpers that main.py used to duplicate privately.

    main.py now imports these from postprocess, so these tests guard production.
    """

    def test_extract_geojson_ring_feature_multipolygon(self) -> None:
        feature = {
            "type": "Feature",
            "geometry": {
                "type": "MultiPolygon",
                "coordinates": [[[[0.1, 0.1], [0.5, 0.1], [0.5, 0.5]]]],
            },
        }
        self.assertEqual(
            extract_geojson_ring(feature), [(0.1, 0.1), (0.5, 0.1), (0.5, 0.5)]
        )

    def test_extract_geojson_ring_typeless_and_invalid(self) -> None:
        typeless = {"coordinates": [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]}
        self.assertEqual(len(extract_geojson_ring(typeless) or []), 3)
        self.assertIsNone(extract_geojson_ring(None))
        self.assertIsNone(extract_geojson_ring({"type": "Point", "coordinates": [1]}))
        bad_point = {"type": "Polygon", "coordinates": [[[0.1, 0.1], [0.2]]]}
        self.assertIsNone(extract_geojson_ring(bad_point))
        # Closed ring with only two distinct points is not a polygon.
        closed = {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [0, 0]]]}
        self.assertIsNone(extract_geojson_ring(closed))

    def test_ring_to_mask_clips_out_of_range_points(self) -> None:
        m = ring_norm_to_mask([(-1.0, -1.0), (2.0, -1.0), (2.0, 2.0)], w=20, h=10)
        self.assertEqual(m.shape, (10, 20))
        self.assertEqual(int(m.max()), 1)

    def test_mask_iou(self) -> None:
        a = np.zeros((10, 10), dtype=np.uint8)
        b = np.zeros((10, 10), dtype=np.uint8)
        self.assertEqual(mask_iou(a, b), 0.0)
        a[0:5, 0:10] = 1
        b[0:10, 0:5] = 1
        self.assertAlmostEqual(mask_iou(a, b), 25.0 / 75.0)

    def test_keep_component_click_inside_component(self) -> None:
        m = np.zeros((50, 50), dtype=np.uint8)
        m[5:15, 5:15] = 1
        m[30:45, 30:45] = 1
        chosen = keep_component(m, cx=10, cy=10)
        self.assertEqual(int(chosen.sum()), 100)
        # Out-of-bounds click is clamped to the image.
        chosen_far = keep_component(m, cx=999, cy=999)
        self.assertEqual(int(chosen_far.sum()), 225)

    def test_mask_to_polygon_norm_rejects_tiny_masks(self) -> None:
        m = np.zeros((40, 40), dtype=np.uint8)
        m[10:13, 10:13] = 1
        self.assertIsNone(mask_to_polygon_norm(m, w=40, h=40))
        self.assertIsNone(mask_to_polygon_norm(np.zeros((5, 5), np.uint8), 5, 5))

    def test_mask_to_polygon_norm_rectangle_coords(self) -> None:
        m = np.zeros((100, 100), dtype=np.uint8)
        m[20:60, 10:90] = 1
        poly = mask_to_polygon_norm(m, w=100, h=100)
        assert poly is not None
        ring = poly["coordinates"][0]
        self.assertEqual(len(ring), 4)
        xs = sorted({round(p[0], 2) for p in ring})
        ys = sorted({round(p[1], 2) for p in ring})
        self.assertEqual(xs, [0.1, 0.89])
        self.assertEqual(ys, [0.2, 0.59])

    def test_clamp_angle_90(self) -> None:
        self.assertEqual(clamp_angle_90(90.0), 90.0)
        self.assertEqual(clamp_angle_90(-90.0), -90.0)
        self.assertEqual(clamp_angle_90(135.0), -45.0)
        self.assertEqual(clamp_angle_90(-135.0), 45.0)
        self.assertEqual(clamp_angle_90(450.0), 90.0)

    def test_azimuth_from_vector(self) -> None:
        # Image coords: +x east, +y south.
        self.assertAlmostEqual(azimuth_from_vector(0.0, -1.0), 0.0)
        self.assertAlmostEqual(azimuth_from_vector(1.0, 0.0), 90.0)
        self.assertAlmostEqual(azimuth_from_vector(0.0, 1.0), 180.0)
        self.assertAlmostEqual(azimuth_from_vector(-1.0, 0.0), 270.0)


class TestMaskHelpers(unittest.TestCase):
    def test_clamp_roi_bounds(self) -> None:
        self.assertEqual(clamp_roi_bounds(10, 5, 20, 30, w=100, h=50), (10, 5, 30, 35))
        self.assertEqual(
            clamp_roi_bounds(-5, -5, 500, 500, w=100, h=50), (0, 0, 100, 50)
        )
        # Fully outside: collapses onto the last pixel row/column (legacy behaviour).
        self.assertEqual(
            clamp_roi_bounds(500, 500, 10, 10, w=100, h=50), (99, 49, 100, 50)
        )
        self.assertIsNone(clamp_roi_bounds(10, 10, 0, 5, w=100, h=50))
        self.assertIsNone(clamp_roi_bounds(10, 10, 5, -3, w=100, h=50))

    def test_roi_mask(self) -> None:
        m = roi_mask(10, 20, (2, 3, 7, 8))
        self.assertEqual(m.dtype, np.uint8)
        self.assertEqual(int(m.sum()), 25)
        self.assertEqual(int(m[3, 2]), 1)
        self.assertEqual(int(m[8, 7]), 0)
        mf = roi_mask(10, 20, (0, 0, 20, 10), dtype=np.float32)
        self.assertEqual(mf.dtype, np.float32)
        self.assertEqual(float(mf.sum()), 200.0)

    def test_intersect_masks(self) -> None:
        a = np.array([[0, 2, 3]], dtype=np.uint8)
        b = np.array([[1, 0, 9]], dtype=np.uint8)
        out = intersect_masks(a, b)
        self.assertEqual(out.dtype, np.uint8)
        self.assertEqual(out.tolist(), [[0, 0, 1]])

    def test_pad_footprint_grows_mask(self) -> None:
        m = np.zeros((30, 30), dtype=np.uint8)
        m[10:20, 10:20] = 1
        padded = pad_footprint(m)
        self.assertGreater(int(padded.sum()), int(m.sum()))
        self.assertEqual(int(padded[15, 6]), 1)  # 4px outside the edge
        self.assertEqual(int(padded[15, 4]), 0)  # 6px outside the edge

    def test_smooth_mask_fills_gap_and_drops_speckle(self) -> None:
        m = np.zeros((60, 60), dtype=np.uint8)
        m[10:40, 10:40] = 1
        m[25, 10:40] = 0  # thin crack
        m[55, 55] = 1  # speckle
        out = smooth_mask(m)
        self.assertEqual(int(out[25, 25]), 1)
        self.assertEqual(int(out[55, 55]), 0)

    def test_mask_centroid(self) -> None:
        m = np.zeros((10, 10), dtype=np.uint8)
        self.assertEqual(mask_centroid(m), (0.0, 0.0))
        m[2:4, 6:8] = 1
        self.assertEqual(mask_centroid(m), (6.5, 2.5))

    def test_click_distance_to_mask(self) -> None:
        m = np.zeros((20, 20), dtype=np.uint8)
        m[5:10, 5:10] = 1
        self.assertEqual(click_distance_to_mask(m, 7, 7, has_click=True), 0.0)
        self.assertEqual(click_distance_to_mask(m, 15, 15, has_click=False), 0.0)
        self.assertEqual(
            click_distance_to_mask(m, 50, 7, has_click=True), CLICK_DISTANCE_OUTSIDE
        )
        self.assertAlmostEqual(
            click_distance_to_mask(m, 14, 7, has_click=True), 5.0, delta=0.5
        )

    def test_white_roof_probability(self) -> None:
        img = np.full((40, 60, 3), 30, dtype=np.uint8)
        img[10:30, 10:30] = 250  # white roof
        img[10:30, 35:55] = (0, 0, 250)  # bright but saturated (red)
        wp = white_roof_probability(img, None)
        self.assertEqual(wp.shape, (40, 60))
        self.assertEqual(wp.dtype, np.float32)
        self.assertGreater(float(wp[20, 20]), 0.9)
        self.assertLess(float(wp[20, 45]), 0.05)
        self.assertLess(float(wp[2, 2]), 0.05)

        cropped = white_roof_probability(img, (0, 0, 15, 40))
        self.assertGreater(float(cropped[20, 12]), 0.5)
        self.assertEqual(float(cropped[20, 20]), 0.0)


if __name__ == "__main__":
    unittest.main()
