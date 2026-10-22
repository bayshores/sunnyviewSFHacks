import type { PanelSpec, Point } from "@/components/PanelPacking";
import { PANEL_OPTIONS } from "@/lib/panels";
import { asRecord, computePanelFit, type PanelFit } from "./geometry";
import type { PanelBrandRec, PanelSpecMode } from "./types";

export type PanelFitOption = {
  id: string;
  label: string;
  brand: string;
  model: string;
  sourceUrl?: string;
  spec: PanelSpec;
  fit: PanelFit;
};

function copySpec(spec: PanelSpec): PanelSpec {
  return { widthM: spec.widthM, heightM: spec.heightM, wattW: spec.wattW, gapM: spec.gapM };
}

/** Pick the catalog panel that maximizes DC capacity on the roof (first wins on ties). */
export function pickBestPanelOption(
  vertices: Point[],
  mPerPx: number,
  axisDeg: number,
  fallbackSpec: PanelSpec,
): { id: string; spec: PanelSpec; orient: number; dc: number } {
  let best = {
    id: PANEL_OPTIONS[0]?.id ?? "custom",
    spec: PANEL_OPTIONS[0]?.spec ?? fallbackSpec,
    orient: 0,
    dc: -Infinity,
  };
  for (const c of PANEL_OPTIONS) {
    const fit = computePanelFit(vertices, mPerPx, c.spec, axisDeg);
    if (fit.dcKw > best.dc + 1e-6) {
      best = { id: c.id, spec: c.spec, orient: fit.orientationDeg, dc: fit.dcKw };
    }
  }
  return best;
}

/** Fit every catalog option (plus the custom spec when locked) for the Gemini request. */
export function buildPanelFits(opts: {
  vertices: Point[];
  mPerPx: number;
  axisDeg: number;
  panelSpec: PanelSpec;
  panelSpecMode: PanelSpecMode;
}): PanelFitOption[] {
  const { vertices, mPerPx, axisDeg, panelSpec, panelSpecMode } = opts;
  const catalog: PanelFitOption[] = PANEL_OPTIONS.map((o) => ({
    id: o.id,
    label: o.label,
    brand: o.brand,
    model: o.model,
    sourceUrl: o.sourceUrl,
    spec: copySpec(o.spec),
    fit: computePanelFit(vertices, mPerPx, o.spec, axisDeg),
  }));
  if (panelSpecMode !== "manual") return catalog;

  const custom: PanelFitOption = {
    id: "custom",
    label: "Custom size",
    brand: "(custom)",
    model: "User-defined",
    sourceUrl: undefined,
    spec: copySpec(panelSpec),
    fit: computePanelFit(vertices, mPerPx, panelSpec, axisDeg),
  };
  return [custom, ...catalog];
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

/** User-facing error for a failed /api/panel-recommend response. */
export function panelRecommendErrorMessage(data: unknown, status: number): string {
  const rec = asRecord(data);
  const message = typeof rec?.error === "string" ? rec.error : `Panel recommendation failed (${status})`;
  const normalized =
    message.includes("Missing GEMINI_API_KEY") || message.includes("Missing Gemini API key")
      ? "Missing Gemini API key. Add it on the landing page."
      : message;
  const attempted = stringList(rec?.attemptedModels).filter(Boolean);
  return attempted.length ? `${normalized} (models tried: ${attempted.join(", ")})` : normalized;
}

/** Parse a successful /api/panel-recommend body; throws on missing required fields. */
export function parsePanelRecommendation(data: unknown): PanelBrandRec {
  const rec = asRecord(data);
  const selectedId = typeof rec?.selectedId === "string" ? rec.selectedId : null;
  const brand = typeof rec?.brand === "string" ? rec.brand : null;
  const model = typeof rec?.model === "string" ? rec.model : null;
  const sourceUrl = typeof rec?.sourceUrl === "string" ? rec.sourceUrl : null;
  const why = stringList(rec?.why);
  const caveats = stringList(rec?.caveats);
  if (!selectedId || !brand || !model || !sourceUrl) throw new Error("Invalid Gemini response");

  return {
    selectedId,
    brand,
    model,
    sourceUrl,
    why: why.slice(0, 4),
    caveats: caveats.slice(0, 3),
    source: {
      kind: "gemini",
      usedModel: typeof rec?.usedModel === "string" ? rec.usedModel : null,
      fallbackReason: typeof rec?.fallbackReason === "string" ? rec.fallbackReason : null,
      attemptedModels: stringList(rec?.attemptedModels).filter(Boolean),
    },
  };
}
