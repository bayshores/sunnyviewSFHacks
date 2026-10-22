"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { packPanelsDeterministic } from "@/components/PanelPacking";
import type { PanelSpec, PlacedPanel, Point } from "@/components/PanelPacking";
import { apiUrl } from "@/lib/api";
import {
  estimateInputsKey,
  fallbackEstimateFor,
  parseEstimateResponse,
  serverEstimateIsCurrent,
} from "./estimate";
import { roofPackingKey } from "./geometry";
import type { Estimate, PanelSpecMode } from "./types";

const PACKING_DEBOUNCE_MS = 80;
const ESTIMATE_DEBOUNCE_MS = 320;

export type PackingAndEstimateInput = {
  panelsMounted: boolean;
  closed: boolean;
  vertices: Point[];
  mPerPx: number | null;
  roofAreaM2: number | null;
  panelSpec: PanelSpec;
  panelSpecMode: PanelSpecMode;
  panelAutoReadyKey: string | null;
  orientationDeg: number;
  lat: number | null;
  lng: number | null;
  tiltDeg: number;
  azimuthDeg: number;
  lossesPct: number;
  dcKw: number;
  panelCount: number;
  setPanelsPacked: Dispatch<SetStateAction<PlacedPanel[]>>;
  setEstimate: Dispatch<SetStateAction<Estimate>>;
};

/** Debounced deterministic panel packing, the local fallback estimate, and the server estimate. */
export function usePackingAndEstimate(input: PackingAndEstimateInput): void {
  const { panelsMounted, closed, vertices, mPerPx, roofAreaM2, panelSpec, panelSpecMode } = input;
  const { panelAutoReadyKey, orientationDeg, lat, lng, tiltDeg, azimuthDeg, lossesPct } = input;
  const { dcKw, panelCount, setPanelsPacked, setEstimate } = input;

  const fallbackEstimate = useMemo((): Estimate => fallbackEstimateFor(dcKw), [dcKw]);

  // A server estimate is only shown for the inputs it was computed for; anything else
  // (new address, edited roof/size, changed assumptions) falls back to the local estimate.
  useEffect(() => {
    if (!panelsMounted) return;
    const site = { lat, lng, tiltDeg, azimuthDeg, lossesPct };
    setEstimate((prev) => (serverEstimateIsCurrent(prev, site, dcKw) ? prev : fallbackEstimate));
  }, [fallbackEstimate, panelsMounted, setEstimate, lat, lng, tiltDeg, azimuthDeg, lossesPct, dcKw]);

  useEffect(() => {
    if (!panelsMounted) return;
    const t = window.setTimeout(() => {
      if (!closed || vertices.length < 3 || !mPerPx) {
        setPanelsPacked([]);
        return;
      }

      const key = roofPackingKey(roofAreaM2, vertices.length, mPerPx);
      if (panelSpecMode === "auto" && panelAutoReadyKey !== key) {
        // Wait until auto panel sizing/pick runs for this roof.
        setPanelsPacked([]);
        return;
      }

      setPanelsPacked(
        packPanelsDeterministic({
          usablePolygon: vertices,
          mPerPx,
          panel: {
            widthM: panelSpec.widthM,
            heightM: panelSpec.heightM,
            gapM: panelSpec.gapM,
          },
          orientationDeg,
        }),
      );
    }, PACKING_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [
    panelsMounted,
    closed,
    vertices,
    mPerPx,
    panelAutoReadyKey,
    panelSpec.widthM,
    panelSpec.heightM,
    panelSpec.gapM,
    panelSpecMode,
    roofAreaM2,
    orientationDeg,
    setPanelsPacked,
  ]);

  const estimateAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!panelsMounted) return;
    const hasSite = Number.isFinite(lat ?? NaN) && Number.isFinite(lng ?? NaN);
    if (!hasSite || dcKw <= 0) return;
    let localAbort: AbortController | null = null;
    const t = window.setTimeout(async () => {
      estimateAbortRef.current?.abort();
      const ac = new AbortController();
      localAbort = ac;
      estimateAbortRef.current = ac;
      try {
        const res = await fetch(apiUrl("/api/estimate"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ac.signal,
          body: JSON.stringify({
            siteSpec: { lat, lng, tiltDeg, azimuthDeg, lossesPct },
            layoutSummary: { dcKw, panelCount, orientationDeg },
            panelSpec,
          }),
        });
        if (!res.ok) return;
        const next = parseEstimateResponse(await res.json().catch(() => null));
        if (next && !ac.signal.aborted) {
          setEstimate({ ...next, inputsKey: estimateInputsKey({ lat, lng, tiltDeg, azimuthDeg, lossesPct }, dcKw) });
        }
      } catch {
        // keep fallback
      }
    }, ESTIMATE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(t);
      localAbort?.abort();
    };
  }, [
    panelsMounted,
    lat,
    lng,
    tiltDeg,
    azimuthDeg,
    lossesPct,
    dcKw,
    panelCount,
    orientationDeg,
    panelSpec,
    setEstimate,
  ]);
}
