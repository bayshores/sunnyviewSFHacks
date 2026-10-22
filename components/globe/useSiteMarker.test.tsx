// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CesiumViewer, ViewerRef } from "./types";
import { useSiteMarker } from "./useSiteMarker";
import type { UseSiteMarkerOptions } from "./useSiteMarker";

vi.mock("cesium", () => {
  class Cartesian2 {
    constructor(
      public x: number,
      public y: number,
    ) {}
  }
  return {
    Cartesian2,
    Cartesian3: { fromDegrees: (lng: number, lat: number, h: number) => ({ lng, lat, h }) },
    Color: { fromCssColorString: (s: string) => `color:${s}`, WHITE: "white", BLACK: "black" },
    HeightReference: { CLAMP_TO_GROUND: "clamp" },
    LabelStyle: { FILL_AND_OUTLINE: "fill" },
    VerticalOrigin: { BOTTOM: "bottom" },
  };
});

afterEach(cleanup);

function fakeViewer() {
  const entity = { position: null as unknown };
  return {
    entity,
    entities: { add: vi.fn((_spec: unknown) => entity) },
    scene: { requestRender: vi.fn() },
  };
}

function options(viewer: ReturnType<typeof fakeViewer> | null, over: Partial<UseSiteMarkerOptions> = {}) {
  const v = viewer ? { entities: viewer.entities, scene: viewer.scene } : null;
  return {
    ready: true,
    hasLocation: true,
    lat: 10,
    lng: 20,
    viewerRef: { current: v as unknown as CesiumViewer | null } as ViewerRef,
    markerEntityRef: { current: null },
    ...over,
  } satisfies UseSiteMarkerOptions;
}

describe("useSiteMarker", () => {
  it("adds a Site marker at the location and requests a render", async () => {
    const viewer = fakeViewer();
    const opts = options(viewer);
    renderHook(() => useSiteMarker(opts));
    await act(async () => {});
    expect(viewer.entities.add).toHaveBeenCalledTimes(1);
    const added = viewer.entities.add.mock.calls[0][0] as {
      position: unknown;
      label: { text: string };
    };
    expect(added.position).toEqual({ lng: 20, lat: 10, h: 0 });
    expect(added.label.text).toBe("Site");
    expect(opts.markerEntityRef.current).toBe(viewer.entity);
    expect(viewer.scene.requestRender).toHaveBeenCalled();
  });

  it("moves the existing marker instead of adding another", async () => {
    const viewer = fakeViewer();
    const opts = options(viewer);
    const { rerender } = renderHook((p: UseSiteMarkerOptions) => useSiteMarker(p), { initialProps: opts });
    await act(async () => {});
    rerender({ ...opts, lat: 30, lng: 40 });
    await act(async () => {});
    expect(viewer.entities.add).toHaveBeenCalledTimes(1);
    expect(viewer.entity.position).toEqual({ lng: 40, lat: 30, h: 0 });
  });

  it.each([
    ["not ready", { ready: false }],
    ["no location", { hasLocation: false }],
    ["null lat", { lat: null }],
    ["null lng", { lng: null }],
  ])("does nothing when %s", async (_name, over) => {
    const viewer = fakeViewer();
    renderHook(() => useSiteMarker(options(viewer, over)));
    await act(async () => {});
    expect(viewer.entities.add).not.toHaveBeenCalled();
  });

  it("does nothing without a viewer", async () => {
    const opts = options(null);
    renderHook(() => useSiteMarker(opts));
    await act(async () => {});
    expect(opts.markerEntityRef.current).toBeNull();
  });
});
