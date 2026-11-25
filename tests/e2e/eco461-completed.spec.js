import { test, expect } from "@playwright/test";
import { chooseStanding, continueToCourses, resetPlanner } from "./cp7-helpers.js";

async function openOtherCourses(page) {
  const accordion = page.locator("details.course-accordion").filter({ hasText: "Other Economics courses" });
  if (!(await accordion.evaluate(node => node.open))) await accordion.locator("summary").click();
}

// Owner decision Nov 25, 2026: only seniors can mark ECO 461 Completed (Hanover only).
test("only seniors see a Completed button for ECO 461, and changing standing clears it", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "junior");
  await continueToCourses(page);
  await openOtherCourses(page);
  const row = page.locator("#course-eco-461");
  await expect(row).toContainText("Must be taken at Hanover College");
  await expect(row.getByRole("button", { name: "Completed" })).toHaveCount(0);

  await page.getByRole("navigation", { name: "Planner progress" }).getByRole("button", { name: "About you", exact: true }).click();
  await chooseStanding(page, "senior");
  await continueToCourses(page);
  await openOtherCourses(page);
  const completed = row.getByRole("group", { name: "Status for ECO 461" }).getByRole("button", { name: "Completed" });
  await expect(completed).toHaveAttribute("aria-pressed", "false");
  await expect(row.getByRole("group", { name: "Status for ECO 461" }).getByRole("button", { name: "Taking now" })).toHaveCount(0);
  await completed.click();
  await expect(completed).toHaveAttribute("aria-pressed", "true");
  await expect(row.getByRole("button", { name: "Transfer or AP credit?" })).toHaveCount(0);

  await page.getByRole("navigation", { name: "Planner progress" }).getByRole("button", { name: "About you", exact: true }).click();
  await chooseStanding(page, "junior");
  await continueToCourses(page);
  await openOtherCourses(page);
  await expect(row).toContainText("Must be taken at Hanover College");
  await expect(page.locator(".cp7-summary")).not.toContainText("ECO 461");
});
