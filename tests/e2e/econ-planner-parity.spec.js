import { visitPlan } from "./cp7-helpers.js";
import { expect, test } from "./nightly-observability.js";
import {
  chooseStanding,
  continueToCourses,
  fixturePlan,
  openFixtureResult,
  plannerResultFixture,
  resetPlanner
} from "./cp7-helpers.js";

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function difference(expected, actual) {
  const expectedValues = unique(expected);
  const actualValues = unique(actual);
  return {
    expected: expectedValues.length,
    displayed: actualValues.length,
    missing: expectedValues.filter(value => !actualValues.includes(value)),
    extra: actualValues.filter(value => !expectedValues.includes(value))
  };
}

function readinessLabel(status) {
  return ({
    STUDENT_READY: "Ready to plan",
    READY_WITH_CONDITIONS: "Needs confirmation",
    ADVISOR_ACTION_REQUIRED: "Needs advisor attention"
  })[status] || "Needs advisor attention";
}

test("API and selected-plan UI retain material academic content", async ({ page }, testInfo) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await page.locator("details.more-details > summary").first().click();
  await page.getByLabel("Plan creation date", { exact: true }).fill("2026-07-30");
  await continueToCourses(page);

  const responsePromise = page.waitForResponse(response => (
    response.url().endsWith("/api/majors/map")
    && response.request().method() === "POST"
    && response.request().postDataJSON()?.action !== "validate-plan"
    && response.status() === 200
  ));
  await page.getByRole("button", { name: /Generate my plans/ }).click();
  const response = await responsePromise;
  const body = await response.json();
  const economics = body.programs.find(program => program.program?.id === "economics-base");
  const selectedPlan = economics.economicsPlans[0];
  await expect(page.getByRole("heading", { name: /Compare your course plans|Your plan/ })).toBeVisible({ timeout: 15000 });
  const card = await visitPlan(page, selectedPlan.id);
  await expect(card.getByRole("heading", { name: selectedPlan.label, exact: true })).toBeVisible();
  await card.getByText("More about this plan", { exact: true }).click();

  const displayed = await card.evaluate((element, terms) => {
    const rows = [...element.querySelectorAll(".compact-schedule tr[data-term-id]")];
    return {
      courses: [...element.querySelectorAll(".comparison-editable-course button[aria-label^='Change '], .comparison-editable-course .comparison-fixed-course > strong")].map(item => item.textContent.replace(/\s*▾$/, "").trim().replace(/-[A-Z]$/, "")),
      terms: rows.map(row => {
        const term = terms.find(item => item.slotId === row.dataset.termId);
        return term ? `${term.academicYear || ""}|${term.termKey || ""}` : `unmatched|${row.dataset.termId}`;
      }),
      conditions: [...element.querySelectorAll("[data-plan-conditions] li")].map(item => item.textContent.trim()),
      details: [...element.querySelectorAll(".comparison-disclosure-content > .plan-notes li")].map(item => item.textContent.trim()),
      evidence: element.querySelector("[data-plan-notes]")?.textContent || ""
    };
  }, selectedPlan.terms);
  displayed.pageText = await page.locator("body").innerText();
  const expectedConditions = selectedPlan.planConditions.map(item => item.message);
  expect(Array.isArray(selectedPlan.planningDetailMessages || [])).toBe(true);
  const expectedDetails = [];
  const backendReadiness = selectedPlan.readinessStatus || selectedPlan.validation?.readinessStatus;
  const studentReadiness = readinessLabel(backendReadiness);
  expect(selectedPlan.planNotes.some(note => note.id === "history")).toBe(true);
  const parity = {
    schemaVersion: 2,
    kind: "econplanner-api-ui-parity",
    planId: selectedPlan.id,
    courses: difference(selectedPlan.terms.flatMap(term => term.courses.map(course => course.course === "ECO elective" ? "Economics elective (200 level or higher)" : course.course)), displayed.courses),
    terms: difference(selectedPlan.terms.map(term => `${term.academicYear || ""}|${term.termKey || ""}`), displayed.terms),
    status: { missing: displayed.pageText.includes(studentReadiness) ? [] : [backendReadiness], extra: [] },
    conditions: difference(expectedConditions, displayed.conditions.filter(value => expectedConditions.includes(value))),
    details: difference(expectedDetails, displayed.details.filter(value => expectedDetails.includes(value))),
    evidence: { missing: (selectedPlan.planNotes || []).filter(note => note.id !== "history").flatMap(note => [
      note.description, note.caveat,
      ...note.items.flatMap(item => item.lines || [item.text])
    ]).filter(Boolean).map(value => value.replace(/\*\*/g, "")).filter(value =>
      !displayed.evidence.replace(/\s+/g, "").includes(value.replace(/\s+/g, ""))), extra: [] }
  };
  expect(displayed.details.filter(value => !expectedDetails.includes(value))).toEqual([]);
  parity.materialMissingCount = Object.values(parity)
    .filter(value => value && Array.isArray(value.missing))
    .reduce((sum, value) => sum + value.missing.length, 0);
  parity.materialExtraCount = Object.values(parity)
    .filter(value => value && Array.isArray(value.extra))
    .reduce((sum, value) => sum + value.extra.length, 0);
  await testInfo.attach("econplanner-api-ui-parity.json", {
    body: Buffer.from(JSON.stringify(parity, null, 2)),
    contentType: "application/json"
  });
  expect(parity.materialMissingCount, JSON.stringify(parity)).toBe(0);
  expect(parity.materialExtraCount, JSON.stringify(parity)).toBe(0);
});

test("readiness, conditions, and advisor actions are projected from the returned plan", async ({ page }, testInfo) => {
  const scenarios = [
    {
      name: "conditional",
      plan: fixturePlan({
        readinessStatus: "READY_WITH_CONDITIONS",
        planDisposition: "COMPLETE_READY_WITH_CONDITIONS",
        conditions: [
          { code: "CURRENT_COURSE_COMPLETION", message: "Confirm successful completion of ECO 214." },
          { code: "FINAL_SCHEDULE_CHECK", message: "Confirm the published schedule when it is released." }
        ]
      }),
      expectedStatus: "Needs confirmation",
      expectedSelector: "[data-plan-conditions]"
    },
    {
      name: "advisor",
      plan: fixturePlan({
        readinessStatus: "ADVISOR_ACTION_REQUIRED",
        planDisposition: "COMPLETE_ADVISOR_ACTION_REQUIRED",
        advisorActions: [
          { code: "INSTRUCTOR_APPROVAL", message: "Ask the instructor to confirm concurrent enrollment." },
          { code: "ADVISOR_REVIEW", message: "Review the final course sequence with your advisor." }
        ]
      }),
      expectedStatus: "Needs advisor attention",
      expectedSelector: "[data-plan-conditions]"
    }
  ];
  const parity = [];

  for (const scenario of scenarios) {
    await page.unroute("**/api/majors/map").catch(() => {});
    await openFixtureResult(page, plannerResultFixture({ plans: [scenario.plan] }));

    const returnedItems = scenario.plan.conditions.length
      ? scenario.plan.conditions.map(item => item.message)
      : scenario.plan.advisorActions.map(item => item.message);
    const card = await visitPlan(page, scenario.plan.id);
    await card.getByText("Things to keep in mind", { exact: true }).click();
    for (const message of returnedItems) {
      await expect(card.locator(scenario.expectedSelector).getByText(message, { exact: true })).toBeVisible();
    }
    const displayedItems = await card.locator(`${scenario.expectedSelector} li`).allInnerTexts();
    const displayedStatus = await page.locator(".result-status-value").innerText();
    const result = {
      scenario: scenario.name,
      backendReadinessStatus: scenario.plan.readinessStatus,
      backendPlanDisposition: scenario.plan.planDisposition,
      expectedStatus: scenario.expectedStatus,
      displayedStatus,
      items: difference(returnedItems, displayedItems)
    };
    parity.push(result);
    expect(displayedStatus).toBe(scenario.expectedStatus);
    expect(result.items.missing, JSON.stringify(result)).toEqual([]);
    expect(result.items.extra, JSON.stringify(result)).toEqual([]);
  }

  await testInfo.attach("econplanner-result-readiness-parity.json", {
    body: Buffer.from(JSON.stringify(parity, null, 2)),
    contentType: "application/json"
  });
});
