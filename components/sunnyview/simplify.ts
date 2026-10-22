import type { Point } from "@/components/PanelPacking";

const MIN_RING_POINTS = 3;
const TOLERANCE_GROWTH = 1.5;
const MAX_TOLERANCE_STEPS = 80;

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Indices (ascending, inclusive of both ends) kept by RDP on the open chain pts[from..to]. Iterative. */
function rdpIndices(pts: readonly Point[], from: number, to: number, tol: number): number[] {
  const keep = new Uint8Array(to - from + 1);
  keep[0] = 1;
  keep[to - from] = 1;
  const stack: Array<[number, number]> = [[from, to]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number];
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToSegment(pts[i], pts[lo], pts[hi]);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxIdx === -1 || maxDist <= tol) continue;
    keep[maxIdx - from] = 1;
    stack.push([lo, maxIdx], [maxIdx, hi]);
  }
  const out: number[] = [];
  for (let i = 0; i < keep.length; i++) if (keep[i]) out.push(from + i);
  return out;
}

/** RDP on a closed ring (implicit closing edge), anchored at point 0 and its farthest point. */
function simplifyRingOnce(ring: readonly Point[], tol: number): Point[] {
  let far = 0;
  let farDist = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i].x - ring[0].x, ring[i].y - ring[0].y);
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  }
  if (far === 0) return ring.map((p) => ({ x: p.x, y: p.y }));
  const closedTail = [...ring.slice(far), ring[0]];
  const first = rdpIndices(ring, 0, far, tol);
  const second = rdpIndices(closedTail, 0, closedTail.length - 1, tol);
  const pts = [
    ...first.slice(0, -1).map((i) => ring[i]),
    ...second.slice(0, -1).map((i) => closedTail[i]),
  ];
  return pts.map((p) => ({ x: p.x, y: p.y }));
}

function evenlySampled(ring: readonly Point[], max: number): Point[] {
  const n = Math.max(MIN_RING_POINTS, max);
  return Array.from({ length: n }, (_, i) => {
    const p = ring[Math.floor((i * ring.length) / n)];
    return { x: p.x, y: p.y };
  });
}

function initialTolerance(pts: readonly Point[]): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.max(Math.hypot(maxX - minX, maxY - minY) * 1e-4, 1e-9);
}

/**
 * Simplify a closed polygon ring to at most `maxPoints` vertices using Ramer–Douglas–Peucker
 * with an increasing tolerance. Pure and deterministic; never returns fewer than 3 points
 * when given at least 3. Inputs already within the limit are returned as a copy, unchanged.
 */
export function simplifyClosedRing(vertices: readonly Point[], maxPoints: number): Point[] {
  const copy = vertices.map((p) => ({ x: p.x, y: p.y }));
  const limit = Math.max(MIN_RING_POINTS, Math.floor(maxPoints));
  if (copy.length <= limit) return copy;

  let tol = initialTolerance(copy);

  let best: Point[] = copy;
  for (let step = 0; step < MAX_TOLERANCE_STEPS; step++) {
    const candidate = simplifyRingOnce(copy, tol);
    if (candidate.length < MIN_RING_POINTS) break;
    best = candidate;
    if (candidate.length <= limit) return candidate;
    tol *= TOLERANCE_GROWTH;
  }
  return best.length <= limit ? best : evenlySampled(copy, limit);
}

const MIN_POLYLINE_POINTS = 2;

function evenlySampledPolyline(path: readonly Point[], max: number): Point[] {
  const n = Math.max(MIN_POLYLINE_POINTS, max);
  return Array.from({ length: n }, (_, i) => {
    const p = path[Math.round((i * (path.length - 1)) / (n - 1))];
    return { x: p.x, y: p.y };
  });
}

/**
 * Simplify an open polyline to at most `maxPoints` vertices (RDP, increasing tolerance).
 * No closing edge is assumed; the first and last points are always preserved.
 */
export function simplifyPolyline(vertices: readonly Point[], maxPoints: number): Point[] {
  const copy = vertices.map((p) => ({ x: p.x, y: p.y }));
  const limit = Math.max(MIN_POLYLINE_POINTS, Math.floor(maxPoints));
  if (copy.length <= limit) return copy;

  let tol = initialTolerance(copy);
  for (let step = 0; step < MAX_TOLERANCE_STEPS; step++) {
    const idx = rdpIndices(copy, 0, copy.length - 1, tol);
    if (idx.length <= limit) return idx.map((i) => copy[i]);
    tol *= TOLERANCE_GROWTH;
  }
  return evenlySampledPolyline(copy, limit);
}
