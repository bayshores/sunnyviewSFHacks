import { describe, expect, it } from "vitest";
import type { HistorySnapshot } from "@/lib/history-types";
import {
  buildHistorySnapshot,
  historySaveSignature,
  historySummaryFromSnapshot,
  roundHistory,
  type HistorySnapshotInput,
} from "./history";

function input(overrides: Partial<HistorySnapshotInput> = {}): HistorySnapshotInput {
  return {
    mapKind: "address",
    address: "  1 Main St, Sunnyvale, CA  ",
    lat: 37.3688,
    lng: -122.0363,
    zoom: 19.4,
    mPerPx: 0.15,
    tiltDeg: 20,
    azimuthDeg: 180,
    lossesPct: 14,
    panelSpec: { widthM: 1.1, heightM: 1.7, wattW: 400, gapM: 0.02 },
    orientationDeg: 12,
    panelCount: 10,
    dcKw: 4,
    vertices: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ],
    closed: true,
    estimate: {
      annualKwh: 5600,
      monthlyKwh: Array.from({ length: 12 }, () => 5600 / 12),
      annualCo2Kg: 2240,
      assumptions: { source: "pvwatts" },
    },
    ...overrides,
  };
}

function snapshot(overrides: Partial<HistorySnapshotInput> = {}): HistorySnapshot {
  const snap = buildHistorySnapshot(input(overrides));
  if (!snap) throw new Error("expected a snapshot");
  return snap;
}

describe("roundHistory", () => {
  it("rounds to the requested number of digits", () => {
    expect(roundHistory(1.23456, 2)).toBe(1.23);
    expect(roundHistory(1.235, 0)).toBe(1);
    expect(roundHistory(-122.03634999, 6)).toBe(-122.03635);
  });
});

describe("buildHistorySnapshot", () => {
  it("builds an address snapshot with trimmed address and rounded zoom", () => {
    const snap = snapshot();
    expect(snap.mode).toBe("address");
    expect(snap.address).toBe("1 Main St, Sunnyvale, CA");
    expect(snap.zoom).toBe(19);
    expect(snap.geometry.zoom).toBe(19);
    expect(snap.geometry.mPerPx).toBe(0.15);
    expect(snap.estimate?.annualKwh).toBe(5600);
  });

  it("returns null without an address site or closed roof with panels", () => {
    expect(buildHistorySnapshot(input({ mapKind: "image" }))).toBeNull();
    expect(buildHistorySnapshot(input({ lat: null }))).toBeNull();
    expect(buildHistorySnapshot(input({ lng: null }))).toBeNull();
    expect(buildHistorySnapshot(input({ closed: false }))).toBeNull();
    expect(buildHistorySnapshot(input({ vertices: [{ x: 0, y: 0 }] }))).toBeNull();
    expect(buildHistorySnapshot(input({ panelCount: 0 }))).toBeNull();
  });

  it("uses a null address for blank input and defaults non-finite zoom to 19", () => {
    const snap = snapshot({ address: "   ", zoom: NaN });
    expect(snap.address).toBeNull();
    expect(snap.zoom).toBe(19);
  });

  it("omits the estimate until it is meaningful", () => {
    expect(snapshot({ estimate: { annualKwh: 0, monthlyKwh: new Array(12).fill(0), annualCo2Kg: 0 } }).estimate).toBeNull();
    expect(snapshot({ estimate: { annualKwh: 10, monthlyKwh: [1, 2], annualCo2Kg: 4 } }).estimate).toBeNull();
  });

  it("copies vertices instead of aliasing the input", () => {
    const vertices = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    const snap = snapshot({ vertices });
    expect(snap.geometry.vertices).toEqual(vertices);
    expect(snap.geometry.vertices[0]).not.toBe(vertices[0]);
  });
});

describe("historySummaryFromSnapshot", () => {
  it("summarizes address, layout, and estimate", () => {
    expect(historySummaryFromSnapshot(snapshot())).toEqual({
      address: "1 Main St, Sunnyvale, CA",
      panelCount: 10,
      dcKw: 4,
      annualKwh: 5600,
      annualCo2Kg: 2240,
      lat: 37.3688,
      lng: -122.0363,
    });
  });

  it("uses null energy values when there is no estimate", () => {
    const snap = snapshot({ estimate: { annualKwh: 0, monthlyKwh: [], annualCo2Kg: 0 } });
    const summary = historySummaryFromSnapshot(snap);
    expect(summary.annualKwh).toBeNull();
    expect(summary.annualCo2Kg).toBeNull();
  });
});

describe("historySaveSignature", () => {
  const sig = (overrides: Partial<HistorySnapshotInput> = {}) => {
    const snap = snapshot(overrides);
    return historySaveSignature(snap, historySummaryFromSnapshot(snap));
  };

  it("is stable for identical designs", () => {
    expect(sig()).toBe(sig());
  });

  it("ignores sub-rounding noise", () => {
    expect(sig({ lat: 37.3688000001, orientationDeg: 12.04 })).toBe(sig());
    expect(
      sig({
        vertices: [
          { x: 0.01, y: 0 },
          { x: 10, y: 0.04 },
          { x: 10, y: 10 },
        ],
      }),
    ).toBe(sig());
    expect(
      sig({
        estimate: {
          annualKwh: 5600.3,
          monthlyKwh: Array.from({ length: 12 }, () => 1),
          annualCo2Kg: 1,
        },
      }),
    ).toBe(sig());
  });

  it("ignores fields outside the signature basis", () => {
    expect(sig({ tiltDeg: 35, address: "elsewhere" })).toBe(sig());
  });

  it("changes when the design materially changes", () => {
    const base = sig();
    expect(sig({ lat: 37.37 })).not.toBe(base);
    expect(sig({ panelCount: 11 })).not.toBe(base);
    expect(sig({ orientationDeg: 13 })).not.toBe(base);
    expect(sig({ panelSpec: { widthM: 1.2, heightM: 1.7, wattW: 400, gapM: 0.02 } })).not.toBe(base);
    expect(
      sig({
        vertices: [
          { x: 0, y: 0 },
          { x: 12, y: 0 },
          { x: 10, y: 10 },
        ],
      }),
    ).not.toBe(base);
  });
});
