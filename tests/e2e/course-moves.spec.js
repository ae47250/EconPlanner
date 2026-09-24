import { expect, test } from "./nightly-observability.js";
import AxeBuilder from "@axe-core/playwright";
import {
  courseOccurrences, projectReportHtmlArtifact, projectReportJsonArtifact, projectSelectedPlanArtifact, projectionMismatches
} from "../oracle/economics-artifact-projection.js";
import {
  resetPlanner, chooseStanding, continueToCourses, generatePlans, setCourseStatus
} from "./cp7-helpers.js";

async function openPlan(page, standing, { early = false, completed = [], date = "2026-09-23" } = {}) {
  await resetPlanner(page);
  await chooseStanding(page, standing);
  await page.locator("details.more-details > summary").first().click();
  await page.getByLabel("Plan creation date", { exact: true }).fill(date);
  if (early) await page.getByRole("button", { name: "I’d like to graduate one year early", exact: true }).click();
  await continueToCourses(page);
  for (const code of completed) await setCourseStatus(page, code, "Completed");
  const response = await generatePlans(page);
  expect(response.status()).toBe(200);
  const result = await response.json();
  const plans = result.programs.find(item => item.program.id === "economics-base").economicsPlans;
  const selected = plans.find(plan => plan.id === (early ? "one-year-early" : "balanced"));
  expect(selected).toBeTruthy();
  await page.getByRole("button", { name: new RegExp(`^(Choose|Review selected) ${selected.label}$`) }).click();
  return { selected, plans, student: response.request().postDataJSON().student };
}

function card(page, code) {
  return page.locator(".term-card li").filter({ has: page.locator(".plan-course-summary > strong", { hasText: code }) }).first();
}

function validationResponse(page) {
  return page.waitForResponse(response => response.url().endsWith("/api/majors/map")
    && response.request().postDataJSON()?.action === "validate-plan");
}

test("move selectors, rejection feedback, successful move, undo, and reload agree", async ({ page }) => {
  await openPlan(page, "freshman", { early: true });
  const core = page.getByRole("combobox", { name: "Move ECO 113 to another term", exact: true });
  await expect(core.locator('option[value^="spring-"]')).toHaveCount(0);
  await expect(card(page, "ECO 113")).toContainText("normally planned in Fall or Winter");
  await expect(page.getByRole("combobox", { name: "Move ECO 222 to another term", exact: true })).toHaveCount(0);
  await expect(card(page, "ECO 222")).toContainText("typically offered only in Spring/May");
  await expect(page.getByRole("combobox", { name: "Move ECO 461 to another term", exact: true })).toHaveCount(0);
  await expect(card(page, "ECO 461")).toContainText("senior standing in the final year");

  await core.focus();
  const rejectedResponse = validationResponse(page);
  await core.selectOption("fall-2027");
  expect((await rejectedResponse).status()).toBe(422);
  await expect(core).toBeFocused();
  await expect(core).toHaveValue("winter-2027");
  await expect(card(page, "ECO 113").getByRole("alert")).toContainText("ECO 213 is missing prerequisites: ECO 113");
  await expect(page.getByRole("button", { name: "Undo last plan edit" })).toHaveCount(0);

  const statistics = page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true });
  const movedResponse = validationResponse(page);
  await statistics.selectOption("winter-2027");
  const moved = await movedResponse;
  expect(moved.status()).toBe(200);
  const movedPlan = (await moved.json()).plan;
  expect(movedPlan.terms.find(term => term.slotId === "winter-2027").courses.some(course => course.course === "MAT 217")).toBe(true);
  await expect(page.locator("main")).not.toContainText("Seat availability for MAT 217-S was last checked");
  await expect(page.locator('.term-card[data-term-key="Spring"]', { hasText: "Spring/May" }).first()).toContainText("No courses placed");
  await expect(card(page, "ECO 113").getByRole("alert")).toHaveCount(0);
  const visibleCodes = await page.locator(".term-card .plan-course-summary > strong").allInnerTexts();
  expect(visibleCodes.sort()).toEqual(movedPlan.terms.flatMap(term => term.courses.map(course => course.course)).sort());
  const reportInput = { student: moved.request().postDataJSON().student, preparedDate: "2026-09-23", selectedPlan: movedPlan };
  const jsonResponse = await page.request.post("/api/reports/economics", { data: { ...reportInput, format: "json" } });
  expect(jsonResponse.status()).toBe(200);
  const report = await jsonResponse.json();
  expect(report.selectedPlan.terms.find(term => term.slotId === "winter-2027").courses.some(course => course.course === "MAT 217")).toBe(true);
  const htmlResponse = await page.request.post("/api/reports/economics", { data: { ...reportInput, format: "html" } });
  expect(htmlResponse.status()).toBe(200);
  const expectedReport = projectSelectedPlanArtifact(movedPlan, { advisorNotices: report.catalog?.advisorAttention || [] });
  const reportHtml = await htmlResponse.text();
  expect(reportHtml).not.toContain("Seat availability for MAT 217-S was last checked");
  const htmlProjection = projectReportHtmlArtifact(reportHtml);
  expect(htmlProjection.selectedPlanId).toBe(movedPlan.id);
  expect(courseOccurrences(htmlProjection, "MAT 217")).toBe(1);
  const reportParity = projectionMismatches(expectedReport, projectReportJsonArtifact(report));
  await page.getByRole("button", { name: "Undo last plan edit" }).click();
  await expect(page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true })).toHaveValue("spring-2027");

  const savedResponse = validationResponse(page);
  await page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true }).selectOption("winter-2027");
  expect((await savedResponse).status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true })).toHaveValue("winter-2027");
  await page.getByRole("button", { name: "← Back to plan comparison", exact: true }).click();
  await page.getByRole("button", { name: /^(Choose|Review selected) Balanced$/ }).click();
  await page.getByRole("button", { name: "← Back to plan comparison", exact: true }).click();
  await page.getByRole("button", { name: /^(Choose|Review selected) One Year Early$/ }).click();
  await expect(page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true })).toHaveValue("winter-2027");
  expect(reportParity).toEqual([]);
});

test("after an elective replacement the May 2027 card still rejects an unsupported move", async ({ page }) => {
  const { student, plans } = await openPlan(page, "senior", {
    date: "2026-07-30",
    completed: ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "BUSN 323"]
  });
  const may = page.locator('.term-card[data-term-key="Spring"]');
  await expect(may).toContainText("ECO 222");
  await expect(may.locator(".plan-course-summary > strong")).toHaveCount(1);
  const replacement = may.getByRole("combobox", { name: "Choose elective for Spring/May", exact: true });
  const option = replacement.locator("option", { hasText: "ECO 260" });
  const value = await option.getAttribute("value");
  const response = validationResponse(page);
  await replacement.selectOption(value);
  const replacementResponse = await response;
  expect(replacementResponse.status()).toBe(200);
  const updatedPlan = (await replacementResponse.json()).plan;
  await expect(may).toContainText("ECO 260");
  await expect(may.locator(".plan-course-summary > strong")).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "Move ECO 260 to another term", exact: true })).toHaveCount(0);
  const mayTerm = updatedPlan.terms.find(term => term.slotId === "spring-2027");
  const elective = mayTerm.courses.find(course => course.course === "ECO 260");
  const selected = await page.request.post("/api/majors/map", {
    data: {
      action: "validate-plan", student, plan: updatedPlan,
      plans: plans.map(plan => plan.id === updatedPlan.id ? updatedPlan : plan),
      edit: { type: "move", planId: updatedPlan.id, fromTermId: mayTerm.slotId,
        toTermId: "winter-2027", courseId: elective.requirementId }
    }
  });
  expect(selected.status()).toBe(422);
  expect((await selected.json()).error).toMatch(/no supported offering in Winter 2027/);
});

test("move controls stay disabled during an outstanding validation request", async ({ page }) => {
  await openPlan(page, "freshman", { early: true });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let validationRequests = 0;
  await page.route("**/api/majors/map", async route => {
    if (route.request().postDataJSON()?.action === "validate-plan") {
      validationRequests += 1;
      await gate;
    }
    await route.continue();
  });
  const first = page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true });
  const second = page.getByRole("combobox", { name: "Move ECO 113 to another term", exact: true });
  const response = validationResponse(page);
  await first.selectOption("winter-2027");
  await expect(first).toBeDisabled();
  await expect(second).toBeDisabled();
  release();
  expect((await response).status()).toBe(200);
  await expect(page.locator(".plan-edit-status")).toContainText("updated and remains valid");
  expect(validationRequests).toBe(1);
});

test("a move error remains readable and announced at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPlan(page, "freshman", { early: true });
  const control = page.getByRole("combobox", { name: "Move ECO 113 to another term", exact: true });
  await control.focus();
  const response = validationResponse(page);
  await control.selectOption("fall-2027");
  expect((await response).status()).toBe(422);
  const feedback = card(page, "ECO 113").getByRole("alert");
  await expect(feedback).toBeVisible();
  await expect(feedback).toContainText("ECO 213 is missing prerequisites: ECO 113");
  await expect(control).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const accessibility = await new AxeBuilder({ page }).include(".plan-course-edit-feedback")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
});
