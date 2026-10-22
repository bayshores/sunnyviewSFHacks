import type { Point } from "@/components/PanelPacking";
import type { MapInputResult } from "@/components/MapInput";
import { asRecord, coerceNumber, normalizePolygon } from "./geometry";
import type { AddressStatic, CandidatePolygon, SegmentRoi } from "./types";

export type SegmentRequest = {
  w: number;
  h: number;
  body: Record<string, unknown>;
};

/** Build the /api/segment request for the current image upload or address static map. */
export function buildSegmentRequest(
  mapInput: MapInputResult,
  addressStatic: AddressStatic | null,
  roi: SegmentRoi | null,
  metaOverride: Record<string, unknown> | null,
): SegmentRequest | null {
  if (mapInput.kind === "image" && mapInput.image?.dataUrl) {
    const w = mapInput.image.widthPx;
    const h = mapInput.image.heightPx;
    const click = roi
      ? { x: roi.x + roi.w / 2, y: roi.y + roi.h / 2, type: "pos" as const }
      : { x: w / 2, y: h / 2, type: "pos" as const };
    return {
      w,
      h,
      body: {
        imageDataUrl: mapInput.image.dataUrl,
        mode: "roof",
        clicks: [click],
        ...(roi ? { roi } : {}),
        meta: {
          lat: mapInput.lat,
          lng: mapInput.lng,
          zoom: mapInput.zoom,
          widthPx: w,
          heightPx: h,
          address: mapInput.address ?? null,
          ...(metaOverride ?? {}),
        },
      },
    };
  }

  if (mapInput.kind === "address" && addressStatic) {
    const w = addressStatic.widthPx;
    const h = addressStatic.heightPx;
    const clicks = roi ? [{ x: roi.x + roi.w / 2, y: roi.y + roi.h / 2, type: "pos" as const }] : null;
    return {
      w,
      h,
      body: {
        imageUrl: addressStatic.src,
        mode: "roof",
        ...(clicks ? { clicks } : {}),
        ...(roi ? { roi } : {}),
        meta: {
          ...addressStatic.meta,
          address: addressStatic.address,
          ...(metaOverride ?? {}),
        },
      },
    };
  }

  return null;
}

export type ParsedSegmentResponse = {
  candidates: CandidatePolygon[];
  primary: Point[] | null;
  note: string | null;
  source: string | null;
  confidence: number | null;
  suggestedOrientationDeg: number | null;
  suggestedAzimuthDeg: number | null;
};

function parseCandidates(raw: unknown, w: number, h: number): CandidatePolygon[] {
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const out: CandidatePolygon[] = [];
  list.forEach((c, idx) => {
    const rec = asRecord(c);
    const id = typeof rec?.id === "string" ? rec.id : String(idx);
    const score = Number(rec?.score);
    const poly = normalizePolygon(rec?.polygon ?? rec?.roofPolygon ?? c, w, h);
    if (!poly) return;
    out.push({ id, polygon: poly, score: Number.isFinite(score) ? score : undefined });
  });
  return out;
}

/** Extract candidates, the primary roof polygon, and orientation hints from a segment response. */
export function parseSegmentResponse(data: unknown, w: number, h: number): ParsedSegmentResponse {
  const rec = asRecord(data);
  const result = asRecord(rec?.result);
  const candidates = parseCandidates(rec?.candidates, w, h);
  const polyRaw = rec?.roofPolygon ?? rec?.polygon ?? rec?.usablePolygon ?? result?.roofPolygon ?? result?.polygon;
  const primary = normalizePolygon(polyRaw, w, h) ?? (candidates.length ? candidates[0].polygon : null);
  const source =
    typeof rec?.source === "string" ? rec.source : typeof result?.source === "string" ? result.source : null;

  return {
    candidates,
    primary,
    note: typeof rec?.note === "string" ? rec.note : null,
    source,
    confidence: coerceNumber(rec?.confidence) ?? coerceNumber(result?.confidence),
    suggestedOrientationDeg:
      coerceNumber(rec?.suggestedOrientationDeg) ?? coerceNumber(result?.suggestedOrientationDeg),
    suggestedAzimuthDeg: coerceNumber(rec?.suggestedAzimuthDeg) ?? coerceNumber(result?.suggestedAzimuthDeg),
  };
}

/** Error message for a failed segment response. */
export function segmentErrorMessage(data: unknown, status: number): string {
  const rec = asRecord(data);
  return typeof rec?.error === "string" ? rec.error : `Segmentation failed (HTTP ${status})`;
}

/** Short hint shown under the roof canvas after an auto-outline. */
export function segmentHint(opts: {
  reason: "auto" | "manual";
  candidateCount: number;
  note: string | null;
  source: string | null;
  confidence: number | null;
}): string | null {
  const { reason, candidateCount, note, source, confidence } = opts;
  if (reason === "auto" && candidateCount > 1) return "Multiple roofs nearby. Click Edit to pick.";
  const safeNote = note && note.length <= 52 ? note : null;
  if (safeNote) return safeNote;

  const looksLikeFootprint =
    typeof source === "string" &&
    (source === "osm_building" ||
      source === "osm_candidates" ||
      source.startsWith("osm_") ||
      source.includes("footprint"));
  const fallbackish =
    typeof source === "string" &&
    (source === "fallback_rect" || source.includes("fallback_rect") || source.includes("segmenter_error"));
  const lowConfidence = confidence !== null && confidence < 0.32;
  if (fallbackish || lowConfidence) return "Edit -> Auto-outline.";
  if (looksLikeFootprint) return "OSM outline. Edit -> Auto-outline.";
  return null;
}
