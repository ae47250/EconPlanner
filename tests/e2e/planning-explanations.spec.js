import { expect, test } from "@playwright/test";
import { resetPlanner, chooseStanding, continueToCourses, generatePlans, setCourseStatus } from "./cp7-helpers.js";

test("comparison header names both standard and selected early targets, and tab uses EconPlanner", async ({ page }) => {
  await resetPlanner(page);
  await expect(page).toHaveTitle("EconPlanner");
  await chooseStanding(page, "sophomore");
  await page.locator("details.more-details > summary").first().click();
  await page.getByLabel("Plan creation date", { exact: true }).fill("2026-11-21");
  await page.getByRole("button", { name: "I’d like to graduate one year early", exact: true }).click();
  await continueToCourses(page);
  await setCourseStatus(page, "ECO 113", "Completed");
  await setCourseStatus(page, "ECO 114", "Taking now");
  const response = await generatePlans(page);
  const body = await response.json();
  const result = body.programs.find(item => item.program.id === "economics-base");
  assertEarlyPlan(result);
  await expect(page.locator(".comparison-student")).toContainText("Graduation target: May 2029 (one year early: May 2028)");
  await expect(page.locator(".comparison-course-status")).toContainText("May 2029 (one year early: May 2028)");
});

function assertEarlyPlan(result) {
  expect(result.economicsPlans.some(plan => plan.id === "one-year-early" && plan.planningContext.expectedGraduationTerm === "Spring/May 2028")).toBe(true);
}

test("AP or exam credit advisor status includes a visible Why line", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await page.locator("details.more-details > summary").first().click();
  await page.getByLabel("Plan creation date", { exact: true }).fill("2026-11-21");
  await continueToCourses(page);
  for (const code of ["ECO 113", "ECO 114"]) {
    await setCourseStatus(page, code, "Completed");
    const course = page.locator(`#course-${code.toLowerCase().replace(" ", "-")}`);
    await course.getByRole("button", { name: "Transfer or AP credit?" }).click();
    await course.getByRole("button", { name: "AP or exam credit" }).click();
  }
  await generatePlans(page);
  await expect(page.locator(".result-status-value")).toContainText("Needs advisor attention");
  await expect(page.locator(".result-status-reason").last()).toContainText("Why: ECO 113 and ECO 114 are recorded as AP or exam credit.");
  const balanced = page.locator('article[data-plan-id="balanced"]');
  await balanced.locator("summary").filter({ hasText: "Things to keep in mind" }).click();
  await expect(balanced.locator(".upfront-conditions h3").filter({ hasText: "Check with your advisor" })).toBeVisible();
  await expect(balanced.getByText("Based on your class year, your catalog year is likely 2026–2027. The Economics major requirements are the same for both years.")).toBeVisible();
});

test("completed course shows its prerequisite review as soon as both statuses are chosen", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "sophomore");
  await continueToCourses(page);
  await setCourseStatus(page, "ECO 214", "Completed");
  await setCourseStatus(page, "MAT 113", "Completed");
  const advanced = page.locator("#course-eco-214");
  await expect(advanced.getByText(/You marked ECO 214 completed, but ECO 114.*not marked completed/)).toBeVisible();
  await setCourseStatus(page, "ECO 114", "Taking now");
  await expect(advanced.getByText(/You marked ECO 214 completed, but ECO 114.*marked Taking now/)).toBeVisible();
  await setCourseStatus(page, "ECO 114", "Completed");
  await expect(advanced.getByText(/You marked ECO 214 completed, but ECO 114/)).toHaveCount(0);
});
