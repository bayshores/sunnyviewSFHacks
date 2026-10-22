"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { PanelSpec, PlacedPanel, Point } from "@/components/PanelPacking";
import type { MapInputResult } from "@/components/MapInput";
import { apiUrl } from "@/lib/api";
import {
  bestRoofAlignedPackingOrientationDeg,
  candidateRefinement,
  clampAngle90,
  normAxis90,
  normAzimuth360,
  polygonDominantEdgeAxisDeg,
} from "./geometry";
import { buildSegmentRequest, parseSegmentResponse, segmentErrorMessage, segmentHint } from "./segment";
import type { AddressStatic, CandidatePolygon, SegmentRoi } from "./types";

export type AutoOutlineOptions = {
  reason?: "auto" | "manual";
  roi?: SegmentRoi | null;
  metaOverride?: Record<string, unknown> | null;
};

export type RoofOutlineInput = {
  panelsMounted: boolean;
  mapInput: MapInputResult;
  addressStatic: AddressStatic | null;
  mPerPx: number | null;
  panelSpec: PanelSpec;
  setVertices: Dispatch<SetStateAction<Point[]>>;
  setClosed: Dispatch<SetStateAction<boolean>>;
  setPanelsPacked: Dispatch<SetStateAction<PlacedPanel[]>>;
  setPanelCountOverride: Dispatch<SetStateAction<number | null>>;
  setOrientationDeg: Dispatch<SetStateAction<number>>;
  setAzimuthDeg: Dispatch<SetStateAction<number>>;
  setRoofAxisHintDeg: Dispatch<SetStateAction<number | null>>;
  clearRoof: () => void;
  resetAutoPick: () => void;
};

export type RoofOutline = {
  autoOutlineBusy: boolean;
  autoOutlineError: string | null;
  autoOutlineHint: string | null;
  candidatePolygons: CandidatePolygon[] | null;
  runAutoOutline: (opts?: AutoOutlineOptions) => Promise<void>;
  pickCandidate: (id: string) => void;
  /** Reset candidates/error/hint (and optionally the busy flag), then show `hint`. */
  clearOutline: (hint: string | null, resetBusy: boolean) => void;
  /** Abort any running segmentation and allow the address auto-outline to run again. */
  abortOutline: () => void;
};

/** CV auto-outline via /api/segment, OSM candidate picking, and the address auto-segment. */
export function useRoofOutline(input: RoofOutlineInput): RoofOutline {
  const { panelsMounted, mapInput, addressStatic, mPerPx, panelSpec } = input;
  const { setVertices, setClosed, setPanelsPacked, setPanelCountOverride, setOrientationDeg } = input;
  const { setAzimuthDeg, setRoofAxisHintDeg, clearRoof, resetAutoPick } = input;

  const [autoOutlineBusy, setAutoOutlineBusy] = useState(false);
  const [autoOutlineError, setAutoOutlineError] = useState<string | null>(null);
  const [autoOutlineHint, setAutoOutlineHint] = useState<string | null>(null);
  const [candidatePolygons, setCandidatePolygons] = useState<CandidatePolygon[] | null>(null);

  const segmentAbortRef = useRef<AbortController | null>(null);
  const lastAutoSegmentKeyRef = useRef<string | null>(null);

  const clearOutline = useCallback((hint: string | null, resetBusy: boolean) => {
    setCandidatePolygons(null);
    if (resetBusy) setAutoOutlineBusy(false);
    setAutoOutlineError(null);
    setAutoOutlineHint(hint);
  }, []);

  const abortOutline = useCallback(() => {
    segmentAbortRef.current?.abort();
    lastAutoSegmentKeyRef.current = null;
  }, []);

  useEffect(() => {
    if (mapInput.kind === "image") return;
    clearOutline(null, true);
  }, [clearOutline, mapInput.kind]);

  const runAutoOutline = useCallback(
    async (opts?: AutoOutlineOptions) => {
      const reason = opts?.reason ?? "manual";
      const roi = opts?.roi ?? null;
      const request = buildSegmentRequest(mapInput, addressStatic, roi, opts?.metaOverride ?? null);
      if (!request) return;

      segmentAbortRef.current?.abort();
      const ac = new AbortController();
      segmentAbortRef.current = ac;

      setAutoOutlineBusy(true);
      setAutoOutlineError(null);
      setAutoOutlineHint(null);
      setCandidatePolygons(null);

      try {
        const res = await fetch(apiUrl("/api/segment"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ac.signal,
          body: JSON.stringify(request.body),
        });
        const data: unknown = await res.json().catch(() => null);
        if (!res.ok) throw new Error(segmentErrorMessage(data, res.status));

        const parsed = parseSegmentResponse(data, request.w, request.h);
        const { candidates, primary } = parsed;
        if (candidates.length) setCandidatePolygons(candidates);
        if (!primary) {
          throw new Error("No roof polygon returned");
        }

        // Keep the full roof outline as returned. (Single-plane selection is optional and should not replace the roof mask.)
        // Auto-orient panels from CV (preferred) or polygon geometry.
        const axisHint =
          parsed.suggestedOrientationDeg !== null ? normAxis90(parsed.suggestedOrientationDeg) : null;
        setRoofAxisHintDeg(axisHint);

        const axisDeg = axisHint ?? polygonDominantEdgeAxisDeg(primary);
        if (mPerPx) {
          setOrientationDeg(bestRoofAlignedPackingOrientationDeg({ polygon: primary, mPerPx, panelSpec, axisDeg }));
        } else {
          setOrientationDeg(clampAngle90(axisDeg));
        }
        if (parsed.suggestedAzimuthDeg !== null) {
          setAzimuthDeg(normAzimuth360(parsed.suggestedAzimuthDeg));
        }

        setPanelsPacked([]);
        setPanelCountOverride(null);
        setVertices(primary);
        setClosed(true);

        const hint = segmentHint({
          reason,
          candidateCount: candidates.length,
          note: parsed.note,
          source: parsed.source,
          confidence: parsed.confidence,
        });
        if (hint) setAutoOutlineHint(hint);
      } catch (e) {
        if (ac.signal.aborted) return;
        setAutoOutlineError(e instanceof Error ? e.message : "Auto-outline failed.");
      } finally {
        if (!ac.signal.aborted) setAutoOutlineBusy(false);
      }
    },
    [
      addressStatic,
      mPerPx,
      mapInput,
      panelSpec,
      setAzimuthDeg,
      setClosed,
      setOrientationDeg,
      setPanelCountOverride,
      setPanelsPacked,
      setRoofAxisHintDeg,
      setVertices,
    ],
  );

  // Address flow: after a successful search, fetch one static satellite image and
  // auto-detect the roof immediately (no extra "Auto-outline" click needed).
  useEffect(() => {
    if (!panelsMounted) return;
    if (mapInput.kind !== "address") return;
    if (!addressStatic) return;

    const key = `addr:${addressStatic.meta.lat.toFixed(6)}:${addressStatic.meta.lng.toFixed(6)}:${addressStatic.meta.zoom}`;
    if (lastAutoSegmentKeyRef.current === key) return;
    lastAutoSegmentKeyRef.current = key;

    clearRoof();
    clearOutline(null, false);
    setRoofAxisHintDeg(null);
    resetAutoPick();

    void runAutoOutline({ reason: "auto" });
  }, [
    addressStatic,
    clearOutline,
    clearRoof,
    mapInput.kind,
    panelsMounted,
    resetAutoPick,
    runAutoOutline,
    setRoofAxisHintDeg,
  ]);

  const pickCandidate = useCallback(
    (id: string) => {
      const c = candidatePolygons?.find((p) => p.id === id);
      if (!c) return;
      setVertices(c.polygon);
      setClosed(true);
      setPanelsPacked([]);
      setPanelCountOverride(null);
      setRoofAxisHintDeg(null);
      resetAutoPick();
      setCandidatePolygons(null);
      setAutoOutlineHint(null);

      if (mPerPx) {
        const axisDeg = polygonDominantEdgeAxisDeg(c.polygon);
        setOrientationDeg(bestRoofAlignedPackingOrientationDeg({ polygon: c.polygon, mPerPx, panelSpec, axisDeg }));
      }

      // If the candidates came from OSM disambiguation, refine the chosen building with CV
      // by locking the footprint + focusing an ROI.
      const dims =
        mapInput.kind === "image" && mapInput.image
          ? { w: mapInput.image.widthPx, h: mapInput.image.heightPx }
          : mapInput.kind === "address" && addressStatic
            ? { w: addressStatic.widthPx, h: addressStatic.heightPx }
            : null;
      if (!dims) return;

      const { roi, footprint } = candidateRefinement(c.polygon, dims);
      void runAutoOutline({
        reason: "manual",
        roi,
        metaOverride: {
          osmFootprint: footprint,
          osmSource: "user",
        },
      });
    },
    [
      addressStatic,
      candidatePolygons,
      mapInput.kind,
      mapInput.image,
      mPerPx,
      panelSpec,
      resetAutoPick,
      runAutoOutline,
      setClosed,
      setOrientationDeg,
      setPanelCountOverride,
      setPanelsPacked,
      setRoofAxisHintDeg,
      setVertices,
    ],
  );

  return {
    autoOutlineBusy,
    autoOutlineError,
    autoOutlineHint,
    candidatePolygons,
    runAutoOutline,
    pickCandidate,
    clearOutline,
    abortOutline,
  };
}
