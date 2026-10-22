"use client";

import { useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";
import type { PanelSpec, Point } from "@/components/PanelPacking";
import { saveHistory } from "@/lib/history-api";
import type { HistorySnapshot, HistorySummary } from "@/lib/history-types";
import { buildHistorySnapshot, historySaveSignature, historySummaryFromSnapshot } from "./history";
import type { Estimate } from "./types";

const HISTORY_SAVE_DEBOUNCE_MS = 1800;

export type HistoryAutosaveInput = {
  panelsMounted: boolean;
  opened: boolean;
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
  estimate: Estimate;
};

/**
 * Debounced history save of the current address design. Returns the last-saved signature
 * ref so loading/clearing can mark the current state as already saved (or not).
 */
export function useHistoryAutosave(input: HistoryAutosaveInput): RefObject<string | null> {
  const { panelsMounted, opened, mapKind, address, lat, lng, zoom, mPerPx } = input;
  const { tiltDeg, azimuthDeg, lossesPct, orientationDeg, panelCount, dcKw, vertices, closed } = input;
  const { widthM, heightM, wattW, gapM } = input.panelSpec;
  const { annualKwh, monthlyKwh, annualCo2Kg, assumptions } = input.estimate;
  const lastHistorySigRef = useRef<string | null>(null);

  const historySnapshot = useMemo<HistorySnapshot | null>(
    () =>
      buildHistorySnapshot({
        mapKind,
        address,
        lat,
        lng,
        zoom,
        mPerPx,
        tiltDeg,
        azimuthDeg,
        lossesPct,
        panelSpec: { widthM, heightM, wattW, gapM },
        orientationDeg,
        panelCount,
        dcKw,
        vertices,
        closed,
        estimate: { annualKwh, monthlyKwh, annualCo2Kg, assumptions },
      }),
    [
      address,
      annualCo2Kg,
      annualKwh,
      assumptions,
      azimuthDeg,
      closed,
      dcKw,
      gapM,
      heightM,
      lat,
      lng,
      lossesPct,
      mPerPx,
      mapKind,
      monthlyKwh,
      orientationDeg,
      panelCount,
      tiltDeg,
      vertices,
      wattW,
      widthM,
      zoom,
    ],
  );

  const historySummary = useMemo<HistorySummary | null>(() => {
    if (!historySnapshot) return null;
    return historySummaryFromSnapshot(historySnapshot);
  }, [historySnapshot]);

  useEffect(() => {
    if (!panelsMounted || !opened) return;
    if (!historySnapshot || !historySummary) return;

    const signature = historySaveSignature(historySnapshot, historySummary);
    if (lastHistorySigRef.current === signature) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        await saveHistory({ snapshot: historySnapshot, summary: historySummary });
        if (cancelled) return;
        lastHistorySigRef.current = signature;
      } catch {
        // history is optional; avoid interrupting main experience
      }
    }, HISTORY_SAVE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [historySnapshot, historySummary, opened, panelsMounted]);

  return lastHistorySigRef;
}
