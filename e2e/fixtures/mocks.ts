import type { Page, Route } from "@playwright/test";
import {
  ESTIMATE_RESPONSE,
  EXPLAIN_RESPONSE,
  FORECAST_RESPONSE,
  HISTORY_ITEM,
  HISTORY_SNAPSHOT,
  PANEL_RECOMMEND_RESPONSE,
  PROJECT_ID,
  RESOLVED,
  SEGMENT_RESPONSE,
  SHARED_PROJECT,
  SHARE_SLUG,
  SUGGESTION,
  TTS_NOTE,
} from "./data";
import { STATIC_MAP_PNG } from "./png";

export type RecordedCall = {
  method: string;
  pathname: string;
  search: string;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string | null;
};

export type MockOptions = {
  /** Status for POST /api/projects (201 default, 503 = storage not configured). */
  projectsCreateStatus?: number;
  /** Status for GET /api/share/:slug (200 default, 404 = not found). */
  shareStatus?: number;
  /** Items returned by GET /api/history. */
  historyItems?: unknown[];
};

export type ApiMocks = {
  calls: RecordedCall[];
  /** Calls matching method + pathname (string equality or RegExp). */
  find: (method: string, path: string | RegExp) => RecordedCall[];
};

const EXTERNAL_HOSTS =
  /(^|\.)(arcgisonline\.com|openstreetmap\.org|overpass-api\.de|overpass\.kumi\.systems|nominatim\.org|cesium\.com|mapbox\.com|googleapis\.com|gstatic\.com|open-meteo\.com)$/;

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function parseBody(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function projectStub() {
  return {
    id: PROJECT_ID,
    shareSlug: SHARE_SLUG,
    name: "Untitled",
    siteSpec: null,
    panelSpec: null,
    layoutSummary: null,
    geometry: null,
    estimate: null,
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
  };
}

/**
 * Installs hermetic network mocks: every /api/** call is answered in the browser and
 * recorded; external imagery/geocoding hosts are aborted.
 */
export async function installMocks(page: Page, opts: MockOptions = {}): Promise<ApiMocks> {
  const calls: RecordedCall[] = [];
  const projectsStatus = opts.projectsCreateStatus ?? 201;
  const shareStatus = opts.shareStatus ?? 200;
  const historyItems = opts.historyItems ?? [];

  await page.route((url) => EXTERNAL_HOSTS.test(url.hostname), (route) => route.abort());

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const method = req.method();
      const rawBody = req.postData();
      calls.push({
        method,
        pathname: url.pathname,
        search: url.search,
        headers: req.headers(),
        body: parseBody(rawBody),
        rawBody,
      });
      const p = url.pathname;

      if (p === "/api/geocode") {
        if (url.searchParams.get("mode") === "suggest") {
          return json(route, { results: [SUGGESTION], warning: null });
        }
        return json(route, { results: [RESOLVED], warning: null });
      }
      if (p === "/api/reverse-geocode") return json(route, { displayName: RESOLVED.displayName });
      if (p === "/api/static-map") {
        return route.fulfill({ status: 200, contentType: "image/png", body: STATIC_MAP_PNG });
      }
      if (p === "/api/segment") return json(route, SEGMENT_RESPONSE);
      if (p === "/api/estimate") return json(route, ESTIMATE_RESPONSE);
      if (p === "/api/forecast") return json(route, FORECAST_RESPONSE);
      if (p === "/api/panel-recommend") return json(route, PANEL_RECOMMEND_RESPONSE);
      if (p === "/api/explain") return json(route, EXPLAIN_RESPONSE);
      if (p === "/api/tts") return json(route, { audioUrl: null, note: TTS_NOTE });
      if (p === "/api/gemini-validate" || p === "/api/elevenlabs-validate") {
        return json(route, { ok: false, envLoaded: false });
      }

      if (p === "/api/history" && method === "GET") return json(route, { items: historyItems });
      if (p === "/api/history" && method === "POST") {
        return json(route, { item: { ...HISTORY_ITEM, snapshot: HISTORY_SNAPSHOT } }, 201);
      }
      if (p.startsWith("/api/history/") && method === "GET") {
        return json(route, { item: { ...HISTORY_ITEM, snapshot: HISTORY_SNAPSHOT } });
      }
      if (p.startsWith("/api/history/")) return json(route, { item: HISTORY_ITEM });

      if (p === "/api/projects" && method === "POST") {
        if (projectsStatus !== 201 && projectsStatus !== 200) {
          return json(route, { error: "Project storage is not configured." }, projectsStatus);
        }
        return json(route, { projectId: PROJECT_ID, shareSlug: SHARE_SLUG }, 201);
      }
      if (p.startsWith("/api/projects/") && method === "PATCH") {
        return json(route, { project: projectStub() });
      }
      if (p.startsWith("/api/share/")) {
        if (shareStatus === 200) return json(route, { project: SHARED_PROJECT });
        return json(route, { error: "Not found" }, shareStatus);
      }

      return json(route, { error: `Unmocked e2e route: ${method} ${p}` }, 404);
    },
  );

  return {
    calls,
    find: (method, path) =>
      calls.filter(
        (c) => c.method === method && (typeof path === "string" ? c.pathname === path : path.test(c.pathname)),
      ),
  };
}
