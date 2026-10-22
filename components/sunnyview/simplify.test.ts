import { describe, expect, it } from "vitest";
import { ProjectPatchSchema } from "@/lib/schemas";
import { simplifyClosedRing, simplifyPolyline } from "./simplify";

function circle(n: number, r = 100) {
  return Array.from({ length: n }, (_, i) => ({
    x: 200 + r * Math.cos((2 * Math.PI * i) / n),
    y: 200 + r * Math.sin((2 * Math.PI * i) / n),
  }));
}

describe("simplifyClosedRing", () => {
  it("returns small input unchanged (as a copy)", () => {
    const input = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    const out = simplifyClosedRing(input, 160);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(out[0]).not.toBe(input[0]);
  });

  it("reduces a large circle to at most 160 points, keeping at least 3", () => {
    const out = simplifyClosedRing(circle(2000), 160);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  it("removes collinear points but keeps corners", () => {
    const ring = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 10, y: 10 },
      { x: 5, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 5 },
    ];
    const out = simplifyClosedRing(ring, 4);
    expect(out).toHaveLength(4);
    expect(out).toEqual(
      expect.arrayContaining([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ])
    );
  });

  it("does not mutate input and is deterministic", () => {
    const input = circle(500);
    const snapshot = JSON.stringify(input);
    const a = simplifyClosedRing(input, 100);
    const b = simplifyClosedRing(input, 100);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(a).toEqual(b);
  });

  it("handles degenerate identical points without throwing", () => {
    const input = Array.from({ length: 300 }, () => ({ x: 1, y: 1 }));
    const out = simplifyClosedRing(input, 160);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  it("output is valid for ProjectPatchSchema geometry", () => {
    const vertices = simplifyClosedRing(circle(1000), 160);
    const parsed = ProjectPatchSchema.safeParse({
      geometry: { vertices, closed: true, mPerPx: 0.1, background: "address", zoom: 19 },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("simplifyPolyline (open)", () => {
  const wave = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i, y: Math.sin(i / 7) * 50 }));

  it("returns small input unchanged as a copy", () => {
    const input = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    const out = simplifyPolyline(input, 160);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it("keeps first and last points and respects max", () => {
    const input = wave(1000);
    const out = simplifyPolyline(input, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out[0]).toEqual(input[0]);
    expect(out[out.length - 1]).toEqual(input[input.length - 1]);
  });

  it("keeps endpoints even for degenerate identical points", () => {
    const input = Array.from({ length: 300 }, () => ({ x: 2, y: 2 }));
    const out = simplifyPolyline(input, 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out[0]).toEqual({ x: 2, y: 2 });
  });

  it("drops collinear interior points of a straight line", () => {
    const input = Array.from({ length: 400 }, (_, i) => ({ x: i, y: 0 }));
    expect(simplifyPolyline(input, 10)).toEqual([
      { x: 0, y: 0 },
      { x: 399, y: 0 },
    ]);
  });
});

describe("large inputs", () => {
  it("handles ~200k ring points without stack/arg overflow", () => {
    const out = simplifyClosedRing(circle(200_000), 160);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  it("handles ~200k open points and adversarial deep-recursion shapes", () => {
    const spiral = Array.from({ length: 200_000 }, (_, i) => ({ x: i, y: i * i * 1e-6 }));
    const out = simplifyPolyline(spiral, 160);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out[0]).toEqual(spiral[0]);
    expect(out[out.length - 1]).toEqual(spiral[spiral.length - 1]);
  });
});
