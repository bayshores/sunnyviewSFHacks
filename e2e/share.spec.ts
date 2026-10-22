import { expect, test } from "@playwright/test";
import { launchApp, searchAndPickAddress } from "./fixtures/app";
import { PROJECT_ID, SHARE_SLUG } from "./fixtures/data";
import { installMocks } from "./fixtures/mocks";

test.describe("sharing", () => {
  test("creates a project, enables Share, shows the public link, PATCH has no image data", async ({ page }) => {
    const mocks = await installMocks(page);
    await launchApp(page);
    await searchAndPickAddress(page);

    await expect.poll(() => mocks.find("POST", "/api/projects").length).toBeGreaterThan(0);
    const share = page.getByRole("button", { name: "Share", exact: true });
    await expect(share).toBeEnabled();

    await share.click();
    await expect(page.getByText("Public link")).toBeVisible();
    await expect(page.getByText(`/s/${SHARE_SLUG}`).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(page.getByText(SHARE_SLUG, { exact: true })).toBeVisible();

    // Debounced PATCH (900ms) after the roof/estimate settle.
    const patchPath = new RegExp(`^/api/projects/${PROJECT_ID}$`);
    await expect.poll(() => mocks.find("PATCH", patchPath).length, { timeout: 15_000 }).toBeGreaterThan(0);
    for (const call of mocks.find("PATCH", patchPath)) {
      expect(call.rawBody ?? "").not.toContain("data:image");
    }
    for (const call of mocks.find("POST", "/api/projects")) {
      expect(call.rawBody ?? "").not.toContain("data:image");
    }
  });

  test("503 on project create disables Share and explains why", async ({ page }) => {
    const mocks = await installMocks(page, { projectsCreateStatus: 503 });
    await launchApp(page);
    await searchAndPickAddress(page);

    await expect.poll(() => mocks.find("POST", "/api/projects").length).toBeGreaterThan(0);
    await expect(page.getByText("Sharing is unavailable: project storage isn't configured.").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Share", exact: true })).toBeDisabled();
  });

  test("/s/:slug renders the shared project cards", async ({ page }) => {
    await installMocks(page);
    await page.goto(`/s/${SHARE_SLUG}`);
    await expect(page.getByText("Panels", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("DC kW", { exact: true })).toBeVisible();
    await expect(page.getByText("Annual kWh", { exact: true })).toBeVisible();
    await expect(page.getByText("9,876")).toBeVisible();
  });

  test("/s/:slug with 404 shows the not-found message", async ({ page }) => {
    await installMocks(page, { shareStatus: 404 });
    await page.goto(`/s/${SHARE_SLUG}`);
    await expect(page.getByText("Shared project not found")).toBeVisible({ timeout: 60_000 });
  });
});
