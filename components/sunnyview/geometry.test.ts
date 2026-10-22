import { describe, expect, it } from "vitest";
import { packPanelsDeterministic } from "@/components/PanelPacking";
import type { Point } from "@/components/PanelPacking";
import {
  asRecord,
  bestRoofAlignedPackingOrientationDeg,
  candidateRefinement,
  clampAngle90,
  coerceNumber,
  computePanelFit,
  normAxis90,
  normAzimuth360,
  normalizePolygon,
  polygonDominantEdgeAxisDeg,
  roofPackingKey,
} from "./geometry";

const SPEC = { widthM: 1.1, heightM: 1.7, wattW: 400, gapM: 0.02 };

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

function rotate(pts: Point[], deg: number, cx = 0, cy = 0): Point[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return pts.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
  });
}

describe("coerceNumber", () => {
  it("accepts finite numbers and numeric strings", () => {
    expect(coerceNumber(3.5)).toBe(3.5);
    expect(coerceNumber("-118.24")).toBe(-118.24);
    expect(coerceNumber("")).toBe(0);
  });

  it("rejects non-finite and non-numeric input", () => {
    expect(coerceNumber(NaN)).toBeNull();
    expect(coerceNumber(Infinity)).toBeNull();
    expect(coerceNumber("abc")).toBeNull();
    expect(coerceNumber(null)).toBeNull();
    expect(coerceNumber(undefined)).toBeNull();
    expect(coerceNumber({})).toBeNull();
  });
});

describe("asRecord", () => {
  it("returns plain objects only", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1, 2])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord("x")).toBeNull();
  });
});

describe("angle helpers", () => {
  it("clampAngle90 wraps into [-90, 90]", () => {
    expect(clampAngle90(0)).toBe(0);
    expect(clampAngle90(90)).toBe(90);
    expect(clampAngle90(-90)).toBe(-90);
    expect(clampAngle90(91)).toBe(-89);
    expect(clampAngle90(135)).toBe(-45);
    expect(clampAngle90(-135)).toBe(45);
    expect(clampAngle90(450)).toBe(90);
  });

  it("normAxis90 folds into [0, 90)", () => {
    expect(normAxis90(0)).toBe(0);
    expect(normAxis90(90)).toBe(0);
    expect(normAxis90(100)).toBe(10);
    expect(normAxis90(-10)).toBe(80);
    expect(normAxis90(-180) + 0).toBe(0); // -180 % 90 is -0; numerically zero
    expect(normAxis90(359)).toBeCloseTo(89);
  });

  it("normAzimuth360 folds into [0, 360)", () => {
    expect(normAzimuth360(0)).toBe(0);
    expect(normAzimuth360(360)).toBe(0);
    expect(normAzimuth360(-90)).toBe(270);
    expect(normAzimuth360(725)).toBe(5);
  });
});

describe("polygonDominantEdgeAxisDeg", () => {
  it("returns 0 for degenerate polygons", () => {
    expect(polygonDominantEdgeAxisDeg([])).toBe(0);
    expect(polygonDominantEdgeAxisDeg([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe(0);
  });

  it("returns 0 when every edge is too short to count", () => {
    expect(polygonDominantEdgeAxisDeg(rect(0, 0, 2, 2))).toBe(0);
  });

  it("is ~0 for an axis-aligned rectangle", () => {
    const axis = polygonDominantEdgeAxisDeg(rect(0, 0, 200, 100));
    expect(Math.min(axis, 90 - axis)).toBeLessThan(1e-6);
  });

  it("recovers the rotation of a rotated rectangle", () => {
    expect(polygonDominantEdgeAxisDeg(rotate(rect(0, 0, 200, 100), 30))).toBeCloseTo(30, 6);
    expect(polygonDominantEdgeAxisDeg(rotate(rect(0, 0, 200, 100), -20))).toBeCloseTo(70, 6);
  });
});

describe("bestRoofAlignedPackingOrientationDeg", () => {
  it("returns an orientation near the roof axis or its perpendicular", () => {
    const polygon = rect(0, 0, 400, 260);
    const deg = bestRoofAlignedPackingOrientationDeg({ polygon, mPerPx: 0.05, panelSpec: SPEC, axisDeg: 0 });
    const nearAxis = Math.abs(deg) <= 2;
    const nearPerp = Math.abs(Math.abs(deg) - 90) <= 2;
    expect(nearAxis || nearPerp).toBe(true);
  });

  it("never packs fewer panels than the plain axis orientation", () => {
    const polygon = rotate(rect(0, 0, 400, 260), 25, 200, 130);
    const mPerPx = 0.05;
    const deg = bestRoofAlignedPackingOrientationDeg({ polygon, mPerPx, panelSpec: SPEC, axisDeg: 25 });
    const count = (orientationDeg: number) =>
      packPanelsDeterministic({ usablePolygon: polygon, mPerPx, panel: SPEC, orientationDeg }).length;
    expect(count(deg)).toBeGreaterThanOrEqual(count(25));
    expect(count(deg)).toBeGreaterThanOrEqual(count(clampAngle90(115)));
  });

  it("is deterministic", () => {
    const polygon = rotate(rect(0, 0, 300, 200), 12, 150, 100);
    const opts = { polygon, mPerPx: 0.06, panelSpec: SPEC, axisDeg: 12 };
    expect(bestRoofAlignedPackingOrientationDeg(opts)).toBe(bestRoofAlignedPackingOrientationDeg(opts));
  });
});

describe("computePanelFit", () => {
  it("reports count, DC kW, and the chosen orientation consistently", () => {
    const polygon = rect(0, 0, 400, 260);
    const fit = computePanelFit(polygon, 0.05, SPEC, 0);
    const count = packPanelsDeterministic({
      usablePolygon: polygon,
      mPerPx: 0.05,
      panel: SPEC,
      orientationDeg: fit.orientationDeg,
    }).length;
    expect(fit.panelCount).toBe(count);
    expect(fit.panelCount).toBeGreaterThan(0);
    expect(fit.dcKw).toBeCloseTo((count * SPEC.wattW) / 1000);
  });
});

describe("roofPackingKey", () => {
  it("rounds area to 0.1 m2 and mPerPx to micro-units", () => {
    expect(roofPackingKey(123.456, 4, 0.0512345678)).toBe("roof:123.5:4:51235");
    expect(roofPackingKey(null, 0, 0.1)).toBe("roof:0:0:100000");
  });
});

describe("normalizePolygon", () => {
  const W = 1040;
  const H = 720;
  const square = [
    [10, 20],
    [110, 20],
    [110, 120],
    [10, 120],
  ];

  it("parses an array of [x, y] pairs in pixel space unchanged", () => {
    expect(normalizePolygon(square, W, H)).toEqual([
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 120 },
      { x: 10, y: 120 },
    ]);
  });

  it("parses {x, y} objects and numeric strings", () => {
    const pts = [
      { x: "10", y: "20" },
      { x: 30, y: 20 },
      { x: 30, y: 40 },
    ];
    expect(normalizePolygon(pts, W, H)).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 20 },
      { x: 30, y: 40 },
    ]);
  });

  it("scales normalized [0, 1] coordinates to pixels", () => {
    const ring = [
      [0, 0],
      [0.5, 0],
      [0.5, 0.25],
    ];
    expect(normalizePolygon(ring, W, H)).toEqual([
      { x: 0, y: 0 },
      { x: 520, y: 0 },
      { x: 520, y: 180 },
    ]);
  });

  it("drops a duplicated closing point", () => {
    const closed = [...square, [10, 20]];
    expect(normalizePolygon(closed, W, H)).toHaveLength(4);
  });

  it("reads GeoJSON Polygon, MultiPolygon, Feature, and typeless coordinates", () => {
    const expected = normalizePolygon(square, W, H);
    expect(normalizePolygon({ type: "Polygon", coordinates: [square] }, W, H)).toEqual(expected);
    expect(normalizePolygon({ type: "MultiPolygon", coordinates: [[square]] }, W, H)).toEqual(expected);
    expect(
      normalizePolygon({ type: "Feature", geometry: { type: "Polygon", coordinates: [square] } }, W, H),
    ).toEqual(expected);
    expect(normalizePolygon({ coordinates: square }, W, H)).toEqual(expected);
  });

  it("unwraps roofPolygon / polygon / usablePolygon wrappers", () => {
    const expected = normalizePolygon(square, W, H);
    expect(normalizePolygon({ roofPolygon: square }, W, H)).toEqual(expected);
    expect(normalizePolygon({ polygon: { type: "Polygon", coordinates: [square] } }, W, H)).toEqual(expected);
    expect(normalizePolygon({ usablePolygon: square }, W, H)).toEqual(expected);
  });

  it("scales normalized GeoJSON rings too", () => {
    const ring = [
      [0.1, 0.1],
      [0.2, 0.1],
      [0.2, 0.2],
      [0.1, 0.1],
    ];
    const pts = normalizePolygon({ type: "Polygon", coordinates: [ring] }, 1000, 500);
    expect(pts).toHaveLength(3);
    expect(pts?.[1]).toEqual({ x: 200, y: 50 });
  });

  it("returns null for invalid input", () => {
    expect(normalizePolygon(null, W, H)).toBeNull();
    expect(normalizePolygon(undefined, W, H)).toBeNull();
    expect(normalizePolygon("nope", W, H)).toBeNull();
    expect(normalizePolygon(42, W, H)).toBeNull();
    expect(normalizePolygon({}, W, H)).toBeNull();
    expect(normalizePolygon([], W, H)).toBeNull();
    expect(normalizePolygon([[1, 2], [3, 4]], W, H)).toBeNull();
    expect(normalizePolygon([[1, 2], [3, "x"], [5, 6]], W, H)).toBeNull();
    expect(normalizePolygon([[1, 2], 7, [5, 6]], W, H)).toBeNull();
    expect(normalizePolygon([[1], [3, 4], [5, 6]], W, H)).toBeNull();
    expect(normalizePolygon({ type: "Polygon", coordinates: [] }, W, H)).toBeNull();
    expect(normalizePolygon({ type: "Polygon", coordinates: [[]] }, W, H)).toBeNull();
  });

  it("does not fall back to wrappers when a GeoJSON ring is present but invalid", () => {
    const data = { type: "Polygon", coordinates: [[[1, 2]]], polygon: square };
    expect(normalizePolygon(data, W, H)).toBeNull();
  });
});

describe("candidateRefinement", () => {
  it("builds a clamped normalized footprint and a padded ROI inside the image", () => {
    const polygon = rect(10, 10, 100, 50);
    const { roi, footprint } = candidateRefinement(polygon, { w: 200, h: 100 });
    expect(footprint.type).toBe("Polygon");
    expect(footprint.coordinates[0][0]).toEqual([0.05, 0.1]);
    expect(footprint.coordinates[0][2]).toEqual([0.55, 0.6]);
    expect(roi).toEqual({ x: 0, y: 0, w: 136, h: 86 });
  });

  it("keeps the ROI within image bounds near the far edge", () => {
    const polygon = rect(180, 80, 30, 30);
    const { roi, footprint } = candidateRefinement(polygon, { w: 200, h: 100 });
    expect(roi.x + roi.w).toBeLessThanOrEqual(200);
    expect(roi.y + roi.h).toBeLessThanOrEqual(100);
    expect(roi.w).toBeGreaterThanOrEqual(1);
    expect(footprint.coordinates[0].every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1)).toBe(true);
  });
});
