import { expect, test } from "@playwright/test";
import { launchApp, waitForLanding } from "./fixtures/app";
import { installMocks } from "./fixtures/mocks";

test.describe("landing", () => {
  test.beforeEach(async ({ page }) => {
    await installMocks(page);
  });

  test("startup loader disappears and hero is shown", async ({ page }) => {
    await page.goto("/");
    await waitForLanding(page);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Solar Feasibility in 30 Seconds")).toBeVisible();
  });

  test("Launch Demo opens the app and Back to landing returns", async ({ page }) => {
    await launchApp(page);
    await expect(page.getByText("Site", { exact: true })).toBeVisible();
    // A second "Clear" lives in the roof toolbar, so take the Site panel one (first).
    await expect(page.getByRole("button", { name: "Clear" }).first()).toBeVisible();

    await page.getByRole("button", { name: "Back to landing" }).click();
    await expect(page.getByRole("button", { name: "Launch Demo" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to landing" })).toHaveCount(0);
  });

  test("/?view=app deep link opens the app and strips the query param", async ({ page }) => {
    await page.goto("/?view=app&keep=1");
    await expect(page.getByText("Find a house by address")).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL((url) => !url.searchParams.has("view") && url.searchParams.get("keep") === "1");
  });

  test("Settings opens and Escape closes it", async ({ page }) => {
    await page.goto("/");
    await waitForLanding(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("button", { name: "Launch Demo" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Close settings" })).toBeAttached();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Launch Demo" })).toBeVisible();
  });
});
