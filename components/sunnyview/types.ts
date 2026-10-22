import type { Point } from "@/components/PanelPacking";
import type { StaticMapSpec } from "@/lib/static-map";

export type Phase = "landing" | "opening" | "app";

export type MobilePane = "setup" | "results";

export type PanelSpecMode = "auto" | "manual";

export type Estimate = {
  annualKwh: number;
  monthlyKwh: number[];
  annualCo2Kg: number;
  source: "fallback" | "server";
  assumptions?: unknown;
  /** Inputs a server estimate was computed for; see estimateInputsKey. Absent on fallbacks. */
  inputsKey?: string;
};

export type CandidatePolygon = {
  id: string;
  polygon: Point[];
  score?: number;
};

export type SegmentRoi = { x: number; y: number; w: number; h: number };

export type PanelBrandRec = {
  selectedId: string;
  brand: string;
  model: string;
  sourceUrl: string;
  why: string[];
  caveats: string[];
  source: {
    kind: "gemini" | "fallback";
    usedModel: string | null;
    fallbackReason: string | null;
    attemptedModels: string[];
  };
};

export type ExplainText = {
  bullets: string[];
  caveat: string;
};

export type RoofBackground =
  | { kind: "image"; src: string; widthPx: number; heightPx: number }
  | { kind: "none" };

export type AddressStatic = StaticMapSpec & { address: string | null };
