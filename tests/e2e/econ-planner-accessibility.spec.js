import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./nightly-observability.js";

async function resetPlanner(page) {
  await page.goto("/?layout=apple");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
}

test("the named strategy controls and plan cards remain keyboard-accessible", async ({ page }) => {
  await resetPlanner(page);
  await expect(page.getByRole("group", { name: "Class standing" })).toBeVisible();
  const pace = page.getByText("How quickly do you want this plan to finish?").locator("..");
  await expect(pace.getByRole("button", { name: "Standard pace" })).toHaveAttribute("aria-pressed", "true");
  await expect(pace.getByRole("button", { name: "One Year Early" })).toBeVisible();

  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(axe.violations).toEqual([]);

  await pace.getByRole("button", { name: "One Year Early" }).focus();
  await expect(pace.getByRole("button", { name: "One Year Early" })).toBeFocused();
});
