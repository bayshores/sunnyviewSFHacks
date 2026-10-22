import { describe, expect, it } from "vitest";
import type { MapInputResult } from "@/components/MapInput";
import { ProjectsApiError } from "@/lib/projects-api";
import { buildStaticMapSpec } from "@/lib/static-map";
import { explainTextFromResponse, fallbackEstimateFor, parseEstimateResponse, summaryBullets } from "./estimate";
import { isSameOriginBackend, keyForwarding } from "./local-keys";
import { panelRecommendErrorMessage, parsePanelRecommendation } from "./panel-recommend";
import { buildSegmentRequest, parseSegmentResponse, segmentHint } from "./segment";
import { PROJECT_STORAGE_UNAVAILABLE_MESSAGE, projectCreateErrorMessage } from "./use-project-sync";

describe("same-origin key forwarding", () => {
  it("treats an empty backend origin or the page origin as same-origin", () => {
    expect(isSameOriginBackend("", "https://app.example")).toBe(true);
    expect(isSameOriginBackend("https://app.example", "https://app.example")).toBe(true);
    expect(isSameOriginBackend("https://api.example", "https://app.example")).toBe(false);
    expect(isSameOriginBackend("https://api.example", "")).toBe(false);
  });

  it("only sends a key same-origin", () => {
    expect(keyForwarding("", true)).toBe("none");
    expect(keyForwarding("", false)).toBe("none");
    expect(keyForwarding("secret", true)).toBe("send");
    expect(keyForwarding("secret", false)).toBe("withhold");
  });
});

describe("estimate helpers", () => {
  it("fallbackEstimateFor uses the shared solar defaults", () => {
    const est = fallbackEstimateFor(2);
    expect(est).toMatchObject({ annualKwh: 2800, annualCo2Kg: 1120, source: "fallback" });
    expect(est.monthlyKwh).toHaveLength(12);
    expect(fallbackEstimateFor(-3).annualKwh).toBe(0);
  });

  it("parses top-level and nested estimate bodies", () => {
    const monthly = Array.from({ length: 12 }, (_, i) => i);
    expect(parseEstimateResponse({ annualKwh: 1200, annualCo2Kg: "480", monthlyKwh: monthly })).toEqual({
      annualKwh: 1200,
      annualCo2Kg: 480,
      monthlyKwh: monthly,
      source: "server",
      assumptions: undefined,
    });
    const nested = parseEstimateResponse({ estimate: { annualKwh: 1200, annualCo2Kg: 480, assumptions: { a: 1 } } });
    expect(nested?.monthlyKwh).toEqual(new Array(12).fill(100));
    expect(nested?.assumptions).toEqual({ a: 1 });
  });

  it("returns null without annual totals", () => {
    expect(parseEstimateResponse(null)).toBeNull();
    expect(parseEstimateResponse({ annualKwh: 5 })).toBeNull();
  });

  it("falls back to local bullets when explain returns none", () => {
    const estimate = fallbackEstimateFor(1);
    const text = explainTextFromResponse({ caveats: ["c1"] }, { panelCount: 3, dcKw: 1, estimate });
    expect(text.caveat).toBe("c1");
    expect(text.bullets).toEqual(summaryBullets(3, 1, estimate));
    const fromServer = explainTextFromResponse({ bullets: ["a", "b", "c", "d"], caveat: "x" }, { panelCount: 3, dcKw: 1, estimate });
    expect(fromServer).toEqual({ bullets: ["a", "b", "c"], caveat: "x" });
  });
});

describe("panel recommendation parsing", () => {
  it("parses a valid recommendation and trims lists", () => {
    const rec = parsePanelRecommendation({
      selectedId: "p1",
      brand: "B",
      model: "M",
      sourceUrl: "https://x",
      why: ["1", "2", "3", "4", "5"],
      caveats: ["a", "b", "c", "d"],
      usedModel: "gemini-x",
      attemptedModels: ["gemini-x", ""],
    });
    expect(rec.why).toHaveLength(4);
    expect(rec.caveats).toHaveLength(3);
    expect(rec.source).toEqual({ kind: "gemini", usedModel: "gemini-x", fallbackReason: null, attemptedModels: ["gemini-x"] });
  });

  it("throws on incomplete responses", () => {
    expect(() => parsePanelRecommendation({ selectedId: "p1" })).toThrow("Invalid Gemini response");
  });

  it("normalizes missing-key errors and lists attempted models", () => {
    expect(panelRecommendErrorMessage({ error: "Missing GEMINI_API_KEY" }, 500)).toBe(
      "Missing Gemini API key. Add it on the landing page.",
    );
    expect(panelRecommendErrorMessage({ error: "boom", attemptedModels: ["a", "b"] }, 502)).toBe(
      "boom (models tried: a, b)",
    );
    expect(panelRecommendErrorMessage(null, 503)).toBe("Panel recommendation failed (503)");
  });
});

describe("segment helpers", () => {
  const addressStatic = { ...buildStaticMapSpec({ lat: 37, lng: -122, zoom: 19 }), address: "1 Main St" };
  const addressInput: MapInputResult = { kind: "address", address: "1 Main St", lat: 37, lng: -122, zoom: 19, mPerPx: 0.1 };

  it("builds an address request with ROI click and meta override", () => {
    const req = buildSegmentRequest(addressInput, addressStatic, { x: 10, y: 20, w: 40, h: 60 }, { osmSource: "user" });
    expect(req?.w).toBe(addressStatic.widthPx);
    expect(req?.body).toMatchObject({
      imageUrl: addressStatic.src,
      mode: "roof",
      clicks: [{ x: 30, y: 50, type: "pos" }],
      roi: { x: 10, y: 20, w: 40, h: 60 },
      meta: { address: "1 Main St", osmSource: "user" },
    });
    expect(buildSegmentRequest(addressInput, addressStatic, null, null)?.body).not.toHaveProperty("clicks");
  });

  it("builds an image request with a centre click", () => {
    const imageInput: MapInputResult = {
      kind: "image",
      lat: null,
      lng: null,
      zoom: null,
      mPerPx: null,
      image: { dataUrl: "data:image/png;base64,AA", widthPx: 100, heightPx: 50, fileName: "r.png" },
    };
    const req = buildSegmentRequest(imageInput, null, null, null);
    expect(req?.body).toMatchObject({ imageDataUrl: "data:image/png;base64,AA", clicks: [{ x: 50, y: 25, type: "pos" }] });
    expect(buildSegmentRequest({ ...imageInput, image: undefined }, null, null, null)).toBeNull();
  });

  it("parses candidates, primary polygon, and nested result hints", () => {
    const ring = [
      [10, 10],
      [50, 10],
      [50, 40],
    ];
    const parsed = parseSegmentResponse(
      {
        candidates: [{ id: "a", polygon: ring, score: 0.9 }, { polygon: "bad" }, ring],
        result: { source: "osm_building", confidence: "0.5", suggestedOrientationDeg: 12 },
      },
      100,
      100,
    );
    expect(parsed.candidates.map((c) => c.id)).toEqual(["a", "2"]);
    expect(parsed.primary).toEqual(parsed.candidates[0].polygon);
    expect(parsed.source).toBe("osm_building");
    expect(parsed.confidence).toBe(0.5);
    expect(parsed.suggestedOrientationDeg).toBe(12);
    expect(parsed.suggestedAzimuthDeg).toBeNull();
  });

  it("picks hints in priority order", () => {
    const base = { reason: "manual" as const, candidateCount: 1, note: null, source: null, confidence: null };
    expect(segmentHint({ ...base, reason: "auto", candidateCount: 2, note: "n" })).toBe(
      "Multiple roofs nearby. Click Edit to pick.",
    );
    expect(segmentHint({ ...base, note: "short note", source: "fallback_rect" })).toBe("short note");
    expect(segmentHint({ ...base, note: "x".repeat(60), source: "fallback_rect" })).toBe("Edit -> Auto-outline.");
    expect(segmentHint({ ...base, confidence: 0.1 })).toBe("Edit -> Auto-outline.");
    expect(segmentHint({ ...base, source: "osm_building" })).toBe("OSM outline. Edit -> Auto-outline.");
    expect(segmentHint({ ...base, source: "sam", confidence: 0.9 })).toBeNull();
  });
});

describe("projectCreateErrorMessage", () => {
  it("maps 503 to the storage-unavailable message and passes other API messages through", () => {
    expect(projectCreateErrorMessage(new ProjectsApiError("x", 503))).toBe(PROJECT_STORAGE_UNAVAILABLE_MESSAGE);
    expect(projectCreateErrorMessage(new ProjectsApiError("Too many requests.", 429))).toBe("Too many requests.");
    expect(projectCreateErrorMessage(new Error("boom"))).toBe(
      "Could not connect to project backend. Sharing is currently unavailable.",
    );
  });
});
