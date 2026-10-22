// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapInputResult } from "@/components/MapInput";
import type { HistorySnapshot } from "@/lib/history-types";
import { useSiteInput } from "./use-site-input";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const FOUND: MapInputResult = { kind: "address", address: "1 Main St", lat: 10, lng: 20, zoom: 18, mPerPx: 0.3 };

function render(opts = { panelsMounted: true, globeInteractive: true }) {
  return renderHook((o: typeof opts) => useSiteInput(o), { initialProps: opts });
}

describe("useSiteInput render-phase sync", () => {
  it("mirrors an address result into lat/lng/zoom when panels are mounted", () => {
    const { result } = render();
    act(() => result.current.setMapInput(FOUND));
    expect(result.current).toMatchObject({ lat: 10, lng: 20, zoom: 18, mPerPx: 0.3 });
    expect(result.current.addressStatic?.address).toBe("1 Main St");
    expect(result.current.addressStatic?.src).toContain("/api/static-map");
    expect(result.current.background).toMatchObject({ kind: "image" });
  });

  it("waits for the panelsMounted gate, then syncs", () => {
    const { result, rerender } = render({ panelsMounted: false, globeInteractive: false });
    act(() => result.current.setMapInput(FOUND));
    expect(result.current.lat).toBeNull();
    rerender({ panelsMounted: true, globeInteractive: false });
    expect(result.current).toMatchObject({ lat: 10, lng: 20, zoom: 18 });
  });

  it("clears lat/lng for an address result without coordinates and keeps its zoom", () => {
    const { result } = render();
    act(() => result.current.setMapInput(FOUND));
    act(() => result.current.setMapInput({ ...FOUND, lat: null, lng: null, zoom: 15 }));
    expect(result.current).toMatchObject({ lat: null, lng: null, zoom: 15 });
    expect(result.current.addressStatic).toBeNull();
    expect(result.current.background).toEqual({ kind: "none" });
  });

  it("does not sync image inputs and exposes the image background", () => {
    const { result } = render();
    act(() => result.current.setMapInput(FOUND));
    act(() =>
      result.current.setMapInput({
        kind: "image",
        lat: null,
        lng: null,
        zoom: null,
        mPerPx: 0.5,
        image: { dataUrl: "data:x", widthPx: 10, heightPx: 20, fileName: "a.png" },
      }),
    );
    expect(result.current.lat).toBe(10);
    expect(result.current.addressStatic).toBeNull();
    expect(result.current.background).toEqual({ kind: "image", src: "data:x", widthPx: 10, heightPx: 20 });
    expect(result.current.pickEnabled).toBe(false);
  });
});

describe("useSiteInput globe pick", () => {
  it("is ignored while picking is disabled", () => {
    const { result } = render({ panelsMounted: true, globeInteractive: false });
    act(() => result.current.handlePickLocation({ lat: 1, lng: 2 }));
    expect(result.current.lat).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets lat/lng, clears the address and fills it from reverse geocode", async () => {
    fetchMock.mockImplementation(async () => Response.json({ displayName: "  Pier 39  " }));
    const { result } = render();
    act(() => result.current.setMapInput(FOUND));
    await act(async () => {
      result.current.handlePickLocation({ lat: 37.8, lng: -122.4 });
    });
    expect(result.current.lat).toBe(37.8);
    expect(result.current.lng).toBe(-122.4);
    expect(result.current.mapInput).toMatchObject({ lat: 37.8, lng: -122.4, address: "Pier 39", mPerPx: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/reverse-geocode?lat=37.8&lng=-122.4");
    expect(init?.headers).toEqual({ accept: "application/json" });
  });

  it("aborts the previous reverse geocode when picking again", async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>(() => {});
    });
    const { result } = render();
    await act(async () => {
      result.current.handlePickLocation({ lat: 1, lng: 2 });
    });
    await act(async () => {
      result.current.handlePickLocation({ lat: 3, lng: 4 });
    });
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it("does not overwrite an address typed meanwhile or for a different point", async () => {
    let resolveFirst!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (resolveFirst = r)));
    const { result } = render();
    await act(async () => {
      result.current.handlePickLocation({ lat: 1, lng: 2 });
    });
    act(() => result.current.setMapInput((prev) => ({ ...prev, address: "typed" })));
    await act(async () => {
      resolveFirst(Response.json({ displayName: "Geocoded" }));
    });
    expect(result.current.mapInput.address).toBe("typed");
  });

  it.each([
    ["non-OK status", () => new Response("x", { status: 500 })],
    ["blank name", () => Response.json({ displayName: "   " })],
    ["invalid JSON", () => new Response("nope")],
  ])("leaves the address empty on %s", async (_name, make) => {
    fetchMock.mockImplementation(async () => make());
    const { result } = render();
    await act(async () => {
      result.current.handlePickLocation({ lat: 1, lng: 2 });
    });
    expect(result.current.mapInput.address).toBe("");
  });

  it("swallows network errors", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const { result } = render();
    await act(async () => {
      result.current.handlePickLocation({ lat: 1, lng: 2 });
    });
    expect(result.current.lat).toBe(1);
  });
});

describe("useSiteInput snapshot and clearing", () => {
  const SNAPSHOT = {
    address: "Saved St",
    lat: 5,
    lng: 6,
    zoom: 17.6,
    mPerPx: null,
    siteSpec: { tiltDeg: 33, azimuthDeg: 90, lossesPct: 10 },
    geometry: { mPerPx: 0.25 },
  } as unknown as HistorySnapshot;

  it("applySnapshotSite restores the site fields and aborts a pending geocode", async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>(() => {});
    });
    const { result } = render();
    await act(async () => {
      result.current.handlePickLocation({ lat: 1, lng: 2 });
    });
    act(() => result.current.applySnapshotSite(SNAPSHOT));
    expect(signal?.aborted).toBe(true);
    expect(result.current).toMatchObject({ lat: 5, lng: 6, zoom: 18, tiltDeg: 33, azimuthDeg: 90, lossesPct: 10 });
    expect(result.current.mapInput).toMatchObject({ address: "Saved St", mPerPx: 0.25 });
  });

  it("applySnapshotSite defaults a non-finite zoom to 19", () => {
    const { result } = render();
    act(() => result.current.applySnapshotSite({ ...SNAPSHOT, zoom: Number.NaN } as HistorySnapshot));
    expect(result.current.zoom).toBe(19);
  });

  it("clearSiteInput resets to an empty address search", () => {
    const { result } = render();
    act(() => result.current.setMapInput(FOUND));
    act(() => result.current.clearSiteInput());
    expect(result.current.mapInput).toMatchObject({ kind: "address", address: "", lat: null, lng: null, zoom: 19 });
    expect(result.current).toMatchObject({ lat: null, lng: null, zoom: 19 });
  });
});
