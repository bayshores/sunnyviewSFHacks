import { packPanelsDeterministic } from "@/components/PanelPacking";
import type { PanelSpec, Point } from "@/components/PanelPacking";
import type { SegmentRoi } from "./types";

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function coerceNumber(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Wrap an angle into [-90, 90]. */
export function clampAngle90(deg: number): number {
  let d = deg;
  while (d > 90) d -= 180;
  while (d < -90) d += 180;
  return d;
}

/** Fold an angle into the 90-degree axis period, [0, 90). */
export function normAxis90(deg: number): number {
  let d = deg % 90;
  if (d < 0) d += 90;
  // keep inside [0, 90)
  if (d >= 90) d -= 90;
  return d;
}

/** Normalize an azimuth into [0, 360). */
export function normAzimuth360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Length-weighted circular mean of the polygon's edge axes (period 90deg). */
export function polygonDominantEdgeAxisDeg(poly: Point[]): number {
  if (poly.length < 3) return 0;

  let sumCos = 0;
  let sumSin = 0;
  let wSum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 4)) continue;
    const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const axisDeg = normAxis90(angDeg);
    const r = (axisDeg * Math.PI) / 180;
    // Period = 90deg -> use 4x angle for circular mean.
    sumCos += len * Math.cos(4 * r);
    sumSin += len * Math.sin(4 * r);
    wSum += len;
  }

  if (!(wSum > 0) || (!Number.isFinite(sumCos) && !Number.isFinite(sumSin))) return 0;
  const mean = Math.atan2(sumSin, sumCos) / 4;
  const meanDeg = (mean * 180) / Math.PI;
  return normAxis90(meanDeg);
}

export type RoofAlignedOrientationInput = {
  polygon: Point[];
  mPerPx: number;
  panelSpec: Pick<PanelSpec, "widthM" | "heightM" | "gapM">;
  axisDeg: number;
};

/**
 * Try the roof axis and its perpendicular (each +/- 2deg) and return the
 * orientation that packs the most panels, preferring the smallest offset on ties.
 */
export function bestRoofAlignedPackingOrientationDeg(opts: RoofAlignedOrientationInput): number {
  const axis = normAxis90(opts.axisDeg);
  const bases = [clampAngle90(axis), clampAngle90(axis + 90)];
  const offsets = [-2, -1, 0, 1, 2];
  const panel = { widthM: opts.panelSpec.widthM, heightM: opts.panelSpec.heightM, gapM: opts.panelSpec.gapM };

  let bestDeg = bases[0];
  let bestCount = -Infinity;
  let bestOffsetAbs = Infinity;
  for (const base of bases) {
    for (const off of offsets) {
      const deg = clampAngle90(base + off);
      const count = packPanelsDeterministic({
        usablePolygon: opts.polygon,
        mPerPx: opts.mPerPx,
        panel,
        orientationDeg: deg,
      }).length;
      const offAbs = Math.abs(off);
      if (count > bestCount || (count === bestCount && offAbs < bestOffsetAbs)) {
        bestCount = count;
        bestDeg = deg;
        bestOffsetAbs = offAbs;
      }
    }
  }
  return bestDeg;
}

export type PanelFit = { panelCount: number; dcKw: number; orientationDeg: number };

/** Best roof-aligned orientation for a panel spec plus the resulting count and DC size. */
export function computePanelFit(polygon: Point[], mPerPx: number, spec: PanelSpec, axisDeg: number): PanelFit {
  const orientationDeg = bestRoofAlignedPackingOrientationDeg({ polygon, mPerPx, panelSpec: spec, axisDeg });
  const panelCount = packPanelsDeterministic({
    usablePolygon: polygon,
    mPerPx,
    panel: { widthM: spec.widthM, heightM: spec.heightM, gapM: spec.gapM },
    orientationDeg,
  }).length;
  return { panelCount, dcKw: (panelCount * spec.wattW) / 1000, orientationDeg };
}

/** Cache key used to detect when the traced roof changed enough to re-run auto panel sizing. */
export function roofPackingKey(roofAreaM2: number | null, vertexCount: number, mPerPx: number): string {
  return `roof:${Math.round((roofAreaM2 ?? 0) * 10) / 10}:${vertexCount}:${Math.round(mPerPx * 1e6)}`;
}

function parsePointsArray(arr: unknown[]): Point[] | null {
  const pts: Point[] = [];
  for (const item of arr) {
    if (Array.isArray(item) && item.length >= 2) {
      const x = coerceNumber(item[0]);
      const y = coerceNumber(item[1]);
      if (x === null || y === null) return null;
      pts.push({ x, y });
      continue;
    }
    if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      const x = coerceNumber(rec.x);
      const y = coerceNumber(rec.y);
      if (x === null || y === null) return null;
      pts.push({ x, y });
      continue;
    }
    return null;
  }

  if (pts.length >= 2) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) pts.pop();
  }

  return pts.length >= 3 ? pts : null;
}

function scaleIfNormalized(pts: Point[], w: number, h: number): Point[] {
  const normalized = pts.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
  return normalized ? pts.map((p) => ({ x: p.x * w, y: p.y * h })) : pts;
}

function geoJsonRing(obj: Record<string, unknown>): unknown[] | null {
  const typ = typeof obj.type === "string" ? obj.type : null;
  const coords = obj.coordinates;
  if (!coords || !Array.isArray(coords)) return null;
  const first: unknown = coords[0];
  if (typ === "Polygon" && Array.isArray(first)) return first;
  if (typ === "MultiPolygon" && Array.isArray(first) && Array.isArray(first[0])) return first[0] as unknown[];
  // Some services omit `type` and return { coordinates: [[x,y],...] }
  if (Array.isArray(first) && first.length >= 2) return coords;
  return null;
}

/**
 * Coerce a segmenter polygon (GeoJSON Polygon/MultiPolygon/Feature, wrapper object,
 * or array of [x,y] / {x,y}) into pixel-space points. Normalized [0,1] coordinates are
 * scaled by (w, h); a duplicated closing point is dropped.
 */
export function normalizePolygon(data: unknown, w: number, h: number): Point[] | null {
  const obj = asRecord(data);
  if (obj) {
    if (obj.type === "Feature" && obj.geometry) {
      return normalizePolygon(obj.geometry, w, h);
    }

    const ring = geoJsonRing(obj);
    if (ring) {
      const pts = parsePointsArray(ring);
      return pts ? scaleIfNormalized(pts, w, h) : null;
    }

    // Common wrappers.
    const inner = obj.roofPolygon ?? obj.polygon ?? obj.usablePolygon;
    if (inner && inner !== data) {
      const pts = normalizePolygon(inner, w, h);
      if (pts) return pts;
    }
  }

  if (!Array.isArray(data)) return null;
  const pts = parsePointsArray(data);
  return pts ? scaleIfNormalized(pts, w, h) : null;
}

export type CandidateRefinement = {
  roi: SegmentRoi;
  footprint: { type: "Polygon"; coordinates: number[][][] };
};

/** Normalized footprint + padded pixel ROI used to refine a picked OSM candidate with CV. */
export function candidateRefinement(polygon: Point[], dims: { w: number; h: number }): CandidateRefinement {
  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
  const ring = polygon.map((p) => [clamp01(p.x / dims.w), clamp01(p.y / dims.h)]);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const pad = 18;
  const x = Math.max(0, Math.floor(minX - pad));
  const y = Math.max(0, Math.floor(minY - pad));
  const w = Math.max(1, Math.min(dims.w - x, Math.ceil(maxX - minX + pad * 2)));
  const h = Math.max(1, Math.min(dims.h - y, Math.ceil(maxY - minY + pad * 2)));

  return { roi: { x, y, w, h }, footprint: { type: "Polygon", coordinates: [ring] } };
}
