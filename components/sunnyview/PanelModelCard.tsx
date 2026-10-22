"use client";

import { safeHttpsUrl } from "./safe-url";
import type { PanelBrandRec, PanelSpecMode } from "./types";

export type PanelModelCardProps = {
  panelChoiceLabel: string;
  panelSpecMode: PanelSpecMode;
  panelCount: number;
  panelBrandRec: PanelBrandRec | null;
  panelBrandBusy: boolean;
  panelBrandError: string | null;
  onToggleMode: () => void;
  onAskGemini: () => void;
};

function sourceLabel(rec: PanelBrandRec): string {
  if (rec.source.kind === "fallback") return "Local fallback";
  return rec.source.usedModel ? `Gemini (${rec.source.usedModel})` : "Gemini";
}

/** Panel model selection status with Lock/Auto and "Ask Gemini" controls. */
export function PanelModelCard(props: PanelModelCardProps) {
  const { panelBrandRec, panelSpecMode } = props;
  const safeSourceUrl = safeHttpsUrl(panelBrandRec?.sourceUrl);
  return (
    <div className="glass-surface mt-3 rounded-lg p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-foreground">Panel model</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {props.panelChoiceLabel} • {panelSpecMode === "auto" ? "auto" : "locked"}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-md bg-secondary px-3 py-1.5 text-[11px] font-medium text-secondary-foreground hover:bg-secondary/80"
            onClick={props.onToggleMode}
            title={panelSpecMode === "auto" ? "Lock panel model selection" : "Switch back to auto selection"}
          >
            {panelSpecMode === "auto" ? "Lock" : "Auto"}
          </button>
          <button
            type="button"
            className="rounded-md bg-secondary px-3 py-1.5 text-[11px] font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
            onClick={props.onAskGemini}
            disabled={props.panelCount === 0}
            title="Re-run Gemini recommendation"
          >
            {props.panelBrandBusy ? "Gemini…" : "Ask Gemini"}
          </button>
        </div>
      </div>

      {panelBrandRec && (
        <div className="mt-2 text-xs text-muted-foreground">
          <div className="text-foreground">
            Gemini pick: <span className="font-medium">{panelBrandRec.brand}</span> — {panelBrandRec.model}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Source:{" "}
            {sourceLabel(panelBrandRec)}
          </div>
          <div className="mt-1 text-[11px]">
            Panel info:{" "}
            {safeSourceUrl ? (
              <a className="underline underline-offset-2 hover:no-underline" href={safeSourceUrl} target="_blank" rel="noreferrer">{panelBrandRec.sourceUrl}</a>
            ) : (
              <span>{panelBrandRec.sourceUrl}</span>
            )}
          </div>
          {panelBrandRec.source.kind === "fallback" && panelBrandRec.source.fallbackReason ? (
            <div className="mt-1 text-[11px] text-muted-foreground">
              Reason: {panelBrandRec.source.fallbackReason}
            </div>
          ) : null}
          {panelBrandRec.why?.length ? (
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {panelBrandRec.why.slice(0, 3).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      {props.panelBrandError && (
        <div className="mt-2 text-xs text-muted-foreground">
          Gemini unavailable: <span className="text-muted-foreground">{props.panelBrandError}</span>
        </div>
      )}
      {panelBrandRec?.caveats?.length ? (
        <div className="mt-2 text-[11px] text-muted-foreground">
          {panelBrandRec.caveats.slice(0, 2).join(" ")}
        </div>
      ) : null}
    </div>
  );
}
