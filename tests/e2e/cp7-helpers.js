import { expect } from "@playwright/test";

export const PLANNER_URL = "/?layout=apple";

export async function resetPlanner(page) {
  await page.goto(PLANNER_URL);
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Where are you in your degree?" })).toBeVisible();
}

export async function chooseStanding(page, standing) {
  const label = standing[0].toUpperCase() + standing.slice(1);
  const button = page.getByRole("group", { name: "Class standing" })
    .getByRole("button", { name: label });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  return button;
}

export async function continueToCourses(page) {
  await page.getByRole("button", { name: "Continue to your courses" }).click();
  await expect(page.getByRole("heading", { name: "Which courses have you finished or are taking now?" })).toBeVisible();
}

export function courseStatusGroup(page, code, prefix = "Status for") {
  return page.getByRole("group", { name: `${prefix} ${code}` });
}

export async function setCourseStatus(page, code, status, prefix = "Status for") {
  const button = courseStatusGroup(page, code, prefix).getByRole("button", { name: status });
  await button.click();
  return button;
}

export async function generatePlans(page, expectedStatus = 200) {
  const responsePromise = page.waitForResponse(response => (
    response.url().endsWith("/api/majors/map")
      && response.request().method() === "POST"
      && response.request().postDataJSON()?.action !== "validate-plan"
  ));
  await page.getByRole("button", { name: "Generate my plans" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(expectedStatus);
  return response;
}

export function fixturePlan({
  id = "balanced",
  label = "Balanced",
  readinessStatus = "STUDENT_READY",
  planDisposition = "COMPLETE_STUDENT_READY",
  conditions = [],
  advisorActions = []
} = {}) {
  return {
    id,
    label,
    description: `${label} fictional browser-test schedule.`,
    academicYear: "2026-2027",
    planningMode: "normal",
    readinessStatus,
    planDisposition,
    conditions,
    advisorActions,
    terms: [
      {
        slotId: "2026-FALL",
        academicYear: "2026-2027",
        termKey: "Fall",
        term: "Fall 2026",
        displayTerm: "Fall 2026",
        courses: [{ course: "ECO 113", title: "Principles of Microeconomics" }]
      },
      {
        slotId: "2027-WINTER",
        academicYear: "2026-2027",
        termKey: "Winter",
        term: "Winter 2027",
        displayTerm: "Winter 2027",
        courses: [{ course: "ECO 114", title: "Principles of Macroeconomics" }]
      }
    ]
  };
}

export function plannerResultFixture({
  plans = [fixturePlan()],
  category = plans.length ? "PLANS_READY" : "NEEDS_ADVISOR_ATTENTION",
  questions = [],
  actions = [],
  evidence = null,
  planningGaps = [],
  candidateOutcomes = [],
  acceleratedResult = null
} = {}) {
  return {
    programs: [{
      program: { id: "economics-base", name: "Economics" },
      planningContext: {
        isTransferStudent: false,
        effectiveStandingLabel: "Freshman",
        standingLabel: "Freshman",
        expectedGraduationTerm: "Spring/May 2030"
      },
      economicsPlan: plans[0] || null,
      economicsPlans: plans,
      economicsPlanningGaps: planningGaps,
      economicsCandidateOutcomes: candidateOutcomes,
      economicsPlanConvergences: [],
      economicsPlanResult: { category, questions, actions, evidence },
      economicsAcceleratedResult: acceleratedResult
    }]
  };
}

export function inputBlockedFixture() {
  return {
    error: "More planning information is required.",
    code: "CUSTOM_TIMELINE_INPUT_REQUIRED",
    inputResolution: {
      questions: [{
        id: "expected-graduation",
        question: "When do you expect to graduate?"
      }]
    },
    prereqIssues: [],
    economicsPlanResult: {
      category: "INPUT_BLOCKED",
      questions: [{
        id: "expected-graduation",
        question: "When do you expect to graduate?"
      }],
      actions: [{
        id: "review-timeline",
        message: "Return to your answers and complete the graduation timeline."
      }]
    }
  };
}

export function searchIncompleteFixture() {
  return plannerResultFixture({
    plans: [],
    category: "SEARCH_INCOMPLETE",
    actions: [{
      id: "advisor-review",
      message: "Ask an advisor to help check the remaining possibilities."
    }],
    evidence: { reason: "SEARCH_INCOMPLETE" }
  });
}

export function infeasibleFixture() {
  return plannerResultFixture({
    plans: [],
    category: "INFEASIBLE_PROVEN",
    actions: [{
      id: "review-graduation-timeline",
      message: "Review your graduation timeline with an academic advisor."
    }],
    evidence: { reason: "COUNT_CAPACITY", exhaustive: true }
  });
}

export async function fulfillPlanner(page, body, status = 200) {
  await page.route("**/api/majors/map", async route => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body)
    });
  });
}

export async function openFixtureResult(page, fixture, status = 200) {
  await fulfillPlanner(page, fixture, status);
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await continueToCourses(page);
  await generatePlans(page, status);
  await expect(page.getByRole("heading", { name: /Compare your plans|Your feasible plan|Your planning result/ })).toBeVisible();
}
