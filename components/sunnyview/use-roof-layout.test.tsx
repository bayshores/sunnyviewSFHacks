// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PlacedPanel } from "@/components/PanelPacking";
import type { HistorySnapshot } from "@/lib/history-types";
import { useRoofLayout } from "./use-roof-layout";

afterEach(cleanup);

function panels(n: number): PlacedPanel[] {
  return Array.from({ length: n }, (_, i) => ({ id: i }) as unknown as PlacedPanel);
}

const SQUARE = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

describe("useRoofLayout panel count override", () => {
  it("uses all packed panels with no override and derives dcKw", () => {
    const { result } = renderHook(() => useRoofLayout({ mPerPx: 0.1 }));
    act(() => result.current.setPanelsPacked(panels(10)));
    expect(result.current.panelCountAuto).toBe(10);
    expect(result.current.panelCount).toBe(10);
    expect(result.current.manualPanelCount).toBe(10);
    expect(result.current.dcKw).toBeCloseTo(4);
  });

  it("slices to the override and rounds to an integer", () => {
    const { result } = renderHook(() => useRoofLayout({ mPerPx: 0.1 }));
    act(() => result.current.setPanelsPacked(panels(10)));
    act(() => result.current.setManualPanelCount(3.6));
    expect(result.current.panelCount).toBe(4);
    expect(result.current.panelCountOverride).toBe(4);
    expect(result.current.panels).toHaveLength(4);
    expect(result.current.dcKw).toBeCloseTo(1.6);
  });

  it("clamps negatives to zero", () => {
    const { result } = renderHook(() => useRoofLayout({ mPerPx: 0.1 }));
    act(() => result.current.setPanelsPacked(panels(10)));
    act(() => result.current.setManualPanelCount(-5));
    expect(result.current.panelCount).toBe(0);
    expect(result.current.dcKw).toBe(0);
  });

  it("clears the override when the requested count reaches or exceeds the max", () => {
    const { result } = renderHook(() => useRoofLayout({ mPerPx: 0.1 }));
    act(() => result.current.setPanelsPacked(panels(10)));
    act(() => result.current.setManualPanelCount(4));
    expect(result.current.panelCountOverride).toBe(4);
    act(() => result.current.setManualPanelCount(10));
    expect(result.current.panelCountOverride).toBeNull();
    act(() => result.current.setManualPanelCount(4));
    act(() => result.current.setManualPanelCount(99));
    expect(result.current.panelCountOverride).toBeNull();
    expect(result.current.panelCount).toBe(10);
  });

  it("ignores non-finite counts", () => {
    const { result } = renderHook(() => useRoofLayout({ mPerPx: 0.1 }));
    act(() => result.current.setPanelsPacked(panels(10)));
    act(() => result.current.setManualPanelCount(4));
    act(() => result.current.setManualPanelCount(Number.NaN));
    act(() => result.current.setManualPanelCount(Number.POSITIVE_INFINITY));
    expect(result.current.panelCountOverride).toBe(4);
  });

  it("re-clamps the override when repacking shrinks the available panels", () => {
    const { result } = renderHook(() => useRoofLayout({ mPerPx: 0.1 }));
    act(() => result.current.setPanelsPacked(panels(10)));
    act(() => result.current.setManualPanelCount(8));
    act(() => result.current.setPanelsPacked(panels(6)));
    expect(result.current.panelCountOverride).toBeNull();
    expect(result.current.panelCount).toBe(6);
  });

  it("re-clamps a fractional override set directly", () => {
    const { result } = renderHook(() => useRoofLayout({ mPerPx: 0.1 }));
    act(() => result.current.setPanelsPacked(panels(10)));
    act(() => result.current.setPanelCountOverride(3.7));
    expect(result.current.panelCountOverride).toBe(3);
    expect(result.current.panelCount).toBe(3);
  });

  it("drops the override entirely when nothing is packed", () => {
    const { result } = renderHook(() => useRoofLayout({ mPerPx: 0.1 }));
    act(() => result.current.setPanelsPacked(panels(5)));
    act(() => result.current.setManualPanelCount(2));
    act(() => result.current.setPanelsPacked([]));
    expect(result.current.panelCountOverride).toBeNull();
    expect(result.current.panelCount).toBe(0);
  });
});

describe("useRoofLayout geometry", () => {
  it("computes roof area only for a calibrated closed ring", () => {
    const { result, rerender } = renderHook((p: { mPerPx: number | null }) => useRoofLayout(p), {
      initialProps: { mPerPx: 0.1 as number | null },
    });
    expect(result.current.roofAreaM2).toBeNull();
    act(() => result.current.setVertices(SQUARE));
    expect(result.current.roofAreaM2).toBeNull();
    act(() => result.current.setClosed(true));
    expect(result.current.roofAreaM2).toBeCloseTo(100);
    rerender({ mPerPx: null });
    expect(result.current.roofAreaM2).toBeNull();
  });

  it("clearRoof resets geometry, packed panels and the override", () => {
    const { result } = renderHook(() => useRoofLayout({ mPerPx: 0.1 }));
    act(() => {
      result.current.setVertices(SQUARE);
      result.current.setClosed(true);
      result.current.setPanelsPacked(panels(5));
    });
    act(() => result.current.setManualPanelCount(2));
    act(() => result.current.clearRoof());
    expect(result.current).toMatchObject({ vertices: [], closed: false, panelsPacked: [], panelCountOverride: null });
  });

  it("labels the panel choice", () => {
    const { result } = renderHook(() => useRoofLayout({ mPerPx: null }));
    act(() => result.current.setPanelChoiceId("custom"));
    expect(result.current.panelChoiceLabel).toBe("Custom");
    act(() => result.current.setPanelChoiceId("no-such-panel"));
    expect(result.current.panelChoiceLabel).toBe("Standard");
  });
});

describe("useRoofLayout applySnapshotLayout", () => {
  const snapshot = (monthly: number[]) =>
    ({
      panelSpec: { widthM: 1, heightM: 2, wattW: 300, gapM: 0.01 },
      layoutSummary: { orientationDeg: 12 },
      geometry: { vertices: SQUARE, closed: true },
      estimate: { annualKwh: 900, monthlyKwh: monthly, annualCo2Kg: 400, assumptions: { a: 1 } },
    }) as unknown as HistorySnapshot;

  it("restores panel, geometry and a 12-month server estimate in manual mode", () => {
    const { result } = renderHook(() => useRoofLayout({ mPerPx: 0.1 }));
    act(() => result.current.applySnapshotLayout(snapshot(Array.from({ length: 12 }, () => 75))));
    expect(result.current.panelSpec).toEqual({ widthM: 1, heightM: 2, wattW: 300, gapM: 0.01 });
    expect(result.current).toMatchObject({ panelSpecMode: "manual", panelChoiceId: "custom", orientationDeg: 12 });
    expect(result.current.closed).toBe(true);
    expect(result.current.vertices).toEqual(SQUARE);
    expect(result.current.vertices).not.toBe(SQUARE);
    expect(result.current.estimate).toMatchObject({ source: "server", annualKwh: 900 });
  });

  it("keeps the current estimate when the snapshot does not have 12 months", () => {
    const { result } = renderHook(() => useRoofLayout({ mPerPx: 0.1 }));
    act(() => result.current.applySnapshotLayout(snapshot([1, 2, 3])));
    expect(result.current.estimate.source).toBe("fallback");
  });
});
