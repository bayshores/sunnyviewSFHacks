import { expect, type Page } from "@playwright/test";
import { ADDRESS } from "./data";

/** Wait until the startup loader is gone and the hero is interactive. */
export async function waitForLanding(page: Page) {
  await expect(page.getByRole("button", { name: "Launch Demo" })).toBeVisible({ timeout: 60_000 });
}

/** Open the app from the landing page via the hero CTA. */
export async function launchApp(page: Page) {
  await page.goto("/");
  await waitForLanding(page);
  await page.getByRole("button", { name: "Launch Demo" }).click();
  await expect(page.getByText("Find a house by address")).toBeVisible();
}

/** Type an address and pick the (mocked) suggestion. */
export async function searchAndPickAddress(page: Page) {
  const input = page.getByPlaceholder(ADDRESS);
  await input.click();
  await input.fill("1600 Amphitheatre");
  await page.getByRole("button", { name: /1600 Amphitheatre Pkwy/ }).click();
}
