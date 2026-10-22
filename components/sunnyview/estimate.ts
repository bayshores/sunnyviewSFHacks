import { fallbackAnnualEstimate } from "@/lib/solar-defaults";
import { asRecord, coerceNumber } from "./geometry";
import type { Estimate, ExplainText } from "./types";

export const INITIAL_ESTIMATE: Estimate = {
  annualKwh: 0,
  monthlyKwh: Array.from({ length: 12 }, () => 0),
  annualCo2Kg: 0,
  source: "fallback",
};

/** Client-side estimate used until the server (PVWatts) estimate arrives. */
export function fallbackEstimateFor(dcKw: number): Estimate {
  return { ...fallbackAnnualEstimate(dcKw), source: "fallback" };
}

/** Parse a /api/estimate body; null when annual totals are missing. */
export function parseEstimateResponse(data: unknown): Estimate | null {
  const rec = asRecord(data);
  const nested = asRecord(rec?.estimate);
  const annualKwh = coerceNumber(rec?.annualKwh) ?? coerceNumber(nested?.annualKwh);
  const annualCo2Kg = coerceNumber(rec?.annualCo2Kg) ?? coerceNumber(nested?.annualCo2Kg);
  const monthlyRaw = rec?.monthlyKwh;
  const monthlyKwh = Array.isArray(monthlyRaw) ? monthlyRaw.map((v: unknown) => Number(v) || 0) : null;
  if (annualKwh === null || annualCo2Kg === null) return null;
  return {
    annualKwh,
    annualCo2Kg,
    monthlyKwh:
      monthlyKwh && monthlyKwh.length === 12 ? monthlyKwh : Array.from({ length: 12 }, () => annualKwh / 12),
    source: "server",
    assumptions: rec?.assumptions ?? nested?.assumptions,
  };
}

export const DEFAULT_EXPLAIN_CAVEAT =
  "Solar output is an estimate; shading, tilt, and local conditions can change results.";

export function summaryBullets(panelCount: number, dcKw: number, estimate: Estimate): string[] {
  return [
    `This layout fits ${panelCount} panels (${dcKw.toFixed(1)} kW DC).`,
    `Estimated annual energy: ${Math.round(estimate.annualKwh).toLocaleString()} kWh.`,
    `Estimated annual CO₂ avoided: ${Math.round(estimate.annualCo2Kg).toLocaleString()} kg.`,
  ];
}

/** Explain text from a successful /api/explain body, falling back to local summary bullets. */
export function explainTextFromResponse(
  data: unknown,
  fallback: { panelCount: number; dcKw: number; estimate: Estimate },
): ExplainText {
  const rec = asRecord(data);
  const bullets = Array.isArray(rec?.bullets) ? rec.bullets.map((b: unknown) => String(b)) : null;
  const caveats = rec?.caveats;
  const caveat = rec?.caveat
    ? String(rec.caveat)
    : Array.isArray(caveats) && caveats.length
      ? String(caveats[0])
      : DEFAULT_EXPLAIN_CAVEAT;
  if (bullets && bullets.length) return { bullets: bullets.slice(0, 3), caveat };
  return { bullets: summaryBullets(fallback.panelCount, fallback.dcKw, fallback.estimate), caveat };
}

export function errorFromResponse(data: unknown, fallbackMessage: string): string {
  const rec = asRecord(data);
  return typeof rec?.error === "string" ? rec.error : fallbackMessage;
}
