import { expect, test } from "@playwright/test";
import { launchApp } from "./fixtures/app";
import { HISTORY_ITEM, HISTORY_SNAPSHOT } from "./fixtures/data";
import { installMocks } from "./fixtures/mocks";

test.describe("history", () => {
  test("lists mocked items and Load restores the snapshot", async ({ page }) => {
    const mocks = await installMocks(page, { historyItems: [HISTORY_ITEM] });
    await launchApp(page);

    await page.getByRole("button", { name: "History", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(HISTORY_ITEM.title, { exact: true })).toBeVisible();
    await expect(dialog.getByText(HISTORY_SNAPSHOT.address)).toBeVisible();
    await expect(dialog.getByText("12", { exact: true })).toBeVisible();

    await dialog.getByRole("button", { name: "Load" }).click();
    await expect.poll(() => mocks.find("GET", `/api/history/${HISTORY_ITEM.id}`).length).toBe(1);

    await expect(page.getByText("Loaded history snapshot.")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    // Snapshot site fields are applied to the Site panel.
    await expect(page.getByPlaceholder("34.0522")).toHaveValue(String(HISTORY_SNAPSHOT.lat));
    await expect(page.getByPlaceholder("1600 Amphitheatre Parkway, Mountain View, CA")).toHaveValue(
      HISTORY_SNAPSHOT.address,
    );
  });

  test("shows the empty state when there is no history", async ({ page }) => {
    await installMocks(page, { historyItems: [] });
    await launchApp(page);
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect(page.getByText("No history yet.")).toBeVisible();
  });
});
