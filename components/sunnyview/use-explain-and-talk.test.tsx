// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXPLAIN_CAVEAT, INITIAL_ESTIMATE } from "./estimate";
import { ELEVENLABS_KEY_STORAGE, ELEVENLABS_KEY_WITHHELD_NOTICE, ELEVENLABS_VOICE_STORAGE } from "./local-keys";
import { useExplainAndTalk } from "./use-explain-and-talk";
import type { ExplainAndTalkInput } from "./use-explain-and-talk";
import type { Estimate } from "./types";

const ESTIMATE: Estimate = {
  annualKwh: 4200.4,
  monthlyKwh: Array.from({ length: 12 }, () => 350),
  annualCo2Kg: 1800,
  source: "server",
};

const fetchMock = vi.fn<typeof fetch>();
const playMock = vi.fn<() => Promise<void>>();
const audioUrls: string[] = [];

class FakeAudio {
  constructor(url: string) {
    audioUrls.push(url);
  }
  play = playMock;
}

function makeInput(overrides: Partial<ExplainAndTalkInput> = {}): ExplainAndTalkInput {
  return {
    opened: true,
    estimate: ESTIMATE,
    lat: 37.7,
    lng: -122.4,
    tiltDeg: 20,
    azimuthDeg: 180,
    lossesPct: 14,
    panelSpec: { widthM: 1.1, heightM: 1.7, wattW: 400, gapM: 0.02 },
    orientationDeg: 0,
    panelCount: 10,
    dcKw: 4,
    setActionNotice: vi.fn(),
    ...overrides,
  };
}

function bodyOf(call = 0): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[call][1]?.body));
}

beforeEach(() => {
  fetchMock.mockReset();
  playMock.mockReset();
  playMock.mockResolvedValue(undefined);
  audioUrls.length = 0;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Audio", FakeAudio);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("useExplainAndTalk key detection", () => {
  it("is null until opened, then reflects localStorage", () => {
    window.localStorage.setItem(ELEVENLABS_KEY_STORAGE, "k");
    const { result, rerender } = renderHook((p: ExplainAndTalkInput) => useExplainAndTalk(p), {
      initialProps: makeInput({ opened: false }),
    });
    expect(result.current.hasLocalElevenLabsKey).toBeNull();
    rerender(makeInput({ opened: true }));
    expect(result.current.hasLocalElevenLabsKey).toBe(true);
  });

  it("re-reads once after 260ms in case the key is saved right after opening", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useExplainAndTalk(makeInput()));
    expect(result.current.hasLocalElevenLabsKey).toBe(false);
    window.localStorage.setItem(ELEVENLABS_KEY_STORAGE, "late");
    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(result.current.hasLocalElevenLabsKey).toBe(true);
  });
});

describe("useExplainAndTalk runExplain", () => {
  it("posts the assumptions and shows up to three server bullets", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ bullets: ["a", "b", "c", "d"], caveat: "careful" }),
    );
    const input = makeInput();
    const { result } = renderHook(() => useExplainAndTalk(input));
    await act(async () => {
      await result.current.runExplain();
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/explain");
    expect(bodyOf()).toMatchObject({
      assumptions: { siteSpec: { lat: 37.7, lng: -122.4 }, panelCount: 10, dcKw: 4 },
    });
    expect(result.current.explainText).toEqual({ bullets: ["a", "b", "c"], caveat: "careful" });
    expect(result.current.explainLoading).toBe(false);
    expect(input.setActionNotice).toHaveBeenCalledWith(null);
  });

  it.each([
    ["HTTP error", () => Response.json({ error: "quota" }, { status: 429 })],
    ["invalid body", () => new Response("nope", { status: 500 })],
  ])("falls back to local summary bullets on %s", async (_name, make) => {
    fetchMock.mockImplementation(async () => make());
    const { result } = renderHook(() => useExplainAndTalk(makeInput()));
    await act(async () => {
      await result.current.runExplain();
    });
    expect(result.current.explainText?.bullets).toEqual([
      "This layout fits 10 panels (4.0 kW DC).",
      "Estimated annual energy: 4,200 kWh.",
      "Estimated annual CO₂ avoided: 1,800 kg.",
    ]);
    expect(result.current.explainText?.caveat).toBe(DEFAULT_EXPLAIN_CAVEAT);
    expect(result.current.explainLoading).toBe(false);
  });

  it("falls back on network failure", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useExplainAndTalk(makeInput({ estimate: INITIAL_ESTIMATE })));
    await act(async () => {
      await result.current.runExplain();
    });
    expect(result.current.explainText?.bullets).toHaveLength(3);
  });
});

describe("useExplainAndTalk runTalk", () => {
  it("sends the key and voice id same-origin, then plays the audio", async () => {
    window.localStorage.setItem(ELEVENLABS_KEY_STORAGE, "el-key");
    window.localStorage.setItem(ELEVENLABS_VOICE_STORAGE, "voice-1");
    fetchMock.mockImplementation(async () => Response.json({ audioUrl: "https://cdn.example/a.mp3" }));
    const input = makeInput();
    const { result } = renderHook(() => useExplainAndTalk(input));
    await act(async () => {
      await result.current.runTalk();
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/tts");
    expect(init?.headers).toEqual({ "content-type": "application/json", "x-elevenlabs-api-key": "el-key" });
    expect(bodyOf()).toMatchObject({ voiceId: "voice-1" });
    expect(String(bodyOf().text)).toContain("10 panels");
    expect(audioUrls).toEqual(["https://cdn.example/a.mp3"]);
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(result.current.ttsLoading).toBe(false);
    expect(result.current.hasLocalElevenLabsKey).toBe(true);
  });

  it("speaks the explain bullets when they exist", async () => {
    fetchMock
      .mockImplementationOnce(async () => Response.json({ bullets: ["one", "two"] }))
      .mockImplementationOnce(async () => Response.json({ audioUrl: "u" }));
    const { result } = renderHook(() => useExplainAndTalk(makeInput()));
    await act(async () => {
      await result.current.runExplain();
    });
    await act(async () => {
      await result.current.runTalk();
    });
    expect(bodyOf(1).text).toBe("one two");
    expect(bodyOf(1).voiceId).toBeUndefined();
  });

  it("withholds the key for a cross-origin backend and sets the notice", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_ORIGIN", "https://api.example.com");
    window.localStorage.setItem(ELEVENLABS_KEY_STORAGE, "el-key");
    fetchMock.mockImplementation(async () => Response.json({ audioUrl: "u" }));
    const input = makeInput();
    const { result } = renderHook(() => useExplainAndTalk(input));
    await act(async () => {
      await result.current.runTalk();
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.com/api/tts");
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain("el-key");
    expect(input.setActionNotice).toHaveBeenCalledWith(ELEVENLABS_KEY_WITHHELD_NOTICE);
  });

  it("shows the server note when no audio is returned", async () => {
    fetchMock.mockImplementation(async () => Response.json({ audioUrl: null, note: "No voice configured" }));
    const input = makeInput();
    const { result } = renderHook(() => useExplainAndTalk(input));
    await act(async () => {
      await result.current.runTalk();
    });
    expect(input.setActionNotice).toHaveBeenLastCalledWith("No voice configured");
    expect(playMock).not.toHaveBeenCalled();
    expect(result.current.ttsLoading).toBe(false);
  });

  it("uses the default unavailable message for null audio without a note", async () => {
    fetchMock.mockImplementation(async () => Response.json({}));
    const input = makeInput();
    const { result } = renderHook(() => useExplainAndTalk(input));
    await act(async () => {
      await result.current.runTalk();
    });
    expect(input.setActionNotice).toHaveBeenLastCalledWith("Text-to-speech is not available right now.");
  });

  it("surfaces server errors and playback failures as notices", async () => {
    fetchMock.mockImplementationOnce(async () => Response.json({ error: "bad voice" }, { status: 400 }));
    const input = makeInput();
    const { result } = renderHook(() => useExplainAndTalk(input));
    await act(async () => {
      await result.current.runTalk();
    });
    expect(input.setActionNotice).toHaveBeenLastCalledWith("bad voice");

    fetchMock.mockImplementationOnce(async () => Response.json({ audioUrl: "u" }));
    playMock.mockRejectedValueOnce(new Error("autoplay blocked"));
    await act(async () => {
      await result.current.runTalk();
    });
    expect(input.setActionNotice).toHaveBeenLastCalledWith("autoplay blocked");
    expect(result.current.ttsLoading).toBe(false);
  });

  it("uses a status message when the failing response has no error field", async () => {
    fetchMock.mockImplementation(async () => new Response("x", { status: 502 }));
    const input = makeInput();
    const { result } = renderHook(() => useExplainAndTalk(input));
    await act(async () => {
      await result.current.runTalk();
    });
    expect(input.setActionNotice).toHaveBeenLastCalledWith("Text-to-speech failed (502)");
  });
});

describe("useExplainAndTalk stale text", () => {
  const ok = () => Response.json({ bullets: ["A bullet"], caveat: "c" });
  const render = () =>
    renderHook((p: ExplainAndTalkInput) => useExplainAndTalk(p), { initialProps: makeInput() });

  it("hides explain text once the site changes, and on clear", async () => {
    fetchMock.mockImplementation(async () => ok());
    const { result, rerender } = render();
    await act(async () => {
      await result.current.runExplain();
    });
    expect(result.current.explainText?.bullets).toEqual(["A bullet"]);

    rerender(makeInput({ lat: 40.7, lng: -74 }));
    expect(result.current.explainText).toBeNull();

    rerender(makeInput());
    expect(result.current.explainText?.bullets).toEqual(["A bullet"]);
    rerender(makeInput({ lat: null, lng: null }));
    expect(result.current.explainText).toBeNull();
    rerender(makeInput());
    expect(result.current.explainText).toBeNull();
  });

  it("hides explain text when the layout changes", async () => {
    fetchMock.mockImplementation(async () => ok());
    const { result, rerender } = render();
    await act(async () => {
      await result.current.runExplain();
    });
    rerender(makeInput({ panelCount: 0, dcKw: 0 }));
    expect(result.current.explainText).toBeNull();
  });

  it("does not show a response that finishes after the site changed", async () => {
    let resolve: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (resolve = r)));
    const { result, rerender } = render();
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.runExplain();
    });
    rerender(makeInput({ lat: 40.7, lng: -74 }));
    await act(async () => {
      resolve(ok());
      await pending;
    });
    expect(result.current.explainText).toBeNull();
  });
});
