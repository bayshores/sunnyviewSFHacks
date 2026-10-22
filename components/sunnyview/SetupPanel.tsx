"use client";

import type { Dispatch, SetStateAction } from "react";
import { MapInput, type MapInputResult } from "@/components/MapInput";
import type { PanelSpec, PlacedPanel, Point } from "@/components/PanelPacking";
import { RoofCanvas } from "@/components/RoofCanvas";
import { coerceNumber } from "./geometry";
import type { CandidatePolygon, RoofBackground, SegmentRoi } from "./types";

const INPUT_CLASS = "h-9 w-full rounded-md border border-input bg-background/60 px-3 text-sm";

export type SetupPanelProps = {
  compact: boolean;
  onClear: () => void;
  mapInput: MapInputResult;
  onMapInputChange: (next: MapInputResult) => void;
  lat: number | null;
  setLat: Dispatch<SetStateAction<number | null>>;
  lng: number | null;
  setLng: Dispatch<SetStateAction<number | null>>;
  tiltDeg: number;
  setTiltDeg: Dispatch<SetStateAction<number>>;
  azimuthDeg: number;
  setAzimuthDeg: Dispatch<SetStateAction<number>>;
  lossesPct: number;
  setLossesPct: Dispatch<SetStateAction<number>>;
  background: RoofBackground;
  mPerPx: number | null;
  orientationDeg: number;
  setOrientationDeg: Dispatch<SetStateAction<number>>;
  panelSpec: PanelSpec;
  vertices: Point[];
  closed: boolean;
  panels: PlacedPanel[];
  onVerticesChange: (next: Point[]) => void;
  onClosedChange: (next: boolean) => void;
  onAutoOutline: (roi: SegmentRoi | null) => void;
  autoOutlineBusy: boolean;
  autoOutlineError: string | null;
  autoOutlineHint: string | null;
  candidatePolygons: CandidatePolygon[] | null;
  onPickCandidate: (id: string) => void;
  centerPin: Point | null;
};

function NumberField(props: {
  label: string;
  value: number | string;
  onChange: (raw: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="space-y-1">
      <div className="text-xs text-muted-foreground">{props.label}</div>
      <input
        className={INPUT_CLASS}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        inputMode="decimal"
      />
    </label>
  );
}

/** Left "Setup" column: site search, assumptions, roof canvas, and orientation. */
export function SetupPanel(props: SetupPanelProps) {
  const { background } = props;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">
          Site
        </div>
        <button
          type="button"
          onClick={props.onClear}
          className="rounded-full border border-border/70 bg-background/40 px-3 py-1 text-xs font-medium text-foreground transition hover:bg-background/60"
        >
          Clear
        </button>
      </div>

      <MapInput value={props.mapInput} onChange={props.onMapInputChange} compact={props.compact} />

      <div className="glass-card p-3">
        <div className="text-sm font-semibold text-foreground">
          Site + assumptions
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <NumberField
            label="Latitude"
            value={props.lat ?? ""}
            onChange={(raw) => props.setLat(coerceNumber(raw))}
            placeholder="34.0522"
          />
          <NumberField
            label="Longitude"
            value={props.lng ?? ""}
            onChange={(raw) => props.setLng(coerceNumber(raw))}
            placeholder="-118.2437"
          />
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <NumberField
            label="Tilt (deg)"
            value={props.tiltDeg}
            onChange={(raw) => props.setTiltDeg(Number(raw) || 0)}
          />
          <NumberField
            label="Azimuth (deg)"
            value={props.azimuthDeg}
            onChange={(raw) => props.setAzimuthDeg(Number(raw) || 0)}
          />
          <NumberField
            label="Losses (%)"
            value={props.lossesPct}
            onChange={(raw) => props.setLossesPct(Number(raw) || 0)}
          />
        </div>
      </div>

      <RoofCanvas
        key={
          background.kind === "image"
            ? `img:${background.src}:${background.widthPx}x${background.heightPx}`
            : background.kind
        }
        containerClassName="h-[250px] sm:h-[300px] lg:h-[min(30vh,320px)] xl:h-[min(34vh,360px)]"
        background={background}
        mPerPx={props.mPerPx}
        orientationDeg={props.orientationDeg}
        panelSpec={props.panelSpec}
        vertices={props.vertices}
        closed={props.closed}
        panels={props.panels}
        onVerticesChange={props.onVerticesChange}
        onClosedChange={props.onClosedChange}
        onAutoOutline={(o?: { roi?: SegmentRoi | null }) => {
          props.onAutoOutline(o?.roi ?? null);
        }}
        autoOutlineBusy={props.autoOutlineBusy}
        autoOutlineError={props.autoOutlineError}
        autoOutlineHint={props.autoOutlineHint}
        candidatePolygons={props.candidatePolygons}
        onPickCandidate={props.onPickCandidate}
        centerPin={props.centerPin}
      />

      <div className="glass-card p-3">
        <div className="text-sm font-semibold text-foreground">Orientation</div>
        <label className="mt-3 block space-y-1">
          <div className="text-xs text-muted-foreground">Orientation (deg)</div>
          <input
            type="range"
            min={-90}
            max={90}
            step={1}
            value={props.orientationDeg}
            onChange={(e) => props.setOrientationDeg(Number(e.target.value))}
            className="w-full"
          />
          <div className="text-xs text-muted-foreground">{props.orientationDeg}°</div>
        </label>
      </div>
    </div>
  );
}
