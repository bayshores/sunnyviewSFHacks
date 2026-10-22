import type { PanelSpec, Point } from "@/components/PanelPacking";
import type { HistorySnapshot, HistorySummary } from "@/lib/history-types";
import type { Estimate } from "./types";

export function roundHistory(n: number, digits: number): number {
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

/** Stable, rounded fingerprint used to skip saving near-identical history snapshots. */
export function historySaveSignature(snapshot: HistorySnapshot, summary: HistorySummary): string {
  const basis = {
    lat: roundHistory(snapshot.lat, 6),
    lng: roundHistory(snapshot.lng, 6),
    zoom: Math.round(snapshot.zoom),
    panelSpec: {
      widthM: roundHistory(snapshot.panelSpec.widthM, 3),
      heightM: roundHistory(snapshot.panelSpec.heightM, 3),
      wattW: roundHistory(snapshot.panelSpec.wattW, 1),
      gapM: roundHistory(snapshot.panelSpec.gapM, 3),
    },
    orientationDeg: roundHistory(snapshot.layoutSummary.orientationDeg, 1),
    panelCount: snapshot.layoutSummary.panelCount,
    annualKwh: summary.annualKwh !== null ? Math.round(summary.annualKwh) : null,
    vertices: snapshot.geometry.vertices.map((p) => [roundHistory(p.x, 1), roundHistory(p.y, 1)]),
  };
  return JSON.stringify(basis);
}

export function historySummaryFromSnapshot(snapshot: HistorySnapshot): HistorySummary {
  return {
    address: snapshot.address,
    panelCount: snapshot.layoutSummary.panelCount,
    dcKw: snapshot.layoutSummary.dcKw,
    annualKwh: snapshot.estimate ? snapshot.estimate.annualKwh : null,
    annualCo2Kg: snapshot.estimate ? snapshot.estimate.annualCo2Kg : null,
    lat: snapshot.lat,
    lng: snapshot.lng,
  };
}

export type HistorySnapshotInput = {
  mapKind: "address" | "image";
  address: string | undefined;
  lat: number | null;
  lng: number | null;
  zoom: number;
  mPerPx: number | null;
  tiltDeg: number;
  azimuthDeg: number;
  lossesPct: number;
  panelSpec: PanelSpec;
  orientationDeg: number;
  panelCount: number;
  dcKw: number;
  vertices: Point[];
  closed: boolean;
  estimate: Pick<Estimate, "annualKwh" | "monthlyKwh" | "annualCo2Kg" | "assumptions">;
};

/** Build a saveable snapshot; null unless an address site has a closed roof with panels. */
export function buildHistorySnapshot(input: HistorySnapshotInput): HistorySnapshot | null {
  if (input.mapKind !== "address") return null;
  if (input.lat === null || input.lng === null) return null;
  if (!input.closed || input.vertices.length < 3 || input.panelCount <= 0) return null;

  const address = input.address?.trim() ? input.address.trim() : null;
  const nextZoom = Number.isFinite(input.zoom) ? Math.round(input.zoom) : 19;
  const snapMPerPx = input.mPerPx ?? null;
  const { estimate } = input;

  return {
    mode: "address",
    address,
    lat: input.lat,
    lng: input.lng,
    zoom: nextZoom,
    mPerPx: snapMPerPx,
    siteSpec: {
      tiltDeg: input.tiltDeg,
      azimuthDeg: input.azimuthDeg,
      lossesPct: input.lossesPct,
    },
    panelSpec: {
      widthM: input.panelSpec.widthM,
      heightM: input.panelSpec.heightM,
      wattW: input.panelSpec.wattW,
      gapM: input.panelSpec.gapM,
    },
    layoutSummary: {
      orientationDeg: input.orientationDeg,
      panelCount: input.panelCount,
      dcKw: input.dcKw,
    },
    geometry: {
      vertices: input.vertices.map((p) => ({ x: p.x, y: p.y })),
      closed: input.closed,
      mPerPx: snapMPerPx,
      zoom: nextZoom,
    },
    estimate:
      estimate.annualKwh > 0 && estimate.monthlyKwh.length === 12
        ? {
            annualKwh: estimate.annualKwh,
            monthlyKwh: estimate.monthlyKwh,
            annualCo2Kg: estimate.annualCo2Kg,
            assumptions: estimate.assumptions,
          }
        : null,
  };
}
