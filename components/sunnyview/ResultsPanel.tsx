"use client";

import type { ReactNode } from "react";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { SolarForecastCard } from "@/components/SolarForecastCard";
import { PanelModelCard, type PanelModelCardProps } from "./PanelModelCard";
import type { Estimate, ExplainText } from "./types";

const STAT_CARD_CLASS = "stagger-item gradient-border glass-surface rounded-lg p-3";
const STAT_VALUE_CLASS = "mt-1 text-lg font-semibold text-foreground text-glow";
const SECONDARY_ACTION_CLASS =
  "rounded-md bg-secondary px-3 py-2 text-xs font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50";

export type ResultsPanelProps = {
  lat: number | null;
  lng: number | null;
  dcKw: number;
  lossesPct: number;
  panelCount: number;
  estimate: Estimate;
  panelModel: Omit<PanelModelCardProps, "panelCount">;
  explainLoading: boolean;
  explainText: ExplainText | null;
  ttsLoading: boolean;
  onExplain: () => void;
  onTalk: () => void;
  onToggleShare: () => void;
  shareDisabledReason: string | null;
  showElevenLabsHint: boolean;
  onAddElevenLabsKey: () => void;
  actionNotice: string | null;
  panelCountAuto: number;
  manualPanelCount: number;
  panelCountOverride: number | null;
  onManualPanelCount: (raw: number) => void;
  onResetPanelCount: () => void;
};

function StatCard(props: { label: string; children: ReactNode }) {
  return (
    <div className={STAT_CARD_CLASS}>
      <div className="text-xs text-muted-foreground">{props.label}</div>
      <div className={STAT_VALUE_CLASS}>{props.children}</div>
    </div>
  );
}

function PanelCountCard(props: Pick<
  ResultsPanelProps,
  "panelCountAuto" | "manualPanelCount" | "panelCountOverride" | "onManualPanelCount" | "onResetPanelCount"
>) {
  const { panelCountAuto, manualPanelCount } = props;
  return (
    <div className="glass-card p-3">
      <div className="text-sm font-semibold text-foreground">
        Panel packing
      </div>
      <div className="mt-3 grid gap-3">
        <div className="glass-surface rounded-lg p-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-foreground">Panels (count)</div>
            <button
              type="button"
              className="rounded-md bg-secondary px-2.5 py-1 text-[11px] font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
              onClick={props.onResetPanelCount}
              disabled={props.panelCountOverride === null}
              title="Reset to auto"
            >
              Auto
            </button>
          </div>

          <div className="mt-2 grid grid-cols-[1fr,92px] items-center gap-2">
            <input
              type="range"
              min={0}
              max={Math.max(0, panelCountAuto)}
              step={1}
              value={manualPanelCount}
              onChange={(e) => props.onManualPanelCount(Number(e.target.value))}
              className="w-full"
              disabled={panelCountAuto <= 0}
            />
            <input
              className="h-9 w-full rounded-md border border-input bg-background/60 px-3 text-sm"
              value={manualPanelCount}
              onChange={(e) => props.onManualPanelCount(Number(e.target.value))}
              inputMode="numeric"
              disabled={panelCountAuto <= 0}
            />
          </div>

          <div className="mt-1 text-[11px] text-muted-foreground">
            Auto fits {panelCountAuto}. Manual resets when you edit the roof or search a new address.
          </div>
        </div>
      </div>
    </div>
  );
}

/** Right "Results" column: forecast, stats, panel model, actions, and panel count. */
export function ResultsPanel(props: ResultsPanelProps) {
  const { estimate, panelCount, dcKw, explainText, shareDisabledReason, actionNotice } = props;
  return (
    <div className="space-y-3">
      <SolarForecastCard
        className="glass-card p-3"
        lat={props.lat}
        lng={props.lng}
        dcKw={dcKw}
        lossesPct={props.lossesPct}
        panelCount={panelCount}
      />

      <div className="glass-card p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-foreground">Results</div>
          <div className="text-xs text-muted-foreground">
            {estimate.source === "server" ? "Server estimate" : "Fallback"}
          </div>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <StatCard label="Panels">
            <AnimatedNumber value={panelCount} />
          </StatCard>
          <StatCard label="DC kW">
            <AnimatedNumber value={dcKw} formatFn={(n) => n.toFixed(1)} />
          </StatCard>
          <StatCard label="Annual kWh">
            <AnimatedNumber value={estimate.annualKwh} />
          </StatCard>
          <StatCard label="Annual CO₂ (kg)">
            <AnimatedNumber value={estimate.annualCo2Kg} />
          </StatCard>
        </div>

        <PanelModelCard {...props.panelModel} panelCount={panelCount} />

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            onClick={props.onExplain}
            disabled={props.explainLoading || panelCount === 0}
          >
            {props.explainLoading ? "Explaining…" : "Explain"}
          </button>
          <button
            type="button"
            className={SECONDARY_ACTION_CLASS}
            onClick={props.onTalk}
            disabled={props.ttsLoading || panelCount === 0}
          >
            {props.ttsLoading ? "Talking…" : "Talk"}
          </button>
          <button
            type="button"
            className={SECONDARY_ACTION_CLASS}
            onClick={props.onToggleShare}
            disabled={shareDisabledReason !== null}
            title={shareDisabledReason ?? "Share"}
          >
            Share
          </button>
        </div>

        {props.showElevenLabsHint && (
          <button
            type="button"
            onClick={props.onAddElevenLabsKey}
            className="mt-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground hover:no-underline"
          >
            Add ElevenLabs key on landing to enable Talk
          </button>
        )}

        {(actionNotice || shareDisabledReason) && (
          <div className="mt-2 text-xs text-muted-foreground">
            {actionNotice ?? shareDisabledReason}
          </div>
        )}

        {explainText && (
          <div className="glass-surface mt-3 rounded-lg p-3 text-sm text-foreground">
            <ul className="list-disc space-y-1 pl-5">
              {explainText.bullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
            <div className="mt-2 text-xs text-muted-foreground">
              {explainText.caveat}
            </div>
          </div>
        )}
      </div>

      <PanelCountCard
        panelCountAuto={props.panelCountAuto}
        manualPanelCount={props.manualPanelCount}
        panelCountOverride={props.panelCountOverride}
        onManualPanelCount={props.onManualPanelCount}
        onResetPanelCount={props.onResetPanelCount}
      />
    </div>
  );
}
