// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CesiumModule, CesiumRef, CesiumViewer, ViewerRef } from "./types";
import { useGlobeInteraction } from "./useGlobeInteraction";
import type { UseGlobeInteractionOptions } from "./useGlobeInteraction";

type ClickHandler = (movement: { position?: { x: number; y: number } }) => void;
const handlers: Array<{ canvas: unknown; action: ClickHandler | null; type: unknown }> = [];

vi.mock("cesium", () => {
  class ScreenSpaceEventHandler {
    entry: { canvas: unknown; action: ClickHandler | null; type: unknown };
    constructor(canvas: unknown) {
      this.entry = { canvas, action: null, type: null };
      handlers.push(this.entry);
    }
    setInputAction(action: ClickHandler, type: unknown) {
      this.entry.action = action;
      this.entry.type = type;
    }
  }
  return {
    ScreenSpaceEventHandler,
    ScreenSpaceEventType: { LEFT_CLICK: "LEFT_CLICK" },
    Cartographic: { fromCartesian: (c: { lat: number; lng: number }) => ({ latitude: c.lat, longitude: c.lng }) },
    Math: { toDegrees: (v: number) => v },
  };
});

function fakeViewer(pick: unknown) {
  return {
    scene: {
      canvas: { id: "canvas" },
      globe: { ellipsoid: {} },
      screenSpaceCameraController: {
        enableInputs: true,
        enableRotate: true,
        enableTranslate: true,
        enableZoom: true,
        enableTilt: true,
        enableLook: true,
      },
    },
    camera: { pickEllipsoid: vi.fn(() => pick) },
  };
}

function options(viewer: ReturnType<typeof fakeViewer> | null, over: Partial<UseGlobeInteractionOptions> = {}) {
  return {
    ready: true,
    interactive: true,
    onPickLocation: vi.fn(),
    viewerRef: { current: viewer as unknown as CesiumViewer | null } as ViewerRef,
    cesiumRef: { current: null } as CesiumRef,
    pickHandlerRef: { current: null },
    destroyPickHandler: vi.fn(),
    ...over,
  } satisfies UseGlobeInteractionOptions;
}

beforeEach(() => {
  handlers.length = 0;
});
afterEach(cleanup);

describe("useGlobeInteraction", () => {
  it("toggles camera inputs with the interactive flag", () => {
    const viewer = fakeViewer(null);
    const { rerender } = renderHook((p: UseGlobeInteractionOptions) => useGlobeInteraction(p), {
      initialProps: options(viewer, { interactive: false, onPickLocation: undefined }),
    });
    const c = viewer.scene.screenSpaceCameraController;
    expect(Object.values(c).every((v) => v === false)).toBe(true);
    rerender(options(viewer, { interactive: true, onPickLocation: undefined }));
    expect(Object.values(c).every((v) => v === true)).toBe(true);
  });

  it("does nothing until ready or without a viewer", () => {
    const viewer = fakeViewer(null);
    const opts = options(viewer, { ready: false });
    renderHook(() => useGlobeInteraction(opts));
    expect(viewer.scene.screenSpaceCameraController.enableInputs).toBe(true);
    renderHook(() => useGlobeInteraction(options(null)));
    expect(handlers).toHaveLength(0);
  });

  it("destroys the pick handler when not interactive or when no callback is given", () => {
    const viewer = fakeViewer(null);
    const a = options(viewer, { interactive: false });
    renderHook(() => useGlobeInteraction(a));
    expect(a.destroyPickHandler).toHaveBeenCalled();
    const b = options(viewer, { onPickLocation: undefined });
    renderHook(() => useGlobeInteraction(b));
    expect(b.destroyPickHandler).toHaveBeenCalled();
    expect(handlers).toHaveLength(0);
  });

  it("registers a left-click handler and reports picked lat/lng", async () => {
    const viewer = fakeViewer({ lat: 12.5, lng: 99.25 });
    const opts = options(viewer);
    renderHook(() => useGlobeInteraction(opts));
    await act(async () => {});
    expect(handlers).toHaveLength(1);
    expect(handlers[0].type).toBe("LEFT_CLICK");
    expect(handlers[0].canvas).toBe(viewer.scene.canvas);
    expect(opts.cesiumRef.current).not.toBeNull();
    handlers[0].action?.({ position: { x: 1, y: 2 } });
    expect(opts.onPickLocation).toHaveBeenCalledWith({ lat: 12.5, lng: 99.25 });
  });

  it("ignores clicks that miss the globe, lack a position, or give non-finite coordinates", async () => {
    const miss = fakeViewer(null);
    const opts = options(miss);
    renderHook(() => useGlobeInteraction(opts));
    await act(async () => {});
    handlers[0].action?.({ position: { x: 1, y: 2 } });
    handlers[0].action?.({});
    expect(opts.onPickLocation).not.toHaveBeenCalled();

    miss.camera.pickEllipsoid.mockReturnValue({ lat: Number.NaN, lng: 1 } as never);
    handlers[0].action?.({ position: { x: 1, y: 2 } });
    expect(opts.onPickLocation).not.toHaveBeenCalled();
  });

  it("ignores clicks after the viewer is gone", async () => {
    const viewer = fakeViewer({ lat: 1, lng: 2 });
    const opts = options(viewer);
    renderHook(() => useGlobeInteraction(opts));
    await act(async () => {});
    opts.viewerRef.current = null;
    handlers[0].action?.({ position: { x: 0, y: 0 } });
    expect(opts.onPickLocation).not.toHaveBeenCalled();
  });

  it("reuses a preloaded Cesium module and destroys the handler on unmount", async () => {
    const viewer = fakeViewer({ lat: 1, lng: 2 });
    const cesium = await import("cesium");
    const opts = options(viewer, { cesiumRef: { current: cesium as unknown as CesiumModule } });
    const { unmount } = renderHook(() => useGlobeInteraction(opts));
    await act(async () => {});
    expect(handlers).toHaveLength(1);
    const before = vi.mocked(opts.destroyPickHandler).mock.calls.length;
    unmount();
    expect(vi.mocked(opts.destroyPickHandler).mock.calls.length).toBeGreaterThan(before);
  });
});
