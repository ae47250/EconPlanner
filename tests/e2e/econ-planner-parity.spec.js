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
  await expect(page.getByRole("heading", { name: /Compare your plans|Your feasible plan/ })).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: new RegExp(`(?:Choose|Review selected) ${selectedPlan.label}`) }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`Review ${selectedPlan.label}`) })).toBeVisible();

  const displayed = await page.evaluate(() => ({
    courses: [...document.querySelectorAll(".term-card .plan-course-summary > strong")].map(item => item.textContent.trim()),
    terms: [...document.querySelectorAll(".term-card")].map(item => `${item.dataset.academicYear}|${item.dataset.termKey}`),
    warnings: [...document.querySelectorAll(".plan-notes[role='status']:not(.planning-gaps) li")].map(item => item.textContent.trim()),
    advisorNotices: [...document.querySelectorAll(".advisor-attention-item > p")].map(item => item.textContent.trim()),
    approvals: [...document.querySelectorAll("[aria-label='Plan feasibility details'] li")].map(item => item.textContent.trim()),
    reviewItems: [...document.querySelectorAll(".planning-gaps li")].map(item => item.textContent.trim()),
    sourceLabels: [...document.querySelectorAll(".plan-source-note")].map(item => item.textContent.trim()),
    pageText: document.body.innerText
  }));
  const expectedApprovals = (selectedPlan.feasibility?.requiredApprovals || []).map(item => item.message);
  const expectedNotices = (selectedPlan.studentNotices || []).map(item => item.message);
  const expectedNoticeMessages = new Set(expectedNotices);
  const expectedReview = [...(selectedPlan.unscheduled || []), ...(economics.planningGaps || [])]
    .map(item => `${item.course ? `${item.course}: ` : ""}${item.reason || item.message}`);
  const expectedSource = `Published course schedule: ${String(selectedPlan.academicYear).replace("-", "/")}. Later unpublished schedules are shown as planning projections.`;
  const backendReadiness = selectedPlan.readinessStatus || selectedPlan.validation?.readinessStatus;
  const studentReadiness = readinessLabel(backendReadiness);
  const parity = {
    schemaVersion: 2,
    kind: "econplanner-api-ui-parity",
    planId: selectedPlan.id,
    courses: difference(selectedPlan.terms.flatMap(term => term.courses.map(course => course.course)), displayed.courses),
    terms: difference(selectedPlan.terms.map(term => `${term.academicYear || ""}|${term.termKey || ""}`), displayed.terms),
    status: {
      expected: backendReadiness,
      displayed: displayed.pageText.includes(studentReadiness),
      missing: displayed.pageText.includes(studentReadiness) ? [] : [backendReadiness],
      extra: []
    },
    warnings: difference((selectedPlan.studentMessages || []).filter(message => !expectedNoticeMessages.has(message)), displayed.warnings),
    advisorNotices: difference(expectedNotices, displayed.advisorNotices.filter(value => expectedNoticeMessages.has(value))),
    approvals: difference(expectedApprovals, displayed.approvals.filter(value => expectedApprovals.includes(value))),
    reviewItems: difference(expectedReview, displayed.reviewItems),
    sourceLabels: {
      expected: 1,
      displayed: displayed.sourceLabels.length,
      missing: displayed.sourceLabels.some(value => value.includes(expectedSource)) ? [] : [expectedSource],
      extra: []
    }
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
      expectedSelector: ".plan-conditions"
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
      expectedSelector: ".plan-advisor-actions"
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
