import type { PanelSpec, Point } from "@/components/PanelPacking";
import type {
  ProjectEstimate,
  ProjectGeometry,
  ProjectLayoutSummary,
  ProjectPanelSpec,
  ProjectSiteSpec,
  UpdateProjectRequest,
} from "@/lib/projects-types";
import { simplifyClosedRing, simplifyPolyline } from "./simplify";
import type { Estimate } from "./types";

// Client-side mirror of the bounds in lib/schemas.ts (Project*Schema). Sections that
// would fail the strict server validation are dropped instead of sent.
export const MAX_PROJECT_VERTICES = 160;
const MAX_ASSUMPTION_KEYS = 40;
const MAX_ASSUMPTION_KEY_LEN = 60;
const MAX_ASSUMPTION_STRING_LEN = 200;
const MAX_SOURCE_LEN = 40;

function inRange(n: unknown, min: number, max: number): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
}

function positiveUpTo(n: unknown, max: number): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= max;
}

export type SiteSpecInput = {
  lat: number | null;
  lng: number | null;
  tiltDeg: number;
  azimuthDeg: number;
  lossesPct: number;
};

export function toProjectSiteSpec(input: SiteSpecInput): ProjectSiteSpec | undefined {
  const { lat, lng, tiltDeg, azimuthDeg, lossesPct } = input;
  if (lat === null || lng === null) return undefined;
  if (!inRange(lat, -90, 90) || !inRange(lng, -180, 180)) return undefined;
  if (!inRange(tiltDeg, 0, 90) || !inRange(azimuthDeg, 0, 360) || !inRange(lossesPct, 0, 40)) return undefined;
  return { lat, lng, tiltDeg, azimuthDeg, lossesPct };
}

export function toProjectPanelSpec(spec: PanelSpec): ProjectPanelSpec | undefined {
  const { widthM, heightM, wattW, gapM } = spec;
  if (!positiveUpTo(widthM, 4) || !positiveUpTo(heightM, 4) || !positiveUpTo(wattW, 1500)) return undefined;
  if (!inRange(gapM, 0, 1)) return undefined;
  return { widthM, heightM, wattW, gapM };
}

export function toProjectLayoutSummary(input: {
  dcKw: number;
  panelCount: number;
  orientationDeg: number;
}): ProjectLayoutSummary | undefined {
  const { dcKw, panelCount, orientationDeg } = input;
  if (!inRange(dcKw, 0, 20_000) || !inRange(orientationDeg, -360, 360)) return undefined;
  if (!Number.isInteger(panelCount) || !inRange(panelCount, 0, 20_000)) return undefined;
  return { dcKw, panelCount, orientationDeg };
}

export function toProjectGeometry(input: {
  vertices: Point[];
  closed: boolean;
  mPerPx: number | null;
  background: "address" | "image";
  zoom: number;
}): ProjectGeometry | undefined {
  if (!input.vertices.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return undefined;
  if (!inRange(input.zoom, 0, 24)) return undefined;
  return {
    // Over-cap polygons are simplified (RDP) rather than dropped, so the saved roof never goes stale.
    // Open paths use polyline mode: endpoints kept, no implicit closing edge.
    vertices: input.closed
      ? simplifyClosedRing(input.vertices, MAX_PROJECT_VERTICES)
      : simplifyPolyline(input.vertices, MAX_PROJECT_VERTICES),
    closed: input.closed,
    mPerPx: positiveUpTo(input.mPerPx, Number.MAX_VALUE) ? input.mPerPx : null,
    background: input.background,
    zoom: input.zoom,
  };
}

type AssumptionValue = string | number | boolean | null;

/** Keep only primitive assumption values the server accepts; undefined when nothing survives. */
export function sanitizeAssumptions(raw: unknown): Record<string, AssumptionValue> | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, AssumptionValue> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_ASSUMPTION_KEYS) break;
    if (key.length > MAX_ASSUMPTION_KEY_LEN) continue;
    const ok =
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && value.length <= MAX_ASSUMPTION_STRING_LEN);
    if (!ok) continue;
    out[key] = value as AssumptionValue;
    count += 1;
  }
  return count > 0 ? out : undefined;
}

export function toProjectEstimate(estimate: Estimate): ProjectEstimate | undefined {
  const { annualKwh, monthlyKwh, annualCo2Kg, source } = estimate;
  if (!inRange(annualKwh, 0, 2_000_000) || !inRange(annualCo2Kg, 0, 2_000_000)) return undefined;
  if (monthlyKwh.length !== 12 || !monthlyKwh.every((v) => inRange(v, 0, 400_000))) return undefined;
  if (source.trim().length > MAX_SOURCE_LEN) return undefined;
  const assumptions = sanitizeAssumptions(estimate.assumptions);
  return {
    annualKwh,
    monthlyKwh: [...monthlyKwh],
    annualCo2Kg,
    source,
    ...(assumptions ? { assumptions } : {}),
  };
}

export type ProjectPatchInput = SiteSpecInput & {
  panelSpec: PanelSpec;
  dcKw: number;
  panelCount: number;
  orientationDeg: number;
  vertices: Point[];
  closed: boolean;
  mPerPx: number | null;
  background: "address" | "image";
  zoom: number;
  estimate: Estimate;
};

/** Build a contract-valid PATCH body; null when no section is valid. Never includes image data. */
export function buildProjectPatch(input: ProjectPatchInput): UpdateProjectRequest | null {
  const siteSpec = toProjectSiteSpec(input);
  const panelSpec = toProjectPanelSpec(input.panelSpec);
  const layoutSummary = toProjectLayoutSummary(input);
  const geometry = toProjectGeometry(input);
  const estimate = toProjectEstimate(input.estimate);
  const patch: UpdateProjectRequest = {
    ...(siteSpec ? { siteSpec } : {}),
    ...(panelSpec ? { panelSpec } : {}),
    ...(layoutSummary ? { layoutSummary } : {}),
    ...(geometry ? { geometry } : {}),
    ...(estimate ? { estimate } : {}),
  };
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Apply a saved layoutSummary to freshly re-packed panels: slice to the saved panelCount
 * (when present and not above what packed) and use the saved dcKw only in that case;
 * otherwise show all packed panels with a dcKw computed from them.
 */
export function resolveSharedLayout<T>(
  packed: readonly T[],
  saved: { panelCount?: number | null; dcKw?: number | null } | null | undefined,
  wattW: number,
): { panels: T[]; panelCount: number; dcKw: number } {
  const savedCount = saved?.panelCount;
  const useSaved =
    typeof savedCount === "number" && Number.isInteger(savedCount) && savedCount >= 0 && savedCount <= packed.length;
  const panels = useSaved ? packed.slice(0, savedCount) : [...packed];
  const savedDc = saved?.dcKw;
  const dcKw =
    useSaved && typeof savedDc === "number" && Number.isFinite(savedDc) && savedDc >= 0
      ? savedDc
      : (panels.length * wattW) / 1000;
  return { panels, panelCount: panels.length, dcKw };
}
