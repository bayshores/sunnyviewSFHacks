// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePackingAndEstimate } from "./use-packing-and-estimate";
import type { PackingAndEstimateInput } from "./use-packing-and-estimate";
import { INITIAL_ESTIMATE } from "./estimate";
import { roofPackingKey } from "./geometry";
import type { Estimate } from "./types";

const PANEL_SPEC = { widthM: 1.0, heightM: 2.0, wattW: 400, gapM: 0 };
// 100x100 px at 0.1 m/px = 10m x 10m roof.
const VERTICES = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];
const AREA = 100;

const fetchMock = vi.fn<typeof fetch>();

function makeInput(overrides: Partial<PackingAndEstimateInput> = {}): PackingAndEstimateInput {
  return {
    panelsMounted: true,
    closed: true,
    vertices: VERTICES,
    mPerPx: 0.1,
    roofAreaM2: AREA,
    panelSpec: PANEL_SPEC,
    panelSpecMode: "manual",
    panelAutoReadyKey: null,
    orientationDeg: 0,
    lat: 37.7,
    lng: -122.4,
    tiltDeg: 20,
    azimuthDeg: 180,
    lossesPct: 14,
    dcKw: 2,
    panelCount: 5,
    setPanelsPacked: vi.fn(),
    setEstimate: vi.fn(),
    ...overrides,
  };
}

const SERVER_BODY = { annualKwh: 3000, annualCo2Kg: 1200, monthlyKwh: Array.from({ length: 12 }, () => 250) };

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json(SERVER_BODY));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("usePackingAndEstimate packing", () => {
  it("packs after 80ms", async () => {
    const input = makeInput();
    renderHook(() => usePackingAndEstimate(input));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(79);
    });
    expect(input.setPanelsPacked).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const packed = vi.mocked(input.setPanelsPacked).mock.calls[0][0] as unknown[];
    expect(Array.isArray(packed)).toBe(true);
    expect(packed.length).toBeGreaterThan(30);
  });

  it("clears panels for open, tiny, or uncalibrated roofs", async () => {
    for (const overrides of [{ closed: false }, { vertices: VERTICES.slice(0, 2) }, { mPerPx: null }]) {
      const input = makeInput(overrides);
      renderHook(() => usePackingAndEstimate(input));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(80);
      });
      expect(input.setPanelsPacked).toHaveBeenCalledWith([]);
    }
  });

  it("waits for the auto-pick key in auto mode, then packs", async () => {
    const waiting = makeInput({ panelSpecMode: "auto", panelAutoReadyKey: "stale" });
    renderHook(() => usePackingAndEstimate(waiting));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    expect(waiting.setPanelsPacked).toHaveBeenCalledWith([]);

    const ready = makeInput({ panelSpecMode: "auto", panelAutoReadyKey: roofPackingKey(AREA, 4, 0.1) });
    renderHook(() => usePackingAndEstimate(ready));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(80);
    });
    expect(vi.mocked(ready.setPanelsPacked).mock.calls[0][0]).not.toEqual([]);
  });

  it("does nothing before panels mount", async () => {
    const input = makeInput({ panelsMounted: false });
    renderHook(() => usePackingAndEstimate(input));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(input.setPanelsPacked).not.toHaveBeenCalled();
    expect(input.setEstimate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("usePackingAndEstimate estimate", () => {
  it("installs a fallback estimate but never replaces a server one", () => {
    const input = makeInput();
    renderHook(() => usePackingAndEstimate(input));
    const updater = vi.mocked(input.setEstimate).mock.calls[0][0] as (prev: Estimate) => Estimate;
    expect(updater(INITIAL_ESTIMATE).source).toBe("fallback");
    expect(updater(INITIAL_ESTIMATE).annualKwh).toBeGreaterThan(0);
    const server: Estimate = { ...INITIAL_ESTIMATE, source: "server", annualKwh: 1 };
    expect(updater(server)).toBe(server);
  });

  it("fetches the server estimate after 320ms and applies it", async () => {
    const input = makeInput();
    renderHook(() => usePackingAndEstimate(input));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(319);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/estimate");
    expect(JSON.parse(String(init?.body))).toEqual({
      siteSpec: { lat: 37.7, lng: -122.4, tiltDeg: 20, azimuthDeg: 180, lossesPct: 14 },
      layoutSummary: { dcKw: 2, panelCount: 5, orientationDeg: 0 },
      panelSpec: PANEL_SPEC,
    });
    const applied = vi.mocked(input.setEstimate).mock.calls.at(-1)?.[0] as Estimate;
    expect(applied).toMatchObject({ source: "server", annualKwh: 3000, annualCo2Kg: 1200 });
  });

  it("debounces: only the latest inputs are sent", async () => {
    const input = makeInput();
    const { rerender } = renderHook((p: PackingAndEstimateInput) => usePackingAndEstimate(p), {
      initialProps: input,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    rerender({ ...input, tiltDeg: 35 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(320);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).siteSpec.tiltDeg).toBe(35);
  });

  it.each([
    ["non-OK", () => new Response("x", { status: 500 })],
    ["malformed totals", () => Response.json({ hello: "world" })],
    ["invalid JSON", () => new Response("nope")],
  ])("ignores a %s response", async (_name, make) => {
    fetchMock.mockImplementation(async () => make());
    const input = makeInput();
    renderHook(() => usePackingAndEstimate(input));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(320);
    });
    // Only the fallback updater (function) was ever applied.
    const objectCalls = vi.mocked(input.setEstimate).mock.calls.filter(([a]) => typeof a !== "function");
    expect(objectCalls).toHaveLength(0);
  });

  it("keeps the fallback on network errors", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const input = makeInput();
    renderHook(() => usePackingAndEstimate(input));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(320);
    });
    expect(vi.mocked(input.setEstimate).mock.calls.filter(([a]) => typeof a !== "function")).toHaveLength(0);
  });

  it("aborts the in-flight request when inputs change", async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>(() => {});
    });
    const input = makeInput();
    const { rerender } = renderHook((p: PackingAndEstimateInput) => usePackingAndEstimate(p), {
      initialProps: input,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(320);
    });
    rerender({ ...input, lossesPct: 20 });
    expect(signals[0].aborted).toBe(true);
  });

  it.each([
    ["no site", { lat: null }],
    ["no capacity", { dcKw: 0 }],
  ])("skips the server request with %s", async (_name, overrides) => {
    renderHook(() => usePackingAndEstimate(makeInput(overrides)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
