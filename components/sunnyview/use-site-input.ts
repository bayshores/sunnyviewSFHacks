"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { MapInputResult } from "@/components/MapInput";
import { apiUrl } from "@/lib/api";
import { buildStaticMapSpec } from "@/lib/static-map";
import type { HistorySnapshot } from "@/lib/history-types";
import { asRecord } from "./geometry";
import type { AddressStatic, RoofBackground } from "./types";

function emptyMapInput(): MapInputResult {
  return {
    kind: "address",
    address: "",
    lat: null,
    lng: null,
    zoom: 19,
    mPerPx: null,
  };
}

export type SiteInput = {
  mapInput: MapInputResult;
  setMapInput: Dispatch<SetStateAction<MapInputResult>>;
  lat: number | null;
  setLat: Dispatch<SetStateAction<number | null>>;
  lng: number | null;
  setLng: Dispatch<SetStateAction<number | null>>;
  zoom: number;
  tiltDeg: number;
  setTiltDeg: Dispatch<SetStateAction<number>>;
  azimuthDeg: number;
  setAzimuthDeg: Dispatch<SetStateAction<number>>;
  lossesPct: number;
  setLossesPct: Dispatch<SetStateAction<number>>;
  mPerPx: number | null;
  addressStatic: AddressStatic | null;
  background: RoofBackground;
  pickEnabled: boolean;
  handlePickLocation: (p: { lat: number; lng: number }) => void;
  /** Abort any in-flight reverse geocode and apply a history snapshot's site fields. */
  applySnapshotSite: (snapshot: HistorySnapshot) => void;
  /** Abort any in-flight reverse geocode and reset to an empty address search. */
  clearSiteInput: () => void;
};

/** Address/image input, site assumptions, globe pick + reverse geocode, and the roof background. */
export function useSiteInput(opts: { panelsMounted: boolean; globeInteractive: boolean }): SiteInput {
  const { panelsMounted, globeInteractive } = opts;
  const [mapInput, setMapInput] = useState<MapInputResult>(emptyMapInput);
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [zoom, setZoom] = useState<number>(19);
  const [tiltDeg, setTiltDeg] = useState<number>(20);
  const [azimuthDeg, setAzimuthDeg] = useState<number>(180);
  const [lossesPct, setLossesPct] = useState<number>(14);

  const reverseGeocodeAbortRef = useRef<AbortController | null>(null);
  const pickEnabled = panelsMounted && globeInteractive && mapInput.kind === "address";
  const handlePickLocation = useCallback(
    (p: { lat: number; lng: number }) => {
      if (!pickEnabled) return;
      const nextLat = p.lat;
      const nextLng = p.lng;

      setLat(nextLat);
      setLng(nextLng);

      setMapInput((prev) => {
        if (prev.kind !== "address") return prev;
        return {
          ...prev,
          lat: nextLat,
          lng: nextLng,
          address: "",
          mPerPx: null,
        };
      });

      reverseGeocodeAbortRef.current?.abort();
      const ac = new AbortController();
      reverseGeocodeAbortRef.current = ac;

      void (async () => {
        try {
          const res = await fetch(
            apiUrl(`/api/reverse-geocode?lat=${encodeURIComponent(nextLat)}&lng=${encodeURIComponent(nextLng)}`),
            {
              method: "GET",
              headers: { accept: "application/json" },
              signal: ac.signal,
            },
          );
          if (!res.ok) return;
          const data = asRecord(await res.json().catch(() => null));
          const displayName = typeof data?.displayName === "string" ? data.displayName.trim() : "";
          if (!displayName) return;
          setMapInput((prev) => {
            if (prev.kind !== "address") return prev;
            if (prev.lat !== nextLat || prev.lng !== nextLng) return prev;
            if ((prev.address ?? "").trim().length > 0) return prev;
            return { ...prev, address: displayName };
          });
        } catch {
          // ignore
        }
      })();
    },
    [pickEnabled],
  );

  // lat/lng stay independently editable, so they mirror the address result whenever mapInput
  // (or the panels gate) changes. Adjusted while rendering instead of in an effect.
  const [syncedFrom, setSyncedFrom] = useState({ mapInput, panelsMounted });
  if (syncedFrom.mapInput !== mapInput || syncedFrom.panelsMounted !== panelsMounted) {
    setSyncedFrom({ mapInput, panelsMounted });
    if (panelsMounted && mapInput.kind === "address") {
      if (mapInput.lat === null || mapInput.lng === null) {
        setLat(null);
        setLng(null);
        if (mapInput.zoom !== null) setZoom(mapInput.zoom);
      } else {
        setLat(mapInput.lat);
        setLng(mapInput.lng);
        setZoom(mapInput.zoom ?? 19);
      }
    }
  }

  const mPerPx = mapInput.mPerPx;

  const addressStatic = useMemo((): AddressStatic | null => {
    if (mapInput.kind !== "address") return null;
    if (mapInput.lat === null || mapInput.lng === null) return null;
    const spec = buildStaticMapSpec({
      lat: mapInput.lat,
      lng: mapInput.lng,
      zoom: mapInput.zoom ?? 19,
    });
    return {
      ...spec,
      address: mapInput.address?.trim() ? mapInput.address.trim() : null,
    };
  }, [mapInput.address, mapInput.kind, mapInput.lat, mapInput.lng, mapInput.zoom]);

  const background = useMemo((): RoofBackground => {
    if (mapInput.kind === "image" && mapInput.image) {
      return {
        kind: "image",
        src: mapInput.image.dataUrl,
        widthPx: mapInput.image.widthPx,
        heightPx: mapInput.image.heightPx,
      };
    }
    if (addressStatic) {
      return {
        kind: "image",
        src: addressStatic.src,
        widthPx: addressStatic.widthPx,
        heightPx: addressStatic.heightPx,
      };
    }
    return { kind: "none" };
  }, [addressStatic, mapInput.kind, mapInput.image]);

  const applySnapshotSite = useCallback((snapshot: HistorySnapshot) => {
    reverseGeocodeAbortRef.current?.abort();
    const nextZoom = Number.isFinite(snapshot.zoom) ? Math.round(snapshot.zoom) : 19;
    const nextMPerPx = snapshot.mPerPx ?? snapshot.geometry.mPerPx ?? null;

    setMapInput({
      kind: "address",
      address: snapshot.address ?? "",
      lat: snapshot.lat,
      lng: snapshot.lng,
      zoom: nextZoom,
      mPerPx: nextMPerPx,
    });
    setLat(snapshot.lat);
    setLng(snapshot.lng);
    setZoom(nextZoom);

    setTiltDeg(snapshot.siteSpec.tiltDeg);
    setAzimuthDeg(snapshot.siteSpec.azimuthDeg);
    setLossesPct(snapshot.siteSpec.lossesPct);
  }, []);

  const clearSiteInput = useCallback(() => {
    reverseGeocodeAbortRef.current?.abort();
    setMapInput(emptyMapInput());
    setLat(null);
    setLng(null);
    setZoom(19);
  }, []);

  return {
    mapInput,
    setMapInput,
    lat,
    setLat,
    lng,
    setLng,
    zoom,
    tiltDeg,
    setTiltDeg,
    azimuthDeg,
    setAzimuthDeg,
    lossesPct,
    setLossesPct,
    mPerPx,
    addressStatic,
    background,
    pickEnabled,
    handlePickLocation,
    applySnapshotSite,
    clearSiteInput,
  };
}
