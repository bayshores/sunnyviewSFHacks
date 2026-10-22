"use client";

import { useCallback, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { PanelSpec, PlacedPanel, Point } from "@/components/PanelPacking";
import type { HistorySnapshot } from "@/lib/history-types";
import { PANEL_OPTIONS } from "@/lib/panels";
import { polygonAreaPx2 } from "@/lib/roof-plane";
import { INITIAL_ESTIMATE } from "./estimate";
import type { Estimate, PanelSpecMode } from "./types";

export type RoofLayout = {
  panelSpec: PanelSpec;
  setPanelSpec: Dispatch<SetStateAction<PanelSpec>>;
  panelSpecMode: PanelSpecMode;
  setPanelSpecMode: Dispatch<SetStateAction<PanelSpecMode>>;
  panelChoiceId: string;
  setPanelChoiceId: Dispatch<SetStateAction<string>>;
  panelChoiceLabel: string;
  orientationDeg: number;
  setOrientationDeg: Dispatch<SetStateAction<number>>;
  roofAxisHintDeg: number | null;
  setRoofAxisHintDeg: Dispatch<SetStateAction<number | null>>;
  vertices: Point[];
  setVertices: Dispatch<SetStateAction<Point[]>>;
  closed: boolean;
  setClosed: Dispatch<SetStateAction<boolean>>;
  panelsPacked: PlacedPanel[];
  setPanelsPacked: Dispatch<SetStateAction<PlacedPanel[]>>;
  panelCountOverride: number | null;
  setPanelCountOverride: Dispatch<SetStateAction<number | null>>;
  panels: PlacedPanel[];
  panelCountAuto: number;
  panelCount: number;
  manualPanelCount: number;
  setManualPanelCount: (raw: number) => void;
  dcKw: number;
  roofAreaM2: number | null;
  estimate: Estimate;
  setEstimate: Dispatch<SetStateAction<Estimate>>;
  /** Apply a history snapshot's panel, layout, geometry, and estimate fields. */
  applySnapshotLayout: (snapshot: HistorySnapshot) => void;
  /** Drop the traced roof and any packed panels / manual count. */
  clearRoof: () => void;
};

/** Panel spec, traced roof geometry, packed panels, manual count override, and the estimate. */
export function useRoofLayout(opts: { mPerPx: number | null }): RoofLayout {
  const { mPerPx } = opts;
  const [panelSpec, setPanelSpec] = useState<PanelSpec>({
    widthM: 1.1,
    heightM: 1.7,
    wattW: 400,
    gapM: 0.02,
  });
  const [panelSpecMode, setPanelSpecMode] = useState<PanelSpecMode>("auto");
  const [panelChoiceId, setPanelChoiceId] = useState<string>(PANEL_OPTIONS[0]?.id ?? "custom");
  const [orientationDeg, setOrientationDeg] = useState<number>(0);
  const [roofAxisHintDeg, setRoofAxisHintDeg] = useState<number | null>(null);

  const [vertices, setVertices] = useState<Point[]>([]);
  const [closed, setClosed] = useState<boolean>(false);
  const [panelsPacked, setPanelsPacked] = useState<PlacedPanel[]>([]);
  const [panelCountOverride, setPanelCountOverride] = useState<number | null>(null);
  const [estimate, setEstimate] = useState<Estimate>(INITIAL_ESTIMATE);

  const panels = useMemo(() => {
    if (panelCountOverride === null) return panelsPacked;
    const max = panelsPacked.length;
    const n = Math.max(0, Math.min(max, Math.floor(panelCountOverride)));
    return panelsPacked.slice(0, n);
  }, [panelCountOverride, panelsPacked]);

  const panelCountAuto = panelsPacked.length;
  const panelCount = panels.length;
  const dcKw = useMemo(() => (panelCount * panelSpec.wattW) / 1000, [panelCount, panelSpec.wattW]);

  const setManualPanelCount = useCallback(
    (raw: number) => {
      if (!Number.isFinite(raw)) return;
      const max = Math.max(0, panelCountAuto);
      const n = Math.max(0, Math.min(max, Math.round(raw)));
      if (n >= max) setPanelCountOverride(null);
      else setPanelCountOverride(n);
    },
    [panelCountAuto],
  );

  const manualPanelCount = panelCountOverride === null ? panelCountAuto : panelCountOverride;

  // Re-clamp the manual count when re-packing shrinks the available panels
  // (adjusting state while rendering; only sets when the clamp changes the value).
  if (panelCountOverride !== null) {
    const max = Math.max(0, panelCountAuto);
    const n = Math.max(0, Math.min(max, Math.floor(panelCountOverride)));
    if (n >= max) setPanelCountOverride(null);
    else if (n !== panelCountOverride) setPanelCountOverride(n);
  }

  const panelChoiceLabel = useMemo(() => {
    if (panelChoiceId === "custom") return "Custom";
    return PANEL_OPTIONS.find((c) => c.id === panelChoiceId)?.label ?? "Standard";
  }, [panelChoiceId]);

  const roofAreaM2 = useMemo(() => {
    if (!closed || vertices.length < 3 || !mPerPx) return null;
    return polygonAreaPx2(vertices) * mPerPx * mPerPx;
  }, [closed, mPerPx, vertices]);

  const applySnapshotLayout = useCallback((snapshot: HistorySnapshot) => {
    setPanelSpec({
      widthM: snapshot.panelSpec.widthM,
      heightM: snapshot.panelSpec.heightM,
      wattW: snapshot.panelSpec.wattW,
      gapM: snapshot.panelSpec.gapM,
    });
    setPanelSpecMode("manual");
    setPanelChoiceId("custom");
    setOrientationDeg(snapshot.layoutSummary.orientationDeg);

    setVertices(snapshot.geometry.vertices.map((p) => ({ x: p.x, y: p.y })));
    setClosed(snapshot.geometry.closed);

    if (snapshot.estimate && snapshot.estimate.monthlyKwh.length === 12) {
      setEstimate({
        annualKwh: snapshot.estimate.annualKwh,
        monthlyKwh: snapshot.estimate.monthlyKwh,
        annualCo2Kg: snapshot.estimate.annualCo2Kg,
        source: "server",
        assumptions: snapshot.estimate.assumptions,
      });
    }
  }, []);

  const clearRoof = useCallback(() => {
    setVertices([]);
    setClosed(false);
    setPanelsPacked([]);
    setPanelCountOverride(null);
  }, []);

  return {
    panelSpec,
    setPanelSpec,
    panelSpecMode,
    setPanelSpecMode,
    panelChoiceId,
    setPanelChoiceId,
    panelChoiceLabel,
    orientationDeg,
    setOrientationDeg,
    roofAxisHintDeg,
    setRoofAxisHintDeg,
    vertices,
    setVertices,
    closed,
    setClosed,
    panelsPacked,
    setPanelsPacked,
    panelCountOverride,
    setPanelCountOverride,
    panels,
    panelCountAuto,
    panelCount,
    manualPanelCount,
    setManualPanelCount,
    dcKw,
    roofAreaM2,
    estimate,
    setEstimate,
    applySnapshotLayout,
    clearRoof,
  };
}
