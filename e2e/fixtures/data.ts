export const ADDRESS = "1600 Amphitheatre Parkway, Mountain View, CA";
export const LAT = 37.7749;
export const LNG = -122.4194;
export const SHARE_SLUG = "abc123def456";
export const PROJECT_ID = "proj_test_1";

export const SUGGESTION = {
  id: "esri_suggest:mk1",
  displayName: "1600 Amphitheatre Pkwy, Mountain View, CA, 94043",
  magicKey: "mk1",
};

export const RESOLVED = {
  id: "esri:resolved-1",
  displayName: SUGGESTION.displayName,
  lat: LAT,
  lng: LNG,
};

export const SEGMENT_RESPONSE = {
  roofPolygon: [
    [0.35, 0.35],
    [0.65, 0.35],
    [0.65, 0.65],
    [0.35, 0.65],
  ],
  source: "osm_building",
  confidence: 0.8,
};

export const ESTIMATE_RESPONSE = {
  annualKwh: 12345,
  monthlyKwh: [700, 800, 1000, 1100, 1200, 1300, 1400, 1300, 1100, 900, 700, 645],
  annualCo2Kg: 4567,
  assumptions: { source: "e2e-mock" },
};

function isoDay(offset: number): string {
  const d = new Date(Date.UTC(2026, 5, 1 + offset));
  return d.toISOString().slice(0, 10);
}

export const FORECAST_RESPONSE = {
  days: Array.from({ length: 7 }, (_, i) => ({
    date: isoDay(i),
    estKwh: 30 + i,
    irradianceKwhM2: 5,
    cloudCoverPct: 20,
  })),
  meta: { source: "e2e-mock" },
  worthIt: { verdict: "good", paybackYears: 7.2, reasons: ["Mocked: strong sun hours."] },
};

export const PANEL_RECOMMEND_RESPONSE = {
  selectedId: "qcells_qtron_425",
  brand: "Q CELLS",
  model: "Q.TRON",
  sourceUrl: "https://example.com/panel",
  why: ["Mocked reason"],
  caveats: [],
  usedModel: "mock-model",
};

export const EXPLAIN_RESPONSE = {
  bullets: ["Mock bullet one.", "Mock bullet two.", "Mock bullet three."],
  caveat: "Mock caveat.",
};

export const TTS_NOTE = "Mock TTS disabled: add an ElevenLabs key.";

export const HISTORY_SNAPSHOT = {
  mode: "address",
  address: "500 History Ave, Oakland, CA",
  lat: 37.8044,
  lng: -122.2712,
  zoom: 19,
  mPerPx: 0.07,
  siteSpec: { tiltDeg: 25, azimuthDeg: 170, lossesPct: 12 },
  panelSpec: { widthM: 1.13, heightM: 1.72, wattW: 425, gapM: 0.02 },
  layoutSummary: { orientationDeg: 0, panelCount: 12, dcKw: 5.1 },
  geometry: {
    vertices: [
      { x: 364, y: 252 },
      { x: 676, y: 252 },
      { x: 676, y: 468 },
      { x: 364, y: 468 },
    ],
    closed: true,
    mPerPx: 0.07,
    zoom: 19,
  },
  estimate: null,
};

export const HISTORY_ITEM = {
  id: "hist1",
  title: "History Ave",
  note: null,
  pinned: false,
  queryHash: "h1",
  summary: {
    address: HISTORY_SNAPSHOT.address,
    panelCount: 12,
    dcKw: 5.1,
    annualKwh: 7000,
    annualCo2Kg: 2500,
    lat: HISTORY_SNAPSHOT.lat,
    lng: HISTORY_SNAPSHOT.lng,
  },
  createdAt: "2026-06-01T10:00:00.000Z",
  updatedAt: "2026-06-01T10:00:00.000Z",
};

export const SHARED_PROJECT = {
  name: "Untitled",
  siteSpec: { lat: LAT, lng: LNG, tiltDeg: 20, azimuthDeg: 180, lossesPct: 14 },
  panelSpec: { widthM: 1.13, heightM: 1.72, wattW: 425, gapM: 0.02 },
  layoutSummary: { dcKw: 4.3, panelCount: 10, orientationDeg: 0 },
  geometry: {
    vertices: [
      { x: 364, y: 252 },
      { x: 676, y: 252 },
      { x: 676, y: 468 },
      { x: 364, y: 468 },
    ],
    closed: true,
    mPerPx: 0.07,
    background: "address",
    zoom: 19,
  },
  estimate: {
    annualKwh: 9876,
    monthlyKwh: Array.from({ length: 12 }, () => 823),
    annualCo2Kg: 3210,
    source: "server",
  },
  updatedAt: "2026-06-01T10:00:00.000Z",
};
