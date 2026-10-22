// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePackingAndEstimate } from "./use-packing-and-estimate";
import type { PackingAndEstimateInput } from "./use-packing-and-estimate";
import { estimateInputsKey, INITIAL_ESTIMATE, snapshotEstimateKey } from "./estimate";
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
  it("installs a fallback estimate but keeps a server one computed for the current inputs", () => {
    const input = makeInput();
    renderHook(() => usePackingAndEstimate(input));
    const updater = vi.mocked(input.setEstimate).mock.calls[0][0] as (prev: Estimate) => Estimate;
    expect(updater(INITIAL_ESTIMATE).source).toBe("fallback");
    expect(updater(INITIAL_ESTIMATE).annualKwh).toBeGreaterThan(0);
    const key = estimateInputsKey({ lat: 37.7, lng: -122.4, tiltDeg: 20, azimuthDeg: 180, lossesPct: 14 }, 2);
    const server: Estimate = { ...INITIAL_ESTIMATE, source: "server", annualKwh: 1, inputsKey: key };
    expect(updater(server)).toBe(server);
    // A server estimate without a matching key is never shown.
    expect(updater({ ...server, inputsKey: undefined }).source).toBe("fallback");
    expect(updater({ ...server, inputsKey: "other|2" }).source).toBe("fallback");
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

describe("usePackingAndEstimate stale estimates", () => {
  type Props = Omit<PackingAndEstimateInput, "setEstimate">;
  const baseProps = (o: Partial<Props> = {}): Props => {
    const { setEstimate: ignored, ...rest } = makeInput(o);
    void ignored;
    return rest;
  };
  const harness = (initial: Props, initialEstimate: Estimate = INITIAL_ESTIMATE) =>
    renderHook(
      (p: Props) => {
        const [estimate, setEstimate] = useState<Estimate>(initialEstimate);
        usePackingAndEstimate({ ...p, setEstimate });
        return { estimate, setEstimate };
      },
      { initialProps: initial },
    );
  const settle = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  it("drops address A's server estimate when the site changes to B", async () => {
    const { result, rerender } = harness(baseProps());
    await settle(400);
    expect(result.current.estimate).toMatchObject({ source: "server", annualKwh: 3000, annualCo2Kg: 1200 });

    // B's estimate never arrives.
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    rerender(baseProps({ lat: 40.7, lng: -74 }));
    expect(result.current.estimate.source).toBe("fallback");
    expect(result.current.estimate.annualKwh).not.toBe(3000);
    await settle(400);
    expect(result.current.estimate.source).toBe("fallback");
  });

  it("resets to zero when the site is cleared or the roof has no panels", async () => {
    const { result, rerender } = harness(baseProps());
    await settle(400);
    rerender(baseProps({ lat: null, lng: null, dcKw: 0, panelCount: 0 }));
    expect(result.current.estimate).toMatchObject({ source: "fallback", annualKwh: 0, annualCo2Kg: 0 });
  });

  it("does not apply a server response computed for the old inputs", async () => {
    let resolveA: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveA = resolve;
        }),
    );
    const { result, rerender } = harness(baseProps());
    await settle(400);
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    rerender(baseProps({ lat: 40.7, lng: -74 }));
    await act(async () => resolveA(Response.json(SERVER_BODY)));
    await settle(400);
    expect(result.current.estimate.source).toBe("fallback");
  });

  it("keeps a saved history estimate for its own site until a fresh server estimate arrives", () => {
    const site = { lat: 37.7, lng: -122.4, tiltDeg: 20, azimuthDeg: 180, lossesPct: 14 };
    const saved: Estimate = {
      ...INITIAL_ESTIMATE,
      source: "server",
      annualKwh: 777,
      annualCo2Kg: 300,
      inputsKey: snapshotEstimateKey(site),
    };
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const { result, rerender } = harness(baseProps({ dcKw: 0, panelCount: 0 }), saved);
    expect(result.current.estimate.annualKwh).toBe(777);
    rerender(baseProps({ dcKw: 2 }));
    expect(result.current.estimate).toMatchObject({ source: "server", annualKwh: 777 });
    rerender(baseProps({ dcKw: 2, lat: 1, lng: 2 }));
    expect(result.current.estimate.source).toBe("fallback");
  });
});
