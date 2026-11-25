import { test, expect } from "@playwright/test";
import { chooseStanding, continueToCourses, resetPlanner } from "./cp7-helpers.js";

async function openOtherCourses(page) {
  const accordion = page.locator("details.course-accordion").filter({ hasText: "Other Economics courses" });
  if (!(await accordion.evaluate(node => node.open))) await accordion.locator("summary").click();
}

async function eco461Group(page, date, standing) {
  await page.clock.install({ time: new Date(`${date}T12:00:00`) });
  await resetPlanner(page);
  await chooseStanding(page, standing);
  await continueToCourses(page);
  await openOtherCourses(page);
  return page.locator("#course-eco-461");
}

// Owner decision Nov 25, 2026 (update): seniors may mark ECO 461 "Taking now" only in a Winter term.
test("seniors see Taking now for ECO 461 in Winter", async ({ page }) => {
  const row = await eco461Group(page, "2027-01-20", "senior");
  const group = row.getByRole("group", { name: "Status for ECO 461" });
  const takingNow = group.getByRole("button", { name: "Taking now" });
  await expect(takingNow).toHaveAttribute("aria-pressed", "false");
  await takingNow.click();
  await expect(takingNow).toHaveAttribute("aria-pressed", "true");
  await expect(group.getByRole("button", { name: "Completed" })).toHaveAttribute("aria-pressed", "false");
});

test("seniors do not see Taking now for ECO 461 in Fall", async ({ page }) => {
  const row = await eco461Group(page, "2026-10-15", "senior");
  const group = row.getByRole("group", { name: "Status for ECO 461" });
  await expect(group.getByRole("button", { name: "Completed" })).toBeVisible();
  await expect(group.getByRole("button", { name: "Taking now" })).toHaveCount(0);
});

test("changing the plan date out of Winter clears a taking-now ECO 461", async ({ page }) => {
  const row = await eco461Group(page, "2027-01-20", "senior");
  const group = row.getByRole("group", { name: "Status for ECO 461" });
  await group.getByRole("button", { name: "Taking now" }).click();
  await expect(page.locator(".cp7-summary")).toContainText("ECO 461");
  await page.getByRole("navigation", { name: "Planner progress" }).getByRole("button", { name: "About you", exact: true }).click();
  const dateInput = page.locator("#plan-creation-date");
  if (!(await dateInput.isVisible())) await page.locator("details:has(#plan-creation-date) > summary").click();
  await dateInput.fill("2027-05-10");
  await continueToCourses(page);
  await openOtherCourses(page);
  await expect(group.getByRole("button", { name: "Taking now" })).toHaveCount(0);
  await expect(group.getByRole("button", { name: "Completed" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".cp7-summary")).not.toContainText("ECO 461");
});
