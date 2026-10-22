"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { PanelSpec, Point } from "@/components/PanelPacking";
import type { MapInputResult } from "@/components/MapInput";
import { apiUrl } from "@/lib/api";
import { clampAngle90, polygonDominantEdgeAxisDeg, roofPackingKey } from "./geometry";
import { GEMINI_KEY_STORAGE, GEMINI_KEY_WITHHELD_NOTICE, localKeyHeader } from "./local-keys";
import {
  buildPanelFits,
  panelRecommendErrorMessage,
  parsePanelRecommendation,
  pickBestPanelOption,
} from "./panel-recommend";
import type { PanelBrandRec, PanelSpecMode } from "./types";

const PANEL_RECOMMEND_NOTES =
  "Pick the best option for this roof based on energy yield per area, reliability, and the computed fit counts.";

type PanelBrandCtx = {
  closed: boolean;
  vertices: Point[];
  mPerPx: number | null;
  orientationDeg: number;
  panelSpec: PanelSpec;
  panelSpecMode: PanelSpecMode;
  panelChoiceId: string;
  roofAreaM2: number | null;
  lat: number | null;
  lng: number | null;
};

export type PanelSelectionInput = {
  panelsMounted: boolean;
  mapInput: MapInputResult;
  lat: number | null;
  lng: number | null;
  closed: boolean;
  vertices: Point[];
  mPerPx: number | null;
  roofAreaM2: number | null;
  orientationDeg: number;
  roofAxisHintDeg: number | null;
  panelSpec: PanelSpec;
  panelSpecMode: PanelSpecMode;
  panelChoiceId: string;
  setPanelSpec: Dispatch<SetStateAction<PanelSpec>>;
  setPanelSpecMode: Dispatch<SetStateAction<PanelSpecMode>>;
  setPanelChoiceId: Dispatch<SetStateAction<string>>;
  setOrientationDeg: Dispatch<SetStateAction<number>>;
  setActionNotice: Dispatch<SetStateAction<string | null>>;
};

export type PanelSelection = {
  panelBrandRec: PanelBrandRec | null;
  panelBrandBusy: boolean;
  panelBrandError: string | null;
  panelAutoReadyKey: string | null;
  /** Forget the last auto panel pick so it re-runs for the current roof. */
  resetAutoPick: () => void;
  togglePanelSpecMode: () => void;
  askGemini: () => void;
};

/** Auto panel-model pick for the traced roof plus the Gemini panel recommendation. */
export function usePanelSelection(input: PanelSelectionInput): PanelSelection {
  const { panelsMounted, mapInput, lat, lng, closed, vertices, mPerPx, roofAreaM2 } = input;
  const { orientationDeg, roofAxisHintDeg, panelSpec, panelSpecMode, panelChoiceId } = input;
  const { setPanelSpec, setPanelSpecMode, setPanelChoiceId, setOrientationDeg, setActionNotice } = input;

  const [panelBrandRec, setPanelBrandRec] = useState<PanelBrandRec | null>(null);
  const [panelBrandBusy, setPanelBrandBusy] = useState(false);
  const [panelBrandError, setPanelBrandError] = useState<string | null>(null);
  const lastPanelAutoKeyRef = useRef<string | null>(null);
  const [panelAutoReadyKey, setPanelAutoReadyKey] = useState<string | null>(null);
  const [panelBrandReqSeq, setPanelBrandReqSeq] = useState(0);
  const panelBrandAbortRef = useRef<AbortController | null>(null);
  const lastPanelBrandAutoAddrKeyRef = useRef<string | null>(null);
  const panelBrandCtxRef = useRef<PanelBrandCtx>({
    closed: false,
    vertices: [],
    mPerPx: null,
    orientationDeg: 0,
    panelSpec,
    panelSpecMode: "auto",
    panelChoiceId: "custom",
    roofAreaM2: null,
    lat: null,
    lng: null,
  });

  const panelBrandAddrKey = useMemo(() => {
    if (mapInput.kind !== "address") return null;
    if (mapInput.lat === null || mapInput.lng === null) return null;
    return `${mapInput.lat.toFixed(5)}:${mapInput.lng.toFixed(5)}`;
  }, [mapInput.kind, mapInput.lat, mapInput.lng]);

  // Keep a stable snapshot for the Gemini effect so it only runs when explicitly triggered.
  panelBrandCtxRef.current = {
    closed,
    vertices,
    mPerPx,
    orientationDeg,
    panelSpec,
    panelSpecMode,
    panelChoiceId,
    roofAreaM2,
    lat,
    lng,
  };

  // Auto-run panel recommendation once per address (after roof is traced).
  useEffect(() => {
    if (!panelsMounted) return;
    if (!panelBrandAddrKey) return;
    if (!closed || vertices.length < 3 || !mPerPx || !roofAreaM2) return;

    if (lastPanelBrandAutoAddrKeyRef.current === panelBrandAddrKey) return;
    lastPanelBrandAutoAddrKeyRef.current = panelBrandAddrKey;

    setPanelBrandRec(null);
    setPanelBrandError(null);
    setPanelBrandReqSeq((s) => s + 1);
  }, [closed, mPerPx, panelBrandAddrKey, panelsMounted, roofAreaM2, vertices.length]);

  useEffect(() => {
    if (!panelsMounted) return;
    if (panelSpecMode !== "auto") return;
    if (!closed || vertices.length < 3 || !mPerPx) return;

    const axisDeg = roofAxisHintDeg ?? polygonDominantEdgeAxisDeg(vertices);

    const key = roofPackingKey(roofAreaM2, vertices.length, mPerPx);
    if (lastPanelAutoKeyRef.current === key) return;
    lastPanelAutoKeyRef.current = key;

    const best = pickBestPanelOption(vertices, mPerPx, axisDeg, panelSpec);

    setPanelChoiceId(best.id);
    setPanelSpec(best.spec);
    setOrientationDeg(best.orient);
    setPanelAutoReadyKey(key);
    setPanelBrandRec(null);
    setPanelBrandError(null);
  }, [
    closed,
    mPerPx,
    panelSpec,
    panelSpecMode,
    panelsMounted,
    roofAreaM2,
    vertices,
    roofAxisHintDeg,
    setOrientationDeg,
    setPanelChoiceId,
    setPanelSpec,
  ]);

  useEffect(() => {
    if (panelSpecMode === "auto") return;
    lastPanelAutoKeyRef.current = null;
    setPanelAutoReadyKey(null);
  }, [panelSpecMode]);

  useEffect(() => {
    if (!panelsMounted) return;
    if (panelBrandReqSeq === 0) return;

    const ctx = panelBrandCtxRef.current;
    if (!ctx.closed || ctx.vertices.length < 3 || !ctx.mPerPx || !ctx.roofAreaM2) {
      setPanelBrandError("Trace and calibrate a roof area first.");
      return;
    }
    if (ctx.lat === null || ctx.lng === null) {
      setPanelBrandError("Set an address first.");
      return;
    }

    const ctxMode = ctx.panelSpecMode;

    panelBrandAbortRef.current?.abort();
    const ac = new AbortController();
    panelBrandAbortRef.current = ac;

    setPanelBrandBusy(true);
    setPanelBrandError(null);

    const fits = buildPanelFits({
      vertices: ctx.vertices,
      mPerPx: ctx.mPerPx,
      axisDeg: polygonDominantEdgeAxisDeg(ctx.vertices),
      panelSpec: ctx.panelSpec,
      panelSpecMode: ctxMode,
    });

    (async () => {
      try {
        const geminiKey = localKeyHeader(GEMINI_KEY_STORAGE, "x-gemini-api-key");
        if (geminiKey.forwarding === "withhold") setActionNotice(GEMINI_KEY_WITHHELD_NOTICE);

        const res = await fetch(apiUrl("/api/panel-recommend"), {
          method: "POST",
          headers: { "content-type": "application/json", ...geminiKey.headers },
          signal: ac.signal,
          body: JSON.stringify({
            lat: ctx.lat,
            lng: ctx.lng,
            roofAreaM2: ctx.roofAreaM2,
            options: fits,
            currentId: ctx.panelChoiceId,
            notes: PANEL_RECOMMEND_NOTES,
          }),
        });
        const data: unknown = await res.json().catch(() => null);
        if (!res.ok) throw new Error(panelRecommendErrorMessage(data, res.status));

        const rec = parsePanelRecommendation(data);
        setPanelBrandRec(rec);

        if (ctxMode === "auto") {
          const picked = fits.find((f) => f.id === rec.selectedId);
          if (picked) {
            setPanelChoiceId(picked.id);
            setPanelSpec({
              widthM: picked.spec.widthM,
              heightM: picked.spec.heightM,
              wattW: picked.spec.wattW,
              gapM: picked.spec.gapM,
            });
            if (typeof picked.fit?.orientationDeg === "number") {
              setOrientationDeg(clampAngle90(picked.fit.orientationDeg));
            }
          }
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        const msg = e instanceof Error ? e.message : "Panel recommendation failed.";
        setPanelBrandError(msg);
      } finally {
        if (!ac.signal.aborted) setPanelBrandBusy(false);
      }
    })();

    return () => ac.abort();
  }, [panelBrandReqSeq, panelsMounted, setActionNotice, setOrientationDeg, setPanelChoiceId, setPanelSpec]);

  const resetAutoPick = useCallback(() => {
    setPanelAutoReadyKey(null);
    lastPanelAutoKeyRef.current = null;
  }, []);

  const togglePanelSpecMode = useCallback(() => {
    setPanelSpecMode((m) => (m === "auto" ? "manual" : "auto"));
    setPanelBrandRec(null);
    setPanelBrandError(null);
    lastPanelAutoKeyRef.current = null;
  }, [setPanelSpecMode]);

  const askGemini = useCallback(() => {
    setPanelBrandRec(null);
    setPanelBrandError(null);
    setPanelBrandReqSeq((s) => s + 1);
  }, []);

  return {
    panelBrandRec,
    panelBrandBusy,
    panelBrandError,
    panelAutoReadyKey,
    resetAutoPick,
    togglePanelSpecMode,
    askGemini,
  };
}
