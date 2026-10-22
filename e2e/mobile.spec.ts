import { expect, test } from "@playwright/test";
import { launchApp } from "./fixtures/app";
import { installMocks } from "./fixtures/mocks";

test.use({ viewport: { width: 390, height: 844 } });

test.describe("mobile layout", () => {
  test("Setup / Results tabs switch panes", async ({ page }) => {
    await installMocks(page);
    await launchApp(page);

    const setupTab = page.getByRole("button", { name: "Setup", exact: true });
    const resultsTab = page.getByRole("button", { name: "Results", exact: true });
    await expect(setupTab).toBeVisible();
    await expect(page.getByText("Find a house by address")).toBeVisible();
    await expect(page.getByText("Production forecast")).toHaveCount(0);

    await resultsTab.click();
    await expect(page.getByText("Production forecast")).toBeVisible();
    await expect(page.getByText("Panel packing")).toBeVisible();
    await expect(page.getByText("Find a house by address")).toHaveCount(0);

    await setupTab.click();
    await expect(page.getByText("Find a house by address")).toBeVisible();
  });
});
