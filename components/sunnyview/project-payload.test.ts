import { describe, expect, it } from "vitest";
import { ProjectCreateSchema, ProjectPatchSchema } from "@/lib/schemas";
import {
  buildProjectPatch,
  resolveSharedLayout,
  MAX_PROJECT_VERTICES,
  sanitizeAssumptions,
  toProjectGeometry,
  toProjectPanelSpec,
  toProjectSiteSpec,
  type ProjectPatchInput,
} from "./project-payload";

function patchInput(overrides: Partial<ProjectPatchInput> = {}): ProjectPatchInput {
  return {
    lat: 37.37,
    lng: -122.03,
    tiltDeg: 20,
    azimuthDeg: 180,
    lossesPct: 14,
    panelSpec: { widthM: 1.1, heightM: 1.7, wattW: 400, gapM: 0.02 },
    dcKw: 4,
    panelCount: 10,
    orientationDeg: -12,
    vertices: [
      { x: 1, y: 2 },
      { x: 30, y: 2 },
      { x: 30, y: 40 },
    ],
    closed: true,
    mPerPx: 0.15,
    background: "address",
    zoom: 19,
    estimate: {
      annualKwh: 5600,
      monthlyKwh: Array.from({ length: 12 }, () => 5600 / 12),
      annualCo2Kg: 2240,
      source: "server",
      assumptions: { tiltDeg: 20, dataset: "nsrdb", nested: { a: 1 }, list: [1, 2], ok: true, none: null },
    },
    ...overrides,
  };
}

describe("buildProjectPatch", () => {
  it("produces a body that passes the strict server schema", () => {
    const patch = buildProjectPatch(patchInput());
    expect(patch).not.toBeNull();
    expect(ProjectPatchSchema.safeParse(patch).success).toBe(true);
    expect(patch?.siteSpec).toEqual({ lat: 37.37, lng: -122.03, tiltDeg: 20, azimuthDeg: 180, lossesPct: 14 });
    expect(patch?.layoutSummary).toEqual({ dcKw: 4, panelCount: 10, orientationDeg: -12 });
    expect(patch?.geometry?.background).toBe("address");
  });

  it("keeps only primitive assumptions", () => {
    const patch = buildProjectPatch(patchInput());
    expect(patch?.estimate?.assumptions).toEqual({ tiltDeg: 20, dataset: "nsrdb", ok: true, none: null });
  });

  it("omits siteSpec when lat/lng are missing", () => {
    const patch = buildProjectPatch(patchInput({ lat: null }));
    expect(patch?.siteSpec).toBeUndefined();
    expect(ProjectPatchSchema.safeParse(patch).success).toBe(true);
  });

  it("simplifies geometry above the vertex cap instead of dropping it", () => {
    const vertices = Array.from({ length: 1000 }, (_, i) => ({
      x: 300 + 200 * Math.cos((2 * Math.PI * i) / 1000),
      y: 300 + 200 * Math.sin((2 * Math.PI * i) / 1000),
    }));
    const patch = buildProjectPatch(patchInput({ vertices }));
    expect(patch?.geometry).toBeDefined();
    expect(patch!.geometry!.vertices.length).toBeLessThanOrEqual(MAX_PROJECT_VERTICES);
    expect(patch!.geometry!.vertices.length).toBeGreaterThanOrEqual(3);
    expect(ProjectPatchSchema.safeParse(patch).success).toBe(true);
  });

  it("sends a null mPerPx when uncalibrated and never sends image data", () => {
    const patch = buildProjectPatch(patchInput({ mPerPx: null, background: "image" }));
    expect(patch?.geometry?.mPerPx).toBeNull();
    expect(JSON.stringify(patch)).not.toContain("data:");
    expect(ProjectPatchSchema.safeParse(patch).success).toBe(true);
  });

  it("drops out-of-range sections instead of failing the whole patch", () => {
    const patch = buildProjectPatch(
      patchInput({
        tiltDeg: 120,
        panelCount: 2.5,
        estimate: { annualKwh: 1, monthlyKwh: [1, 2, 3], annualCo2Kg: 1, source: "fallback" },
      }),
    );
    expect(patch?.siteSpec).toBeUndefined();
    expect(patch?.layoutSummary).toBeUndefined();
    expect(patch?.estimate).toBeUndefined();
    expect(patch?.panelSpec).toBeDefined();
    expect(ProjectPatchSchema.safeParse(patch).success).toBe(true);
  });

  it("returns null when nothing is valid", () => {
    const patch = buildProjectPatch(
      patchInput({
        lat: null,
        panelSpec: { widthM: 0, heightM: 0, wattW: 0, gapM: 0 },
        dcKw: -1,
        zoom: 99,
        estimate: { annualKwh: -1, monthlyKwh: [], annualCo2Kg: 0, source: "fallback" },
      }),
    );
    expect(patch).toBeNull();
  });

  it("accepts the initial all-zero fallback estimate", () => {
    const patch = buildProjectPatch(
      patchInput({
        estimate: { annualKwh: 0, monthlyKwh: new Array(12).fill(0), annualCo2Kg: 0, source: "fallback" },
      }),
    );
    expect(patch?.estimate).toEqual({
      annualKwh: 0,
      monthlyKwh: new Array(12).fill(0),
      annualCo2Kg: 0,
      source: "fallback",
    });
    expect(ProjectPatchSchema.safeParse(patch).success).toBe(true);
  });
});

describe("create payload helpers", () => {
  it("builds a valid create body", () => {
    const body = {
      name: "Untitled",
      siteSpec: toProjectSiteSpec({ lat: 10, lng: 20, tiltDeg: 20, azimuthDeg: 180, lossesPct: 14 }),
      panelSpec: toProjectPanelSpec({ widthM: 1.1, heightM: 1.7, wattW: 400, gapM: 0.02 }),
    };
    expect(ProjectCreateSchema.safeParse(body).success).toBe(true);
  });

  it("rejects out-of-range site and panel values", () => {
    expect(toProjectSiteSpec({ lat: 91, lng: 0, tiltDeg: 20, azimuthDeg: 180, lossesPct: 14 })).toBeUndefined();
    expect(toProjectSiteSpec({ lat: 0, lng: 0, tiltDeg: 20, azimuthDeg: 180, lossesPct: 41 })).toBeUndefined();
    expect(toProjectPanelSpec({ widthM: 5, heightM: 1, wattW: 400, gapM: 0 })).toBeUndefined();
    expect(toProjectPanelSpec({ widthM: 1, heightM: 1, wattW: 400, gapM: -0.1 })).toBeUndefined();
  });

  it("strips extra panel keys so the strict schema accepts it", () => {
    const spec = { widthM: 1, heightM: 2, wattW: 300, gapM: 0.01, extra: "x" };
    expect(toProjectPanelSpec(spec)).toEqual({ widthM: 1, heightM: 2, wattW: 300, gapM: 0.01 });
  });

  it("rejects geometry with non-finite vertices", () => {
    const geometry = toProjectGeometry({
      vertices: [{ x: NaN, y: 0 }],
      closed: false,
      mPerPx: 0.1,
      background: "address",
      zoom: 19,
    });
    expect(geometry).toBeUndefined();
  });
});

describe("toProjectGeometry simplification mode", () => {
  const base = { mPerPx: 0.1, background: "address" as const, zoom: 19 };
  const line = Array.from({ length: 500 }, (_, i) => ({ x: i, y: Math.sin(i / 7) * 50 }));

  it("keeps first and last vertex of an open path over the cap", () => {
    const g = toProjectGeometry({ ...base, vertices: line, closed: false });
    expect(g?.vertices.length).toBeLessThanOrEqual(160);
    expect(g?.vertices[0]).toEqual(line[0]);
    expect(g?.vertices[g!.vertices.length - 1]).toEqual(line[line.length - 1]);
  });

  it("still simplifies a closed ring over the cap", () => {
    const g = toProjectGeometry({ ...base, vertices: line, closed: true });
    expect(g?.vertices.length).toBeLessThanOrEqual(160);
    expect(g?.vertices.length).toBeGreaterThanOrEqual(3);
  });
});

describe("sanitizeAssumptions", () => {
  it("returns undefined for non-records or when nothing survives", () => {
    expect(sanitizeAssumptions(undefined)).toBeUndefined();
    expect(sanitizeAssumptions("x")).toBeUndefined();
    expect(sanitizeAssumptions([1])).toBeUndefined();
    expect(sanitizeAssumptions({ nested: { a: 1 } })).toBeUndefined();
  });

  it("drops long keys, long strings, and non-finite numbers, and caps the key count", () => {
    const raw: Record<string, unknown> = {
      ["k".repeat(61)]: 1,
      long: "x".repeat(201),
      inf: Infinity,
      ok: 1,
    };
    expect(sanitizeAssumptions(raw)).toEqual({ ok: 1 });

    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizeAssumptions(many) ?? {})).toHaveLength(40);
  });
});

describe("resolveSharedLayout", () => {
  const packed = Array.from({ length: 10 }, (_, i) => ({ i }));

  it("slices to the saved panelCount and uses saved dcKw", () => {
    const r = resolveSharedLayout(packed, { panelCount: 4, dcKw: 1.6 }, 400);
    expect(r.panels).toHaveLength(4);
    expect(r.panelCount).toBe(4);
    expect(r.dcKw).toBe(1.6);
  });

  it("falls back to computed values without a summary", () => {
    const r = resolveSharedLayout(packed, null, 400);
    expect(r.panelCount).toBe(10);
    expect(r.dcKw).toBeCloseTo(4);
  });

  it("ignores a saved count above what packed", () => {
    const r = resolveSharedLayout(packed, { panelCount: 99 }, 500);
    expect(r.panelCount).toBe(10);
    expect(r.dcKw).toBeCloseTo(5);
  });

  it("recomputes dcKw from shown panels when saved count exceeds packed (ignores saved dcKw)", () => {
    const r = resolveSharedLayout(packed, { panelCount: 99, dcKw: 39.6 }, 400);
    expect(r.panels).toHaveLength(10);
    expect(r.panelCount).toBe(10);
    expect(r.dcKw).toBeCloseTo(4);
  });

  it("uses saved values when saved count is at or below packed", () => {
    const r = resolveSharedLayout(packed, { panelCount: 10, dcKw: 3.9 }, 400);
    expect(r.panelCount).toBe(10);
    expect(r.dcKw).toBe(3.9);
  });

  it("does not mutate the packed array", () => {
    resolveSharedLayout(packed, { panelCount: 2 }, 400);
    expect(packed).toHaveLength(10);
  });
});
