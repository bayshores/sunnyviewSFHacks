// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLY_TO_DURATION_S, FLY_TO_HEIGHT_M } from "./camera";
import type { CesiumViewer, RafRef, ViewerRef } from "./types";
import { useCameraActions } from "./useCameraActions";
import type { UseCameraActionsOptions } from "./useCameraActions";

vi.mock("cesium", () => ({
  Cartesian3: { fromDegrees: (lng: number, lat: number, h: number) => ({ lng, lat, h }) },
}));

let rafQueue: Map<number, FrameRequestCallback>;
let rafId: number;

function fakeViewer() {
  return {
    camera: { flyHome: vi.fn(), flyTo: vi.fn(), rotateRight: vi.fn() },
    scene: { requestRender: vi.fn() },
  };
}

function options(viewer: ReturnType<typeof fakeViewer> | null, over: Partial<UseCameraActionsOptions> = {}) {
  return {
    ready: true,
    interactive: true,
    hasLocation: true,
    lat: 37.5,
    lng: -122.1,
    viewerRef: { current: viewer as unknown as CesiumViewer | null } as ViewerRef,
    clickSpinRafRef: { current: null } as RafRef,
    cancelLandingSpin: vi.fn(),
    ...over,
  } satisfies UseCameraActionsOptions;
}

function reducedMotion(matches: boolean) {
  window.matchMedia = vi.fn(() => ({ matches })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  rafQueue = new Map();
  rafId = 1;
  window.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
    rafQueue.set(rafId, cb);
    return rafId++;
  });
  window.cancelAnimationFrame = vi.fn((id: number) => {
    rafQueue.delete(id);
  });
  reducedMotion(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useCameraActions flyTo", () => {
  it("flies to the site automatically when ready, interactive and located", async () => {
    const viewer = fakeViewer();
    renderHook(() => useCameraActions(options(viewer)));
    await act(async () => {});
    expect(viewer.camera.flyTo).toHaveBeenCalledWith({
      destination: { lng: -122.1, lat: 37.5, h: FLY_TO_HEIGHT_M },
      duration: FLY_TO_DURATION_S,
    });
  });

  it.each([
    ["not ready", { ready: false }],
    ["not interactive", { interactive: false }],
    ["no location", { hasLocation: false }],
  ])("does not auto-fly when %s", async (_name, over) => {
    const viewer = fakeViewer();
    renderHook(() => useCameraActions(options(viewer, over)));
    await act(async () => {});
    expect(viewer.camera.flyTo).not.toHaveBeenCalled();
  });

  it("flyTo is a no-op without coordinates or a viewer", async () => {
    const viewer = fakeViewer();
    const noCoords = renderHook(() => useCameraActions(options(viewer, { lat: null, ready: false })));
    await act(async () => {
      await noCoords.result.current.flyTo();
    });
    const noViewer = renderHook(() => useCameraActions(options(null, { ready: false })));
    await act(async () => {
      await noViewer.result.current.flyTo();
    });
    expect(viewer.camera.flyTo).not.toHaveBeenCalled();
  });
});

describe("useCameraActions centerAndSpin", () => {
  it("flies home, cancels the landing spin and starts the click spin", async () => {
    const viewer = fakeViewer();
    const opts = options(viewer, { ready: false });
    const { result } = renderHook(() => useCameraActions(opts));
    await act(async () => {
      await result.current.centerAndSpin();
    });
    expect(viewer.camera.flyHome).toHaveBeenCalledWith(0.85);
    expect(opts.cancelLandingSpin).toHaveBeenCalledTimes(1);
    expect(rafQueue.size).toBe(1);
    expect(opts.clickSpinRafRef.current).not.toBeNull();
  });

  it("rotates only after the spin delay, then finishes and clears the frame id", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const viewer = fakeViewer();
    const opts = options(viewer, { ready: false });
    const { result } = renderHook(() => useCameraActions(opts));
    await act(async () => {
      await result.current.centerAndSpin();
    });
    const frame = (now: number) => {
      const cbs = [...rafQueue.values()];
      rafQueue.clear();
      cbs.forEach((cb) => cb(now));
    };
    frame(10);
    expect(viewer.camera.rotateRight).not.toHaveBeenCalled();
    frame(400);
    expect(viewer.camera.rotateRight).toHaveBeenCalled();
    frame(100_000);
    expect(opts.clickSpinRafRef.current).toBeNull();
    expect(rafQueue.size).toBe(0);
    vi.restoreAllMocks();
  });

  it("skips the spin with reduced motion", async () => {
    reducedMotion(true);
    const viewer = fakeViewer();
    const opts = options(viewer, { ready: false });
    const { result } = renderHook(() => useCameraActions(opts));
    await act(async () => {
      await result.current.centerAndSpin();
    });
    expect(viewer.camera.flyHome).toHaveBeenCalled();
    expect(rafQueue.size).toBe(0);
  });

  it("tolerates a flyHome failure and a missing viewer", async () => {
    const viewer = fakeViewer();
    viewer.camera.flyHome.mockImplementation(() => {
      throw new Error("x");
    });
    const opts = options(viewer, { ready: false });
    const { result } = renderHook(() => useCameraActions(opts));
    await act(async () => {
      await result.current.centerAndSpin();
    });
    expect(opts.cancelLandingSpin).toHaveBeenCalled();

    const none = renderHook(() => useCameraActions(options(null, { ready: false })));
    await act(async () => {
      await none.result.current.centerAndSpin();
    });
  });
});
