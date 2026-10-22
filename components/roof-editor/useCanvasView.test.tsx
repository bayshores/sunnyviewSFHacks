// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalSize, ViewState } from "./types";
import { useCanvasView } from "./useCanvasView";
import { INITIAL_VIEW, MAX_ZOOM, MIN_ZOOM } from "./view-transform";

const SIZE: InternalSize = { w: 1000, h: 500 };

type Rig = ReturnType<typeof makeRig>;

function makeRig(opts: { mounted?: boolean } = {}) {
  const mounted = opts.mounted ?? true;
  const container = document.createElement("div");
  const canvas = document.createElement("canvas");
  container.appendChild(canvas);
  document.body.appendChild(container);
  // Container exactly matches the internal aspect ratio at scale 0.5.
  container.getBoundingClientRect = () =>
    ({ left: 10, top: 20, width: 500, height: 250, right: 510, bottom: 270, x: 10, y: 20 }) as DOMRect;
  const viewRef: { current: ViewState } = { current: { ...INITIAL_VIEW } };
  const invalidate = vi.fn();
  return {
    container,
    canvas,
    viewRef,
    invalidate,
    canvasRef: { current: mounted ? canvas : null },
    containerRef: { current: mounted ? container : null },
  };
}

function setup(rig: Rig) {
  return renderHook(() =>
    useCanvasView({
      canvasRef: rig.canvasRef,
      containerRef: rig.containerRef,
      viewRef: rig.viewRef,
      internalSize: SIZE,
      invalidate: rig.invalidate,
    }),
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(cleanup);

describe("useCanvasView zoom", () => {
  it("clamps zoom into [1, 8] and mirrors it in state", () => {
    const rig = makeRig();
    const { result } = setup(rig);
    act(() => result.current.setView({ zoom: 100, panX: 0, panY: 0 }));
    expect(result.current.zoom).toBe(MAX_ZOOM);
    expect(rig.viewRef.current.zoom).toBe(MAX_ZOOM);
    act(() => result.current.setView({ zoom: 0.2, panX: 0, panY: 0 }));
    expect(result.current.zoom).toBe(MIN_ZOOM);
    expect(rig.invalidate).toHaveBeenCalledTimes(2);
  });

  it("resets to the initial view", () => {
    const rig = makeRig();
    const { result } = setup(rig);
    act(() => result.current.setView({ zoom: 4, panX: 10, panY: 10 }));
    act(() => result.current.setView(INITIAL_VIEW));
    expect(result.current.zoom).toBe(1);
    expect(rig.viewRef.current).toEqual(INITIAL_VIEW);
  });

  it("clamps pan to the image bounds when zoomed", () => {
    const rig = makeRig();
    const { result } = setup(rig);
    act(() => result.current.setView({ zoom: 2, panX: 9999, panY: -9999 }));
    // At 2x only half of the image is visible, so pan is limited to a quarter on each side.
    expect(rig.viewRef.current.panX).toBeCloseTo(SIZE.w / 4);
    expect(rig.viewRef.current.panY).toBeCloseTo(-SIZE.h / 4);
  });

  it("forces pan to zero at zoom 1", () => {
    const rig = makeRig();
    const { result } = setup(rig);
    act(() => result.current.setView({ zoom: 1, panX: 300, panY: 300 }));
    expect(rig.viewRef.current).toEqual(INITIAL_VIEW);
  });

  it("skips bounds clamping when the container is not mounted", () => {
    const rig = makeRig({ mounted: false });
    const { result } = setup(rig);
    act(() => result.current.setView({ zoom: 3, panX: 777, panY: 5 }));
    expect(rig.viewRef.current).toEqual({ zoom: 3, panX: 777, panY: 5 });
  });

  it("zoomBy changes zoom and ignores no-op zooms at the limits", () => {
    const rig = makeRig();
    const { result } = setup(rig);
    act(() => result.current.zoomBy(2, { x: 500, y: 250 }));
    expect(result.current.zoom).toBe(2);
    act(() => result.current.zoomBy(1000, null));
    expect(result.current.zoom).toBe(MAX_ZOOM);
    rig.invalidate.mockClear();
    act(() => result.current.zoomBy(2, null));
    expect(rig.invalidate).not.toHaveBeenCalled();
    act(() => result.current.zoomBy(0.0001, null));
    act(() => result.current.zoomBy(0.5, null));
    expect(result.current.zoom).toBe(MIN_ZOOM);
  });
});

describe("useCanvasView coordinates", () => {
  it("maps client coordinates into internal space", () => {
    const rig = makeRig();
    const { result } = setup(rig);
    // Container origin is (10, 20); fit scale is 0.5.
    const hit = result.current.clientToInternal(10 + 250, 20 + 125);
    expect(hit).toEqual({ x: 500, y: 250, scale: 0.5 });
  });

  it("clamps points outside the container", () => {
    const rig = makeRig();
    const { result } = setup(rig);
    expect(result.current.clientToInternal(-500, 9999)).toMatchObject({ x: 0, y: SIZE.h });
  });

  it("returns null without a container", () => {
    const { result } = setup(makeRig({ mounted: false }));
    expect(result.current.clientToInternal(0, 0)).toBeNull();
  });
});

describe("useCanvasView wheel", () => {
  it("zooms about the cursor and prevents page scroll", () => {
    const rig = makeRig();
    const { result } = setup(rig);
    const evt = new WheelEvent("wheel", { deltaY: -500, clientX: 260, clientY: 145, cancelable: true, bubbles: true });
    act(() => {
      rig.canvas.dispatchEvent(evt);
    });
    expect(evt.defaultPrevented).toBe(true);
    expect(result.current.zoom).toBeGreaterThan(1);
  });

  it("zooms out on positive deltaY but never below 1", () => {
    const rig = makeRig();
    const { result } = setup(rig);
    act(() => {
      rig.container.dispatchEvent(new WheelEvent("wheel", { deltaY: 400, clientX: 100, clientY: 100, cancelable: true }));
    });
    expect(result.current.zoom).toBe(1);
  });

  it("removes its listeners on unmount", () => {
    const rig = makeRig();
    const { result, unmount } = setup(rig);
    unmount();
    const evt = new WheelEvent("wheel", { deltaY: -500, clientX: 260, clientY: 145, cancelable: true });
    rig.canvas.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(result.current.zoom).toBe(1);
  });
});
