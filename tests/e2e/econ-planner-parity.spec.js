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
    READY_WITH_CONDITIONS: "Ready with conditions",
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
  await expect(page.getByRole("heading", { name: /Compare your course plans|Your feasible plan/ })).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: new RegExp(`Review this plan: ${selectedPlan.label}`) }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`Review ${selectedPlan.label}`) })).toBeVisible();

  const displayed = await page.evaluate(() => ({
    courses: [...document.querySelectorAll(".term-card .plan-course-summary > strong")].map(item => item.textContent.trim()),
    terms: [...document.querySelectorAll(".term-card")].map(item => `${item.dataset.academicYear}|${item.dataset.termKey}`),
    conditions: [...document.querySelectorAll("[data-plan-conditions] li")].map(item => item.textContent.trim()),
    details: [...document.querySelectorAll(".plan-section details.plan-notes li")].map(item => item.textContent.trim()),
    evidence: document.querySelector("[data-plan-notes]")?.textContent || "",
    pageText: document.body.innerText
  }));
  const expectedConditions = selectedPlan.planConditions.map(item => item.message);
  const expectedDetails = selectedPlan.planningDetailMessages || [];
  const backendReadiness = selectedPlan.readinessStatus || selectedPlan.validation?.readinessStatus;
  const studentReadiness = readinessLabel(backendReadiness);
  const evidenceText = (selectedPlan.planNotes || []).flatMap(note => [
    note.description, note.caveat,
    ...note.items.flatMap(item => item.lines || [item.text])
  ]).filter(Boolean).map(text => text.replace(/\*\*/g, ""));
  const parity = {
    schemaVersion: 2,
    kind: "econplanner-api-ui-parity",
    planId: selectedPlan.id,
    courses: difference(selectedPlan.terms.flatMap(term => term.courses.map(course => course.course === "ECO elective" ? "ECO elective (200+)" : course.course)), displayed.courses),
    terms: difference(selectedPlan.terms.map(term => `${term.academicYear || ""}|${term.termKey || ""}`), displayed.terms),
    status: { missing: displayed.pageText.includes(studentReadiness) ? [] : [backendReadiness], extra: [] },
    conditions: difference(expectedConditions, displayed.conditions.filter(value => expectedConditions.includes(value))),
    details: difference(expectedDetails, displayed.details.filter(value => expectedDetails.includes(value))),
    evidence: { missing: evidenceText.filter(value => !displayed.evidence.replace(/\s+/g, "").includes(value.replace(/\s+/g, ""))), extra: [] }
  };
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
      expectedStatus: "Ready with conditions",
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
    const displayedItems = await page.locator(`${scenario.expectedSelector} li`).allInnerTexts();
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
