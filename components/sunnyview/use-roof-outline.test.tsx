// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapInputResult } from "@/components/MapInput";
import { buildStaticMapSpec } from "@/lib/static-map";
import { useRoofOutline } from "./use-roof-outline";
import type { RoofOutlineInput } from "./use-roof-outline";
import type { AddressStatic } from "./types";

const PANEL_SPEC = { widthM: 1.1, heightM: 1.7, wattW: 400, gapM: 0.02 };
const POLY = [
  { x: 100, y: 100 },
  { x: 300, y: 100 },
  { x: 300, y: 250 },
  { x: 100, y: 250 },
];
const POLY_B = [
  { x: 400, y: 400 },
  { x: 500, y: 400 },
  { x: 500, y: 480 },
  { x: 400, y: 480 },
];

function addressStatic(lat = 37.77, lng = -122.41, zoom = 19): AddressStatic {
  return { ...buildStaticMapSpec({ lat, lng, zoom }), address: "1 Main St" };
}

function addressInput(lat = 37.77, lng = -122.41, zoom = 19): MapInputResult {
  return { kind: "address", address: "1 Main St", lat, lng, zoom, mPerPx: 0.1 };
}

function makeInput(overrides: Partial<RoofOutlineInput> = {}): RoofOutlineInput {
  return {
    panelsMounted: true,
    mapInput: addressInput(),
    addressStatic: addressStatic(),
    mPerPx: 0.1,
    panelSpec: PANEL_SPEC,
    setVertices: vi.fn(),
    setClosed: vi.fn(),
    setPanelsPacked: vi.fn(),
    setPanelCountOverride: vi.fn(),
    setOrientationDeg: vi.fn(),
    setAzimuthDeg: vi.fn(),
    setRoofAxisHintDeg: vi.fn(),
    clearRoof: vi.fn(),
    resetAutoPick: vi.fn(),
    ...overrides,
  };
}

const fetchMock = vi.fn<typeof fetch>();

function bodyOf(call: number): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[call][1]?.body));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useRoofOutline", () => {
  it("auto-segments an address once per lat/lng/zoom key", async () => {
    fetchMock.mockImplementation(async () => Response.json({ roofPolygon: POLY }));
    const input = makeInput();
    const { result, rerender } = renderHook((p: RoofOutlineInput) => useRoofOutline(p), { initialProps: input });
    await act(async () => {});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(input.clearRoof).toHaveBeenCalledTimes(1);
    expect(input.resetAutoPick).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/segment");
    expect(init?.method).toBe("POST");
    const body = bodyOf(0);
    expect(body.imageUrl).toMatch(/^\/api\/static-map\?/);
    expect(body.mode).toBe("roof");
    expect(body.meta).toMatchObject({ lat: 37.77, lng: -122.41, zoom: 19, address: "1 Main St" });

    expect(input.setVertices).toHaveBeenCalledWith(POLY);
    expect(input.setClosed).toHaveBeenCalledWith(true);
    expect(input.setPanelsPacked).toHaveBeenCalledWith([]);
    expect(input.setPanelCountOverride).toHaveBeenCalledWith(null);
    expect(input.setOrientationDeg).toHaveBeenCalled();
    expect(result.current.autoOutlineBusy).toBe(false);
    expect(result.current.autoOutlineError).toBeNull();

    // Same key: no refetch even when the objects are recreated.
    rerender({ ...input, mapInput: addressInput(), addressStatic: addressStatic() });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // New key: refetch.
    rerender({ ...input, mapInput: addressInput(40, -100, 19), addressStatic: addressStatic(40, -100, 19) });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not auto-segment before panels mount or without a static map", async () => {
    fetchMock.mockImplementation(async () => Response.json({ roofPolygon: POLY }));
    renderHook(() => useRoofOutline(makeInput({ panelsMounted: false })));
    renderHook(() => useRoofOutline(makeInput({ addressStatic: null })));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("parses candidates and shows the multiple-roofs hint", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({
        candidates: [
          { id: "a", polygon: POLY, score: 0.9 },
          { id: "b", polygon: POLY_B },
        ],
      }),
    );
    const input = makeInput();
    const { result } = renderHook(() => useRoofOutline(input));
    await act(async () => {});
    expect(result.current.candidatePolygons?.map((c) => c.id)).toEqual(["a", "b"]);
    expect(result.current.candidatePolygons?.[0].score).toBe(0.9);
    // Primary falls back to the first candidate.
    expect(input.setVertices).toHaveBeenCalledWith(POLY);
    expect(result.current.autoOutlineHint).toBe("Multiple roofs nearby. Click Edit to pick.");
  });

  it("applies suggested orientation and azimuth, and uses the axis hint without mPerPx", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ roofPolygon: POLY, suggestedOrientationDeg: 30, suggestedAzimuthDeg: 370 }),
    );
    const input = makeInput({ mPerPx: null });
    renderHook(() => useRoofOutline(input));
    await act(async () => {});
    expect(input.setRoofAxisHintDeg).toHaveBeenCalledWith(30);
    expect(input.setOrientationDeg).toHaveBeenCalledWith(30);
    expect(input.setAzimuthDeg).toHaveBeenCalledWith(10);
  });

  it("sets an error from a non-OK response", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: "segmenter down" }, { status: 502 }));
    const input = makeInput();
    const { result } = renderHook(() => useRoofOutline(input));
    await act(async () => {});
    expect(result.current.autoOutlineError).toBe("segmenter down");
    expect(result.current.autoOutlineBusy).toBe(false);
    expect(input.setVertices).not.toHaveBeenCalled();
  });

  it("uses an HTTP status message when the error body is unreadable", async () => {
    fetchMock.mockImplementation(async () => new Response("nope", { status: 500 }));
    const { result } = renderHook(() => useRoofOutline(makeInput()));
    await act(async () => {});
    expect(result.current.autoOutlineError).toBe("Segmentation failed (HTTP 500)");
  });

  it("errors when no polygon is returned", async () => {
    fetchMock.mockImplementation(async () => Response.json({ note: "empty" }));
    const { result } = renderHook(() => useRoofOutline(makeInput()));
    await act(async () => {});
    expect(result.current.autoOutlineError).toBe("No roof polygon returned");
  });

  it("reports a network failure as an error", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useRoofOutline(makeInput()));
    await act(async () => {});
    expect(result.current.autoOutlineError).toBe("offline");
  });

  it("aborts the previous request when a new one starts and ignores its result", async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(r: Response) => void> = [];
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signals.push(signal);
          resolvers.push(resolve);
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const manual = makeInput({ panelsMounted: false });
    const { result: manualResult } = renderHook(() => useRoofOutline(manual));
    act(() => {
      void manualResult.current.runAutoOutline();
    });
    act(() => {
      void manualResult.current.runAutoOutline();
    });
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(manualResult.current.autoOutlineError).toBeNull();

    await act(async () => {
      resolvers[1](Response.json({ roofPolygon: POLY }));
    });
    expect(manual.setVertices).toHaveBeenCalledTimes(1);
    expect(manualResult.current.autoOutlineError).toBeNull();
    expect(manualResult.current.autoOutlineBusy).toBe(false);
  });

  it("skips runAutoOutline when there is no image source", async () => {
    const { result } = renderHook(() =>
      useRoofOutline(makeInput({ panelsMounted: false, addressStatic: null })),
    );
    await act(async () => {
      await result.current.runAutoOutline();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the image data URL for uploaded images", async () => {
    fetchMock.mockImplementation(async () => Response.json({ roofPolygon: POLY }));
    const mapInput: MapInputResult = {
      kind: "image",
      lat: null,
      lng: null,
      zoom: null,
      mPerPx: 0.2,
      image: { dataUrl: "data:image/png;base64,AAAA", widthPx: 640, heightPx: 480, fileName: "roof.png" },
    };
    const { result } = renderHook(() => useRoofOutline(makeInput({ mapInput, addressStatic: null })));
    await act(async () => {
      await result.current.runAutoOutline({ reason: "manual" });
    });
    const body = bodyOf(0);
    expect(body.imageDataUrl).toBe("data:image/png;base64,AAAA");
    expect(body.clicks).toEqual([{ x: 320, y: 240, type: "pos" }]);
  });

  it("pickCandidate applies the polygon and refines with the OSM footprint and ROI", async () => {
    fetchMock
      .mockImplementationOnce(async () =>
        Response.json({
          candidates: [
            { id: "a", polygon: POLY },
            { id: "b", polygon: POLY_B },
          ],
        }),
      )
      .mockImplementationOnce(async () => Response.json({ roofPolygon: POLY_B }));
    const input = makeInput();
    const { result } = renderHook(() => useRoofOutline(input));
    await act(async () => {});

    await act(async () => {
      result.current.pickCandidate("b");
    });
    expect(input.setVertices).toHaveBeenCalledWith(POLY_B);
    expect(input.setRoofAxisHintDeg).toHaveBeenLastCalledWith(null);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = bodyOf(1);
    expect(body.roi).toEqual({ x: 382, y: 382, w: 136, h: 116 });
    expect(body.clicks).toEqual([{ x: 450, y: 440, type: "pos" }]);
    expect(body.meta).toMatchObject({ osmSource: "user" });
    const footprint = (body.meta as { osmFootprint: { type: string; coordinates: number[][][] } }).osmFootprint;
    expect(footprint.type).toBe("Polygon");
    expect(footprint.coordinates[0]).toHaveLength(POLY_B.length);
  });

  it("pickCandidate ignores unknown ids", async () => {
    fetchMock.mockImplementation(async () => Response.json({ candidates: [{ id: "a", polygon: POLY }] }));
    const input = makeInput();
    const { result } = renderHook(() => useRoofOutline(input));
    await act(async () => {});
    (input.setVertices as ReturnType<typeof vi.fn>).mockClear();
    act(() => result.current.pickCandidate("zzz"));
    expect(input.setVertices).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("abortOutline aborts the request and allows the auto-outline to re-run", async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const input = makeInput();
    const { result, rerender } = renderHook((p: RoofOutlineInput) => useRoofOutline(p), { initialProps: input });
    await act(async () => {});
    act(() => result.current.abortOutline());
    expect(signal?.aborted).toBe(true);

    // A new object identity for addressStatic re-triggers the effect; the key was reset.
    rerender({ ...input, addressStatic: addressStatic() });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clearOutline resets state and sets a hint", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: "bad" }, { status: 400 }));
    const { result } = renderHook(() => useRoofOutline(makeInput()));
    await act(async () => {});
    expect(result.current.autoOutlineError).toBe("bad");
    act(() => result.current.clearOutline("hello", true));
    expect(result.current.autoOutlineError).toBeNull();
    expect(result.current.autoOutlineHint).toBe("hello");
    expect(result.current.candidatePolygons).toBeNull();
  });
});
