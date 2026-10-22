// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Point } from "@/components/PanelPacking";
import type { CandidatePolygon, EditorMode, InternalSize, ViewState } from "./types";
import { usePolygonEditing } from "./usePolygonEditing";

const SIZE: InternalSize = { w: 400, h: 400 };
const SQUARE: Point[] = [
  { x: 100, y: 100 },
  { x: 300, y: 100 },
  { x: 300, y: 300 },
  { x: 100, y: 300 },
];
const CANDIDATES: CandidatePolygon[] = [
  {
    id: "c1",
    polygon: [
      { x: 10, y: 10 },
      { x: 60, y: 10 },
      { x: 60, y: 60 },
      { x: 10, y: 60 },
    ],
  },
];

type Options = {
  mode?: EditorMode;
  vertices?: Point[];
  closed?: boolean;
  showNearby?: boolean;
  candidatePolygons?: CandidatePolygon[] | null;
  withPick?: boolean;
};

function makeRig(opts: Options = {}) {
  const canvas = document.createElement("canvas");
  const container = document.createElement("div");
  canvas.setPointerCapture = vi.fn();
  canvas.releasePointerCapture = vi.fn();
  container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;
  const viewRef: { current: ViewState } = { current: { zoom: 1, panX: 0, panY: 0 } };
  const onVerticesChange = vi.fn();
  const onClosedChange = vi.fn();
  const onPickCandidate = vi.fn();
  const setView = vi.fn();
  // Identity mapping at scale 1 keeps client coords equal to internal coords.
  const view = { setView, clientToInternal: (x: number, y: number) => ({ x, y, scale: 1 }) };
  const hook = renderHook(
    (p: Options) =>
      usePolygonEditing({
        canvasRef: { current: canvas },
        containerRef: { current: container },
        viewRef,
        view,
        internalSize: SIZE,
        mode: p.mode ?? "edit",
        vertices: p.vertices ?? SQUARE,
        closed: p.closed ?? true,
        showNearby: p.showNearby ?? false,
        candidatePolygons: p.candidatePolygons ?? null,
        onVerticesChange,
        onClosedChange,
        onPickCandidate: p.withPick ? onPickCandidate : undefined,
      }),
    { initialProps: opts },
  );
  return { ...hook, canvas, onVerticesChange, onClosedChange, onPickCandidate, setView };
}

type Rig = ReturnType<typeof makeRig>;

function ptr(x: number, y: number, pointerId = 1) {
  return { pointerId, clientX: x, clientY: y } as unknown as ReactPointerEvent<HTMLCanvasElement>;
}
function mouse(x: number, y: number) {
  return { clientX: x, clientY: y } as unknown as ReactMouseEvent<HTMLCanvasElement>;
}
function down(rig: Rig, x: number, y: number, id = 1) {
  act(() => rig.result.current.onPointerDown(ptr(x, y, id)));
}
function move(rig: Rig, x: number, y: number, id = 1) {
  act(() => rig.result.current.onPointerMove(ptr(x, y, id)));
}
function up(rig: Rig, x: number, y: number) {
  act(() => rig.result.current.onPointerUp(ptr(x, y)));
}
function click(rig: Rig, x: number, y: number) {
  down(rig, x, y);
  up(rig, x, y);
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1_000);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("usePolygonEditing vertex drag", () => {
  it("moves the grabbed vertex while dragging and stops after release", () => {
    const rig = makeRig();
    down(rig, 102, 101);
    expect(rig.canvas.setPointerCapture).toHaveBeenCalledWith(1);
    move(rig, 150, 160);
    expect(rig.onVerticesChange).toHaveBeenLastCalledWith([{ x: 150, y: 160 }, SQUARE[1], SQUARE[2], SQUARE[3]]);
    up(rig, 150, 160);
    expect(rig.canvas.releasePointerCapture).toHaveBeenCalledWith(1);
    rig.onVerticesChange.mockClear();
    move(rig, 200, 200);
    expect(rig.onVerticesChange).not.toHaveBeenCalled();
  });

  it("does not mutate the input vertices", () => {
    const rig = makeRig();
    const snapshot = JSON.stringify(SQUARE);
    down(rig, 100, 100);
    move(rig, 120, 120);
    expect(JSON.stringify(SQUARE)).toBe(snapshot);
  });

  it("reports the hovered vertex", () => {
    const rig = makeRig();
    move(rig, 299, 101);
    expect(rig.result.current.hoverIdx).toBe(1);
    move(rig, 200, 200);
    expect(rig.result.current.hoverIdx).toBeNull();
  });
});

describe("usePolygonEditing edge and polygon drag", () => {
  it("drags an edge along its normal and updates the resize cursor", () => {
    const rig = makeRig();
    expect(rig.result.current.cursor).toBe("crosshair");
    down(rig, 200, 102);
    expect(rig.result.current.cursor).toBe("ns-resize");
    move(rig, 200, 82);
    const next = rig.onVerticesChange.mock.calls.at(-1)?.[0] as Point[];
    // Top edge (v0, v1) moved up by 20; the bottom edge stays.
    expect(next[0].y).toBe(80);
    expect(next[1].y).toBe(80);
    expect(next[2]).toEqual(SQUARE[2]);
    expect(next[3]).toEqual(SQUARE[3]);
    up(rig, 200, 82);
    // Releasing ends the drag; the edge stays hover-highlighted until the pointer leaves it.
    move(rig, 200, 200);
    expect(rig.result.current.cursor).toBe("crosshair");
  });

  it("translates the whole polygon when dragging its interior", () => {
    const rig = makeRig();
    down(rig, 200, 200);
    move(rig, 210, 215);
    const next = rig.onVerticesChange.mock.calls.at(-1)?.[0] as Point[];
    expect(next.map((p) => [p.x, p.y])).toEqual([
      [110, 115],
      [310, 115],
      [310, 315],
      [110, 315],
    ]);
  });

  it("ignores moves from a different pointer than the drag owner", () => {
    const rig = makeRig();
    down(rig, 200, 200, 1);
    move(rig, 260, 260, 2);
    expect(rig.onVerticesChange).not.toHaveBeenCalled();
  });
});

describe("usePolygonEditing panning", () => {
  it("pans on empty space in edit mode and stops after release", () => {
    const rig = makeRig({ vertices: [], closed: false });
    down(rig, 50, 50);
    move(rig, 70, 90);
    expect(rig.setView).toHaveBeenCalledTimes(1);
    const next = rig.setView.mock.calls[0][0] as ViewState;
    expect(next.zoom).toBe(1);
    expect(next.panX).toBeCloseTo(20);
    expect(next.panY).toBeCloseTo(40);
    up(rig, 70, 90);
    move(rig, 90, 90);
    expect(rig.setView).toHaveBeenCalledTimes(1);
  });

  it("always pans in view mode and uses the default cursor", () => {
    const rig = makeRig({ mode: "view" });
    expect(rig.result.current.cursor).toBe("default");
    down(rig, 100, 100);
    move(rig, 110, 100);
    expect(rig.setView).toHaveBeenCalledTimes(1);
    expect(rig.onVerticesChange).not.toHaveBeenCalled();
  });
});

describe("usePolygonEditing triple-click delete", () => {
  it("removes a vertex on the third quick click", () => {
    const rig = makeRig();
    click(rig, 300, 300);
    click(rig, 300, 300);
    expect(rig.onVerticesChange).not.toHaveBeenCalled();
    click(rig, 300, 300);
    expect(rig.onVerticesChange).toHaveBeenCalledWith([SQUARE[0], SQUARE[1], SQUARE[3]]);
    expect(rig.onClosedChange).not.toHaveBeenCalled();
  });

  it("opens the ring when deleting leaves fewer than three vertices", () => {
    const rig = makeRig({ vertices: SQUARE.slice(0, 3) });
    click(rig, 100, 100);
    click(rig, 100, 100);
    click(rig, 100, 100);
    expect(rig.onVerticesChange).toHaveBeenCalledTimes(1);
    expect((rig.onVerticesChange.mock.calls[0][0] as Point[]).length).toBe(2);
    expect(rig.onClosedChange).toHaveBeenCalledWith(false);
  });

  it("restarts the streak after the 900ms window", () => {
    const now = vi.spyOn(Date, "now");
    const rig = makeRig();
    now.mockReturnValue(1_000);
    click(rig, 300, 300);
    now.mockReturnValue(1_100);
    click(rig, 300, 300);
    now.mockReturnValue(5_000);
    click(rig, 300, 300);
    expect(rig.onVerticesChange).not.toHaveBeenCalled();
  });

  it("does not count presses that dragged the vertex", () => {
    const rig = makeRig();
    for (let i = 0; i < 3; i++) {
      down(rig, 300, 300);
      move(rig, 320, 320);
      up(rig, 320, 320);
    }
    const removals = rig.onVerticesChange.mock.calls.filter(([v]) => (v as Point[]).length < 4);
    expect(removals).toHaveLength(0);
  });
});

describe("usePolygonEditing double-click", () => {
  it("closes an open ring when double-clicking the first vertex", () => {
    const rig = makeRig({ closed: false });
    act(() => rig.result.current.onDoubleClick(mouse(101, 99)));
    expect(rig.onClosedChange).toHaveBeenCalledWith(true);
  });

  it("appends a point to an open ring on empty space", () => {
    const rig = makeRig({ closed: false, vertices: SQUARE.slice(0, 2) });
    act(() => rig.result.current.onDoubleClick(mouse(200, 250)));
    expect(rig.onVerticesChange).toHaveBeenCalledWith([SQUARE[0], SQUARE[1], { x: 200, y: 250 }]);
  });

  it("inserts a vertex on the nearest edge of a closed ring", () => {
    const rig = makeRig();
    act(() => rig.result.current.onDoubleClick(mouse(200, 98)));
    const next = rig.onVerticesChange.mock.calls[0][0] as Point[];
    expect(next).toHaveLength(5);
    expect(next[1].x).toBeCloseTo(200);
  });

  it("is ignored outside edit mode", () => {
    const rig = makeRig({ mode: "view" });
    act(() => rig.result.current.onDoubleClick(mouse(200, 98)));
    expect(rig.onVerticesChange).not.toHaveBeenCalled();
    expect(rig.onClosedChange).not.toHaveBeenCalled();
  });

  it("picks a nearby candidate when nearby outlines are shown", () => {
    const rig = makeRig({
      vertices: [],
      closed: false,
      showNearby: true,
      withPick: true,
      candidatePolygons: CANDIDATES,
    });
    act(() => rig.result.current.onDoubleClick(mouse(30, 30)));
    expect(rig.onPickCandidate).toHaveBeenCalledWith("c1");
    expect(rig.onVerticesChange).not.toHaveBeenCalled();
  });
});

describe("usePolygonEditing candidate click", () => {
  const base = { vertices: [], closed: false, withPick: true, candidatePolygons: CANDIDATES };

  it("picks the candidate on a click without movement", () => {
    const rig = makeRig({ ...base, showNearby: true });
    click(rig, 30, 30);
    expect(rig.onPickCandidate).toHaveBeenCalledWith("c1");
  });

  it("does not pick when the pointer moved", () => {
    const rig = makeRig({ ...base, showNearby: true });
    down(rig, 30, 30);
    move(rig, 45, 45);
    up(rig, 45, 45);
    expect(rig.onPickCandidate).not.toHaveBeenCalled();
  });

  it("does not pick when nearby outlines are hidden", () => {
    const rig = makeRig({ ...base, showNearby: false });
    click(rig, 30, 30);
    expect(rig.onPickCandidate).not.toHaveBeenCalled();
  });
});
