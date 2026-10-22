// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapInputResult } from "@/components/MapInput";
import { PANEL_OPTIONS } from "@/lib/panels";
import { computePanelFit, polygonDominantEdgeAxisDeg } from "./geometry";
import { GEMINI_KEY_STORAGE, GEMINI_KEY_WITHHELD_NOTICE } from "./local-keys";
import { usePanelSelection } from "./use-panel-selection";
import type { PanelSelectionInput } from "./use-panel-selection";

const PANEL_SPEC = { widthM: 1.1, heightM: 1.7, wattW: 400, gapM: 0.02 };
const VERTICES = [
  { x: 0, y: 0 },
  { x: 200, y: 0 },
  { x: 200, y: 120 },
  { x: 0, y: 120 },
];
const MAP_INPUT: MapInputResult = { kind: "address", address: "x", lat: 37.7, lng: -122.4, zoom: 19, mPerPx: 0.1 };

const fetchMock = vi.fn<typeof fetch>();

function makeInput(overrides: Partial<PanelSelectionInput> = {}): PanelSelectionInput {
  return {
    panelsMounted: true,
    mapInput: MAP_INPUT,
    lat: 37.7,
    lng: -122.4,
    closed: true,
    vertices: VERTICES,
    mPerPx: 0.1,
    roofAreaM2: 240,
    orientationDeg: 0,
    roofAxisHintDeg: null,
    panelSpec: PANEL_SPEC,
    panelSpecMode: "manual",
    panelChoiceId: "custom",
    setPanelSpec: vi.fn(),
    setPanelSpecMode: vi.fn(),
    setPanelChoiceId: vi.fn(),
    setOrientationDeg: vi.fn(),
    setActionNotice: vi.fn(),
    ...overrides,
  };
}

function recommendation(selectedId: string): Record<string, unknown> {
  return { selectedId, brand: "B", model: "M", sourceUrl: "https://example.com", why: ["a"], caveats: [] };
}

function headersOf(call = 0): Record<string, string> {
  return fetchMock.mock.calls[call][1]?.headers as Record<string, string>;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json(recommendation(PANEL_OPTIONS[0].id)));
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("usePanelSelection auto pick", () => {
  it("picks the catalog panel with the highest DC capacity and marks the roof ready", () => {
    const input = makeInput({ panelSpecMode: "auto" });
    const { result } = renderHook(() => usePanelSelection(input));

    const axis = polygonDominantEdgeAxisDeg(VERTICES);
    const dc = PANEL_OPTIONS.map((o) => computePanelFit(VERTICES, 0.1, o.spec, axis).dcKw);
    const bestIdx = dc.indexOf(Math.max(...dc));
    expect(input.setPanelChoiceId).toHaveBeenCalledWith(PANEL_OPTIONS[bestIdx].id);
    expect(input.setPanelSpec).toHaveBeenCalledWith(PANEL_OPTIONS[bestIdx].spec);
    expect(input.setOrientationDeg).toHaveBeenCalledTimes(1);
    expect(result.current.panelAutoReadyKey).not.toBeNull();
  });

  it("runs once per roof key and again after resetAutoPick", () => {
    const input = makeInput({ panelSpecMode: "auto" });
    const { result, rerender } = renderHook((p: PanelSelectionInput) => usePanelSelection(p), {
      initialProps: input,
    });
    rerender({ ...input, orientationDeg: 5 });
    expect(input.setPanelChoiceId).toHaveBeenCalledTimes(1);
    act(() => result.current.resetAutoPick());
    expect(result.current.panelAutoReadyKey).toBeNull();
    rerender({ ...input, orientationDeg: 6, vertices: [...VERTICES] });
    expect(input.setPanelChoiceId).toHaveBeenCalledTimes(2);
  });

  it("does not auto pick in manual mode, before mount, or for an open ring", () => {
    for (const overrides of [{}, { panelsMounted: false, panelSpecMode: "auto" as const }, { closed: false }]) {
      const input = makeInput({ panelSpecMode: "manual", ...overrides });
      renderHook(() => usePanelSelection(input));
      expect(input.setPanelChoiceId).not.toHaveBeenCalled();
    }
    const open = makeInput({ panelSpecMode: "auto", closed: false });
    renderHook(() => usePanelSelection(open));
    expect(open.setPanelChoiceId).not.toHaveBeenCalled();
  });

  it("togglePanelSpecMode flips the mode and forgets the pick", () => {
    const input = makeInput();
    const { result } = renderHook(() => usePanelSelection(input));
    act(() => result.current.togglePanelSpecMode());
    const updater = vi.mocked(input.setPanelSpecMode).mock.calls[0][0] as (m: "auto" | "manual") => string;
    expect(updater("auto")).toBe("manual");
    expect(updater("manual")).toBe("auto");
  });

  it("clears the ready key when switching away from auto mode", () => {
    const input = makeInput({ panelSpecMode: "auto" });
    const { result, rerender } = renderHook((p: PanelSelectionInput) => usePanelSelection(p), {
      initialProps: input,
    });
    expect(result.current.panelAutoReadyKey).not.toBeNull();
    rerender({ ...input, panelSpecMode: "manual" });
    expect(result.current.panelAutoReadyKey).toBeNull();
  });
});

describe("usePanelSelection Gemini request", () => {
  it("auto-runs once per address after the roof is traced", async () => {
    const input = makeInput();
    const { rerender } = renderHook((p: PanelSelectionInput) => usePanelSelection(p), { initialProps: input });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/panel-recommend");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ lat: 37.7, lng: -122.4, roofAreaM2: 240, currentId: "custom" });
    expect(body.options.length).toBe(PANEL_OPTIONS.length + 1);
    expect(body.options[0].id).toBe("custom");

    rerender({ ...input, vertices: [...VERTICES] });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stores the recommendation and, in auto mode, applies the picked panel", async () => {
    const pickId = PANEL_OPTIONS[PANEL_OPTIONS.length - 1].id;
    fetchMock.mockImplementation(async () => Response.json(recommendation(pickId)));
    const input = makeInput({ panelSpecMode: "auto" });
    const { result } = renderHook(() => usePanelSelection(input));
    await act(async () => {});
    expect(result.current.panelBrandRec?.selectedId).toBe(pickId);
    expect(result.current.panelBrandRec?.source.kind).toBe("gemini");
    expect(vi.mocked(input.setPanelChoiceId).mock.calls.at(-1)?.[0]).toBe(pickId);
    expect(result.current.panelBrandBusy).toBe(false);
  });

  it("does not apply the recommendation to the layout in manual mode", async () => {
    const input = makeInput({ panelSpecMode: "manual" });
    const { result } = renderHook(() => usePanelSelection(input));
    await act(async () => {});
    expect(result.current.panelBrandRec).not.toBeNull();
    expect(input.setPanelChoiceId).not.toHaveBeenCalled();
  });

  it("sends the Gemini key only when the API is same-origin", async () => {
    window.localStorage.setItem(GEMINI_KEY_STORAGE, "  secret-key  ");
    const input = makeInput();
    renderHook(() => usePanelSelection(input));
    await act(async () => {});
    expect(headersOf()).toEqual({ "content-type": "application/json", "x-gemini-api-key": "secret-key" });
    expect(input.setActionNotice).not.toHaveBeenCalled();
  });

  it("withholds the Gemini key for a cross-origin backend and tells the user", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_ORIGIN", "https://api.example.com/");
    window.localStorage.setItem(GEMINI_KEY_STORAGE, "secret-key");
    const input = makeInput();
    renderHook(() => usePanelSelection(input));
    await act(async () => {});
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.com/api/panel-recommend");
    expect(headersOf()).toEqual({ "content-type": "application/json" });
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain("secret-key");
    expect(input.setActionNotice).toHaveBeenCalledWith(GEMINI_KEY_WITHHELD_NOTICE);
  });

  it("sends no key header when none is stored", async () => {
    const input = makeInput();
    renderHook(() => usePanelSelection(input));
    await act(async () => {});
    expect(headersOf()).toEqual({ "content-type": "application/json" });
  });

  it("normalises missing-key errors and lists attempted models", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ error: "Missing GEMINI_API_KEY", attemptedModels: ["m1", "m2"] }, { status: 400 }),
    );
    const input = makeInput();
    const { result } = renderHook(() => usePanelSelection(input));
    await act(async () => {});
    expect(result.current.panelBrandError).toBe(
      "Missing Gemini API key. Add it on the landing page. (models tried: m1, m2)",
    );
    expect(result.current.panelBrandBusy).toBe(false);
  });

  it("falls back to a status message when the error body is unreadable", async () => {
    fetchMock.mockImplementation(async () => new Response("x", { status: 500 }));
    const input = makeInput();
    const { result } = renderHook(() => usePanelSelection(input));
    await act(async () => {});
    expect(result.current.panelBrandError).toBe("Panel recommendation failed (500)");
  });

  it("rejects an invalid recommendation body", async () => {
    fetchMock.mockImplementation(async () => Response.json({ selectedId: "x" }));
    const input = makeInput();
    const { result } = renderHook(() => usePanelSelection(input));
    await act(async () => {});
    expect(result.current.panelBrandError).toBe("Invalid Gemini response");
    expect(result.current.panelBrandRec).toBeNull();
  });

  it("askGemini re-requests and clears the previous result", async () => {
    const input = makeInput();
    const { result } = renderHook(() => usePanelSelection(input));
    await act(async () => {});
    expect(result.current.panelBrandRec).not.toBeNull();
    await act(async () => {
      result.current.askGemini();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports missing roof or address context for a manual ask", async () => {
    const noRoofInput = makeInput({ closed: false });
    const noRoof = renderHook(() => usePanelSelection(noRoofInput));
    await act(async () => {
      noRoof.result.current.askGemini();
    });
    expect(noRoof.result.current.panelBrandError).toBe("Trace and calibrate a roof area first.");

    const noSiteInput = makeInput({ lat: null });
    const noSite = renderHook(() => usePanelSelection(noSiteInput));
    await act(async () => {
      noSite.result.current.askGemini();
    });
    expect(noSite.result.current.panelBrandError).toBe("Set an address first.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts the in-flight request on unmount without reporting an error", async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((_res, rej) =>
        signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))),
      );
    });
    const input = makeInput();
    const { unmount } = renderHook(() => usePanelSelection(input));
    await act(async () => {});
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
