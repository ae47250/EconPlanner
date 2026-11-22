import { expect, test } from "@playwright/test";
import { resetPlanner, chooseStanding, continueToCourses, generatePlans, setCourseStatus, fixturePlan, openFixtureResult, plannerResultFixture, visitPlan } from "./cp7-helpers.js";

test("both plan views use the same course-moving instructions", async ({ page }) => {
  await openFixtureResult(page, plannerResultFixture({ plans: [fixturePlan(), fixturePlan({ id: "explore-first", label: "Explore first" })] }));
  const firstLine = "Click a course to see where it can move. You can also drag it by the ⠿ handle.";
  const secondLine = "While you drag, green terms are open, amber terms need a permission or check first, and gray terms show why the course can't go there.";
  for (const view of ["compare", "single plan"]) {
    await expect(page.locator(".plan-edit-instructions strong"), view).toHaveText(firstLine);
    await expect(page.locator(".plan-edit-instructions span"), view).toHaveText(secondLine);
    if (view === "compare") await visitPlan(page, "balanced");
  }
});

test("Student readiness explains each displayed status", async ({ page }) => {
  const cases = [
    ["STUDENT_READY", "COMPLETE_STUDENT_READY", "Ready to plan", "These plans meet the major rules. Seats are not confirmed, so check the registration system before you register."],
    ["READY_WITH_CONDITIONS", "COMPLETE_READY_WITH_CONDITIONS", "Needs confirmation", "These plans work only if the conditions shown on them are met, such as an instructor's permission or confirmed senior standing. Check each plan's conditions."],
    ["ADVISOR_ACTION_REQUIRED", "COMPLETE_ADVISOR_ACTION_REQUIRED", "Needs advisor attention", "Something in your answers needs your advisor to check it before you rely on these plans."]
  ];
  for (const [readinessStatus, planDisposition, label, explanation] of cases) {
    await openFixtureResult(page, plannerResultFixture({ plans: [fixturePlan({ readinessStatus, planDisposition })] }));
    await expect(page.locator(".result-status-value")).toHaveText(label);
    await expect(page.locator(".result-status-reason").first()).toHaveText(explanation);
  }
});

test("a junior's custom one-year-early ECO 461 plan displays Needs confirmation", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "junior");
  await page.locator("details.more-details > summary").first().click();
  await page.getByLabel("Plan creation date", { exact: true }).fill("2026-11-21");
  await page.getByRole("button", { name: "My expected graduation year is different" }).click();
  await page.getByLabel("When do you expect to graduate?").selectOption("2027");
  await continueToCourses(page);
  await page.locator("details.course-accordion > summary").filter({ hasText: "Other Economics courses" }).click();
  for (const code of ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 121", "MAT 217", "BUSN 323", "ECO 315", "ECO 337"]) {
    await setCourseStatus(page, code, "Completed");
  }
  await setCourseStatus(page, "ECO 333", "Taking now");
  const response = await generatePlans(page);
  const result = (await response.json()).programs.find(item => item.program.id === "economics-base");
  expect(result.economicsPlans[0].readinessStatus).toBe("READY_WITH_CONDITIONS");
  await expect(page.locator(".result-status-value")).toHaveText("Needs confirmation");
  await expect(page.locator(".result-status-reason").first()).toHaveText("These plans work only if the conditions shown on them are met, such as an instructor's permission or confirmed senior standing. Check each plan's conditions.");
  await expect(page.locator(".comparison-course-status > p").first()).toContainText("Class standingJunior (custom graduation year)");
  await expect(page.locator(".comparison-student strong")).toHaveText("Junior (custom graduation year)");
});

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
  await expect(page.locator(".comparison-course-status > p").first()).toContainText("Class standingSophomore (graduating one year early)");
  await expect(page.locator(".comparison-student strong")).toHaveText("Sophomore (graduating one year early)");
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
  await expect(page.locator(".comparison-course-status > p").first()).toContainText("Class standingFreshman");
  await expect(page.locator(".comparison-student strong")).toHaveText("Freshman");
  await expect(page.locator(".comparison-course-status strong").filter({ hasText: "Study abroad" })).toHaveCount(0);
  await expect(page.locator(".comparison-student")).not.toContainText("Study abroad:");
  const balanced = page.locator('article[data-plan-id="balanced"]');
  await balanced.locator("summary").filter({ hasText: "Things to keep in mind" }).click();
  await expect(balanced.locator(".upfront-conditions h3").filter({ hasText: "Check with your advisor" })).toBeVisible();
  await expect(balanced.getByText("Based on your class year, your catalog year is likely 2026–2027. The Economics major requirements are the same for both years.")).toBeVisible();
});

test("selected study abroad appears in the result summary and top strip", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "sophomore");
  await page.locator("details.more-details > summary").first().click();
  await page.getByLabel("Plan creation date", { exact: true }).fill("2026-11-21");
  await page.locator("details.more-details > summary").filter({ hasText: "Adjust your schedule" }).click();
  await page.getByRole("button", { name: "I plan to study abroad during my junior year" }).click();
  await page.getByLabel("Study-abroad term").selectOption("winter-2028");
  await expect(page.locator(".cp7-summary")).toContainText("No Economics courses in Winter 2028");
  await continueToCourses(page);
  await generatePlans(page);
  await expect(page.locator(".comparison-course-status > p").filter({ hasText: "Study abroad" })).toHaveText("Study abroadWinter 2028");
  await expect(page.locator(".comparison-student")).toContainText("Study abroad: Winter 2028");
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

test("Student readiness Why line puts additional prerequisite issues in parentheses", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "sophomore");
  await continueToCourses(page);
  await setCourseStatus(page, "ECO 214", "Completed");
  await generatePlans(page);
  await expect(page.locator(".result-status-value")).toHaveText("Needs advisor attention");
  await expect(page.locator(".result-status-reason").last()).toContainText("advisor will check it. (1 more item below.)");
});
