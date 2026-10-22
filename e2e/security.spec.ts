import { expect, test } from "@playwright/test";
import { launchApp, searchAndPickAddress } from "./fixtures/app";
import { installMocks } from "./fixtures/mocks";

const GEMINI_KEY = "e2e-gemini-key-123";
const ELEVENLABS_KEY = "e2e-elevenlabs-key-456";

// NOTE: NEXT_PUBLIC_API_ORIGIN is inlined at build time, so it cannot be flipped at
// runtime. These tests only cover the default same-origin setup, where local keys MUST be
// forwarded. The cross-origin "key withheld" branch is covered by unit tests
// (components/sunnyview/local-keys.ts) rather than E2E.
test.describe("local API keys (same-origin)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ([gk, ek]) => {
        window.localStorage.setItem("sunnyview-gemini-api-key-v1", gk);
        window.localStorage.setItem("sunnyview-elevenlabs-api-key-v1", ek);
      },
      [GEMINI_KEY, ELEVENLABS_KEY],
    );
  });

  test("panel-recommend and tts carry their key headers", async ({ page }) => {
    const mocks = await installMocks(page);
    await launchApp(page);
    await searchAndPickAddress(page);

    await expect.poll(() => mocks.find("POST", "/api/panel-recommend").length).toBeGreaterThan(0);
    expect(mocks.find("POST", "/api/panel-recommend")[0].headers["x-gemini-api-key"]).toBe(GEMINI_KEY);

    await expect(page.getByRole("button", { name: "Talk", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Talk", exact: true }).click();
    await expect.poll(() => mocks.find("POST", "/api/tts").length).toBeGreaterThan(0);
    const tts = mocks.find("POST", "/api/tts")[0];
    expect(tts.headers["x-elevenlabs-api-key"]).toBe(ELEVENLABS_KEY);

    // Keys must never leak into request bodies or query strings.
    for (const c of mocks.calls) {
      expect(c.rawBody ?? "").not.toContain(GEMINI_KEY);
      expect(c.rawBody ?? "").not.toContain(ELEVENLABS_KEY);
      expect(c.search).not.toContain(GEMINI_KEY);
      expect(c.search).not.toContain(ELEVENLABS_KEY);
    }
  });

  test("no key headers are sent when nothing is stored", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.removeItem("sunnyview-gemini-api-key-v1");
      window.localStorage.removeItem("sunnyview-elevenlabs-api-key-v1");
    });
    const mocks = await installMocks(page);
    await launchApp(page);
    await searchAndPickAddress(page);

    await expect.poll(() => mocks.find("POST", "/api/panel-recommend").length).toBeGreaterThan(0);
    const headers = mocks.find("POST", "/api/panel-recommend")[0].headers;
    expect(headers["x-gemini-api-key"]).toBeUndefined();
  });
});
