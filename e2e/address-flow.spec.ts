import { expect, test, type Page } from "@playwright/test";
import { launchApp, searchAndPickAddress } from "./fixtures/app";
import { LAT, LNG, TTS_NOTE } from "./fixtures/data";
import { installMocks } from "./fixtures/mocks";

function statCard(page: Page, label: string) {
  return page.locator("div.stagger-item", { has: page.getByText(label, { exact: true }) });
}

function panelCountCard(page: Page) {
  return page.locator("div.glass-surface", { has: page.getByText("Panels (count)", { exact: true }) });
}

async function readInt(text: string | null): Promise<number> {
  const n = Number((text ?? "").replace(/[^0-9]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

test.describe("address flow (critical path)", () => {
  test("address -> roof outline -> estimate, forecast, explain, talk, panel count, history", async ({ page }) => {
    const mocks = await installMocks(page);
    await launchApp(page);
    await searchAndPickAddress(page);

    // The suggestion is resolved through /api/geocode?mode=resolve.
    await expect.poll(() => mocks.find("GET", "/api/geocode").some((c) => c.search.includes("mode=resolve"))).toBe(true);

    // Auto-outline fires /api/segment with static-map imageUrl + meta.
    await expect.poll(() => mocks.find("POST", "/api/segment").length).toBeGreaterThan(0);
    const seg = mocks.find("POST", "/api/segment")[0].body as {
      imageUrl: string;
      meta: { lat: number; lng: number; zoom: number };
    };
    expect(seg.imageUrl.startsWith("/api/static-map")).toBe(true);
    expect(seg.meta.lat).toBeCloseTo(LAT, 4);
    expect(seg.meta.lng).toBeCloseTo(LNG, 4);
    expect(seg.meta.zoom).toBe(19);

    // Results: panels > 0 and the server estimate replaces the fallback.
    await expect(page.getByText("Server estimate")).toBeVisible();
    await expect
      .poll(async () => readInt(await statCard(page, "Panels").locator("div").last().textContent()))
      .toBeGreaterThan(0);
    await expect(statCard(page, "Annual kWh")).toContainText("12,345");
    expect(mocks.find("POST", "/api/estimate").length).toBeGreaterThan(0);

    // Forecast card (7 x [30..36] kWh = 231.0).
    await expect(page.getByText("Production forecast")).toBeVisible();
    await expect(page.getByText("231.0 kWh")).toBeVisible();

    // Explain bullets.
    await page.getByRole("button", { name: "Explain", exact: true }).click();
    await expect(page.getByText("Mock bullet one.")).toBeVisible();
    await expect(page.getByText("Mock caveat.")).toBeVisible();

    // Talk with null audio shows the server note.
    await page.getByRole("button", { name: "Talk", exact: true }).click();
    await expect(page.getByText(TTS_NOTE)).toBeVisible();

    // Panel count slider + Auto reset.
    const autoBtn = panelCountCard(page).getByRole("button", { name: "Auto" });
    await expect(autoBtn).toBeDisabled();
    const hint = await panelCountCard(page).getByText(/^Auto fits \d+\./).textContent();
    const autoCount = await readInt(/Auto fits (\d+)/.exec(hint ?? "")?.[1] ?? "0");
    expect(autoCount).toBeGreaterThan(2);

    await panelCountCard(page).locator('input[type="range"]').fill("2");
    await expect(autoBtn).toBeEnabled();
    await expect
      .poll(async () => readInt(await statCard(page, "Panels").locator("div").last().textContent()))
      .toBe(2);

    await autoBtn.click();
    await expect(autoBtn).toBeDisabled();
    await expect
      .poll(async () => readInt(await statCard(page, "Panels").locator("div").last().textContent()))
      .toBe(autoCount);

    // History autosave (~1.8s debounce): snapshot + summary.
    await expect.poll(() => mocks.find("POST", "/api/history").length, { timeout: 15_000 }).toBeGreaterThan(0);
    const saved = mocks.find("POST", "/api/history")[0].body as {
      snapshot: { mode: string; lat: number };
      summary: { panelCount: number };
    };
    expect(saved.snapshot.mode).toBe("address");
    expect(saved.snapshot.lat).toBeCloseTo(LAT, 4);
    expect(saved.summary.panelCount).toBeGreaterThan(0);
  });
});
