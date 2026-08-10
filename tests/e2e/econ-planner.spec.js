import { expect, test } from "./nightly-observability.js";
import {
  chooseStanding,
  continueToCourses,
  courseStatusGroup,
  fixturePlan,
  fulfillPlanner,
  generatePlans,
  infeasibleFixture,
  inputBlockedFixture,
  openFixtureResult,
  plannerResultFixture,
  resetPlanner,
  searchIncompleteFixture,
  setCourseStatus
} from "./cp7-helpers.js";

const UI_STORAGE_KEY = "econ-planner-ui-state";

async function reviewBalanced(page) {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await continueToCourses(page);
  await generatePlans(page);
  await page.getByRole("button", { name: "Review selected Balanced" }).click();
  await expect(page.getByRole("heading", { name: "Review Balanced" })).toBeVisible();
}

test("Freshman and Sophomore can toggle One Year Early while Junior and Senior cannot", async ({ page }) => {
  await resetPlanner(page);

  for (const standing of ["freshman", "sophomore"]) {
    await chooseStanding(page, standing);
    const early = page.getByRole("button", { name: "Include a one-year-early plan" });
    await expect(early).toBeVisible();
    await expect(early).toHaveAttribute("aria-pressed", "false");
    await early.click();
    await expect(early).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".cp7-summary")).toContainText("One-year-early target");
    await early.click();
    await expect(early).toHaveAttribute("aria-pressed", "false");
  }

  for (const standing of ["junior", "senior"]) {
    await chooseStanding(page, standing);
    await expect(page.getByRole("button", { name: "Include a one-year-early plan" })).toHaveCount(0);
    await expect(page.locator(".cp7-summary")).not.toContainText("One-year-early target");
  }

  const selectedStanding = page.getByRole("group", { name: "Class standing" }).locator("[aria-pressed='true']");
  await expect(selectedStanding).toHaveCount(1);
  await expect(selectedStanding).toHaveText(/Senior/);
});

test("the standard target is shared by the standing feedback and live summary", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "sophomore");

  const feedback = await page.locator(".standing-feedback strong").innerText();
  const summaryTarget = await page.locator(".cp7-summary .summary-details > div")
    .filter({ hasText: "Standard graduation target" })
    .locator("dd")
    .innerText();

  expect(feedback).toBe(summaryTarget);
  expect(summaryTarget).toMatch(/^Spring\/May \d{4}$/);
  await expect(page.getByText(/Are you a transfer student/i)).toHaveCount(0);
});

for (const standing of ["junior", "senior"]) {
  const standingLabel = standing === "junior" ? "Junior" : "Senior";

  test(`saved ${standingLabel} One Year Early state migrates to Standard with a temporary explanation`, async ({ page }) => {
    const explanation = "One Year Early is now available only for freshmen and sophomores. We kept your saved answers and changed this plan to the standard graduation timeline.";
    await page.addInitScript(({ storageKey, savedStanding }) => {
      localStorage.setItem(storageKey, JSON.stringify({
        schemaVersion: 5,
        formData: {
          displayName: "Fictional Migration Student",
          academicStanding: savedStanding,
          planningPace: "one_year_early",
          planCreationDate: "2026-08-09",
          planCreationDateEdited: true,
          isTransferStudent: false,
          transferExpectedGraduationYear: "",
          transferEntryAcademicYear: "",
          expectedGraduationTerm: "",
          reservedCourseUnits: {},
          courses: [{
            id: "ECO 113",
            code: "ECO 113",
            title: "Principles of Microeconomics",
            status: "completed",
            units: "1",
            grade: "",
            source: "manual_code",
            notes: ""
          }],
          advisorApprovals: ""
        },
        courseSearch: ""
      }));
    }, { storageKey: UI_STORAGE_KEY, savedStanding: standing });
    await page.goto("/?layout=apple");

    await expect(page.locator(".summary-attention")).toContainText(explanation);
    await expect(page.locator(".cp7-summary")).toContainText(standingLabel);
    await expect(page.locator(".cp7-summary")).toContainText("ECO 113");
    await expect(page.getByRole("button", { name: "Include a one-year-early plan" })).toHaveCount(0);
    await expect.poll(() => page.evaluate(storageKey => {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      return {
        academicStanding: saved.formData.academicStanding,
        planningPace: saved.formData.planningPace,
        completedCourse: saved.formData.courses.find(course => course.code === "ECO 113")?.status
      };
    }, UI_STORAGE_KEY)).toEqual({
      academicStanding: standing,
      planningPace: "standard",
      completedCourse: "completed"
    });

    await chooseStanding(page, "sophomore");
    await expect(page.getByText(explanation, { exact: true })).toHaveCount(0);
  });
}

test("the custom timeline asks only for required fields and maps them to the existing request", async ({ page }) => {
  let postedStudent;
  await page.route("**/api/majors/map", async route => {
    postedStudent = route.request().postDataJSON()?.student;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(plannerResultFixture())
    });
  });
  await resetPlanner(page);
  await chooseStanding(page, "sophomore");
  await page.getByRole("button", { name: "My graduation timeline is different" }).click();

  const graduation = page.getByLabel("When do you expect to graduate?");
  const entry = page.getByLabel("When did you first enroll at Hanover?");
  await expect(graduation).toBeVisible();
  await expect(entry).toBeVisible();
  await expect(page.getByText(/Are you a transfer student/i)).toHaveCount(0);

  await page.getByRole("button", { name: "Continue to your courses" }).click();
  await expect(graduation).toBeFocused();
  await graduation.selectOption({ index: 1 });
  await page.getByRole("button", { name: "Continue to your courses" }).click();
  await expect(entry).toBeFocused();
  await entry.selectOption({ index: 1 });
  const expectedGraduationYear = await graduation.inputValue();
  const expectedEntryYear = await entry.inputValue();
  await expect(page.locator(".custom-target")).toContainText(`Spring/May ${expectedGraduationYear}`);

  await continueToCourses(page);
  await generatePlans(page);
  expect(postedStudent).toMatchObject({
    academicStanding: "sophomore",
    isTransferStudent: true,
    transferExpectedGraduationYear: expectedGraduationYear,
    transferEntryAcademicYear: expectedEntryYear
  });
});

test("course statuses are single-select, clear on a second click, and update the summary by code", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await continueToCourses(page);

  const group = courseStatusGroup(page, "ECO 113");
  const completed = group.getByRole("button", { name: "Completed" });
  const takingNow = group.getByRole("button", { name: "Taking now" });
  await completed.click();
  await expect(completed).toHaveAttribute("aria-pressed", "true");
  await expect(takingNow).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".cp7-summary")).toContainText("ECO 113");

  await takingNow.click();
  await expect(completed).toHaveAttribute("aria-pressed", "false");
  await expect(takingNow).toHaveAttribute("aria-pressed", "true");
  await expect(group.locator("[aria-pressed='true']")).toHaveCount(1);
  await takingNow.click();
  await expect(group.locator("[aria-pressed='true']")).toHaveCount(0);
  await expect(page.locator(".cp7-summary .summary-details > div").filter({ hasText: "Taking now" })).toContainText("None selected");
});

test("completion sources appear only after Completed and AP is offered only for eligible courses", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await continueToCourses(page);

  const eco113 = page.locator("#course-eco-113");
  await expect(eco113.locator(".completion-source")).toHaveCount(0);
  await setCourseStatus(page, "ECO 113", "Completed");
  await eco113.locator(".completion-source summary").click();
  await expect(eco113.getByRole("button", { name: "AP or exam credit" })).toBeVisible();

  const eco213 = page.locator("#course-eco-213");
  await setCourseStatus(page, "ECO 213", "Completed");
  await eco213.locator(".completion-source summary").click();
  await expect(eco213.getByRole("button", { name: "AP or exam credit" })).toHaveCount(0);
  const transfer = eco213.getByRole("button", { name: "Another college / transfer credit" });
  await transfer.click();
  await expect(transfer).toHaveAttribute("aria-pressed", "true");
  await expect(eco213).toContainText("review-required");
  await expect.poll(async () => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("econ-planner-ui-state"));
    const course = saved.formData.courses.find(item => item.code === "ECO 213");
    return { status: course.status, source: course.source };
  })).toEqual({ status: "transfer", source: "transfer_equivalency_unapproved" });
});

test("ECO 213 and ECO 214 show canonical inline prerequisite follow-ups", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await continueToCourses(page);

  await setCourseStatus(page, "ECO 213", "Taking now");
  const eco213 = page.locator("#course-eco-213 .inline-prerequisite");
  await expect(eco213).toBeVisible();
  await expect(eco213).not.toHaveClass(/has-conflict/);
  await expect(eco213).toContainText("Before we can use ECO 213");
  await expect(courseStatusGroup(page, "ECO 113", "Status for prerequisite")).toBeVisible();
  await expect(courseStatusGroup(page, "MAT 113", "Status for prerequisite")).toBeVisible();
  await expect(courseStatusGroup(page, "MAT 121", "Status for prerequisite")).toBeVisible();

  await setCourseStatus(page, "ECO 213", "Taking now");
  await setCourseStatus(page, "ECO 214", "Taking now");
  const eco214 = page.locator("#course-eco-214 .inline-prerequisite");
  await expect(eco214).toBeVisible();
  await expect(eco214).toContainText("Before we can use ECO 214");
  await expect(courseStatusGroup(page, "ECO 114", "Status for prerequisite")).toBeVisible();
  await expect(eco214).not.toContainText("concurrency exception");
});

test("a prerequisite conflict preserves both choices and Generate focuses the dependent course", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await continueToCourses(page);

  await setCourseStatus(page, "ECO 213", "Taking now");
  await setCourseStatus(page, "MAT 113", "Completed", "Status for prerequisite");
  await setCourseStatus(page, "ECO 113", "Not taken / not sure", "Status for prerequisite");

  const dependent = courseStatusGroup(page, "ECO 213").getByRole("button", { name: "Taking now" });
  const prerequisite = courseStatusGroup(page, "ECO 113", "Status for prerequisite")
    .getByRole("button", { name: "Not taken / not sure" });
  await expect(dependent).toHaveAttribute("aria-pressed", "true");
  await expect(prerequisite).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#course-eco-213 .inline-prerequisite")).toHaveClass(/has-conflict/);
  await expect(page.locator("#course-eco-213 .prerequisite-conflict")).toContainText("Update one of these course statuses");

  await page.getByRole("button", { name: "Generate my plans" }).click();
  await expect(page.locator("#course-eco-213")).toBeFocused();
  await expect(dependent).toHaveAttribute("aria-pressed", "true");
  await expect(prerequisite).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".cp7-summary")).toContainText("Correct the highlighted prerequisite issues");
});

test("ordinary results show backend readiness and hide diagnostics by default", async ({ page }) => {
  const fixture = plannerResultFixture({
    candidateOutcomes: [{ id: "balanced", label: "Balanced", status: "VERIFIED_FEASIBLE", displayed: true }]
  });
  await openFixtureResult(page, fixture);

  await expect(page.locator(".result-status-value")).toHaveText("Ready");
  const diagnostics = page.locator("details.result-diagnostics");
  await expect(diagnostics).not.toHaveAttribute("open", "");
  await expect(diagnostics.getByText("Plan candidate results")).not.toBeVisible();
  await diagnostics.locator("summary").click();
  await expect(diagnostics.getByText("Plan candidate results")).toBeVisible();
});

test("structured INPUT_BLOCKED asks for the missing detail and preserves a return path", async ({ page }) => {
  await openFixtureResult(page, inputBlockedFixture(), 422);

  await expect(page.locator(".result-status-value")).toHaveText("Needs one more detail");
  await expect(page.locator(".no-plan-state")).toContainText("We need one more detail before we can build your plan.");
  await expect(page.locator(".no-plan-state")).toContainText("When do you expect to graduate?");
  await expect(page.locator(".no-plan-state")).not.toContainText("No plan exists");
  await page.getByRole("button", { name: "Review my answers" }).click();
  await expect(page.getByRole("heading", { name: /Where are you in your degree\?|Which courses have you finished or are taking now\?/ })).toBeVisible();
  await expect(page.getByRole("group", { name: "Class standing" }).getByRole("button", { name: "Freshman" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".cp7-summary")).toContainText("Freshman");
  await expect(page.locator(".no-plan-state")).toHaveCount(0);
});

test("SEARCH_INCOMPLETE and INFEASIBLE_PROVEN remain visibly distinct", async ({ page }) => {
  await openFixtureResult(page, searchIncompleteFixture());
  await expect(page.locator(".no-plan-state")).toContainText("We could not finish checking every possible plan.");
  await expect(page.locator(".no-plan-state")).toContainText("This does not mean a plan is impossible.");

  await page.unroute("**/api/majors/map");
  await openFixtureResult(page, infeasibleFixture());
  await expect(page.locator(".no-plan-state")).toContainText("No complete plan fits this graduation target under the current requirements and course timing.");
  await expect(page.locator(".no-plan-state")).toContainText("Review your graduation timeline");
});

test("a freshman receives the Balanced and Explore the Major normal comparisons", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await continueToCourses(page);
  await generatePlans(page);

  await expect(page.locator('article[data-plan-id="balanced"]')).toBeVisible();
  await expect(page.locator('article[data-plan-id="explore-first"]')).toBeVisible();
  await expect(page.locator('article[data-plan-id="one-year-early"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Choose Explore the Major" }).click();
  await expect(page.getByRole("heading", { name: "Review Explore the Major" })).toBeVisible();
  await expect(page.locator(".plan-course-availability")).not.toHaveCount(0);
  await expect(page.locator(".plan-course-availability").first()).toHaveText(/(?:OPEN|FULL|Status unavailable)/);

  const availability = page.locator("details.schedule-availability");
  await expect(availability).toBeVisible();
  await availability.locator("summary").click();
  await expect(availability).toContainText("ECO 113-A: ✓ OPEN");
  await expect(availability).toContainText("as of August 8, 2026");
});

test("CP5 displays distinct Balanced, Explore the Major, and One Year Early plans", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  const early = page.getByRole("button", { name: "Include a one-year-early plan" });
  await early.click();
  await continueToCourses(page);
  const response = await generatePlans(page);
  const payload = await response.json();
  const economics = payload.programs.find(result => result.program?.id === "economics-base");

  await expect(page.locator('article[data-plan-id="balanced"]')).toBeVisible();
  await expect(page.locator('article[data-plan-id="explore-first"]')).toBeVisible();
  await expect(page.locator('article[data-plan-id="one-year-early"]')).toBeVisible();
  await expect(page.locator("article[data-plan-id]")).toHaveCount(3);
  const diagnostics = page.locator("details.result-diagnostics");
  await expect(diagnostics.getByText("One Year Early:", { exact: true })).not.toBeVisible();
  await diagnostics.locator("summary").click();
  await expect(diagnostics.getByText("One Year Early:", { exact: true })).toBeVisible();

  const displayedSchedules = await page.locator("article[data-plan-id] .compact-schedule tbody")
    .evaluateAll(tables => tables.map(table => table.innerText));
  expect(new Set(displayedSchedules).size).toBe(3);
  expect(economics.economicsPlans).toHaveLength(3);
  expect(new Set(economics.economicsPlans.map(plan => JSON.stringify(plan.terms))).size).toBe(3);
  expect(economics.economicsCandidateOutcomes).toHaveLength(3);
  expect(economics.economicsCandidateOutcomes.every(outcome => outcome.candidatePool?.complete === false)).toBe(true);
});

test("PDF download recovers cleanly after failed and aborted requests", async ({ page }) => {
  await reviewBalanced(page);

  const download = page.getByRole("button", { name: "Download PDF" });
  await page.route("**/api/reports/economics", route => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "PDF creation is temporarily unavailable." })
  }));
  await download.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".pdf-download-status")).toContainText("temporarily unavailable");
  await expect(download).toBeFocused();
  await page.unroute("**/api/reports/economics");

  await page.route("**/api/reports/economics", route => route.abort("aborted"));
  const abortedRequest = page.waitForEvent("requestfailed", request => request.url().endsWith("/api/reports/economics"));
  await download.click();
  await abortedRequest;
  await expect(page.locator(".pdf-download-status")).toContainText(/interrupted|could not connect/i);
  await expect(page.locator(".pdf-download-status")).not.toContainText(/failed to fetch|aborterror/i);
  await expect(download).toBeFocused();
  await page.unroute("**/api/reports/economics");
});

test("a structurally malformed successful planner response is rejected before storage", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await continueToCourses(page);
  await fulfillPlanner(page, { programs: [] });

  await page.getByRole("button", { name: "Generate my plans" }).click();
  await expect(page.getByRole("heading", { name: "Which courses have you finished or are taking now?" })).toBeVisible();
  await expect(page.locator(".cp7-summary .summary-status")).toContainText("invalid response");
  await expect(page.locator("main.comparison-page")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem("econ-planner-generated-session"))).toBeNull();
});

test("backend conditions and advisor actions retain their student-facing distinction", async ({ page }) => {
  const conditional = fixturePlan({
    readinessStatus: "READY_WITH_CONDITIONS",
    planDisposition: "COMPLETE_READY_WITH_CONDITIONS",
    conditions: [{ code: "CONFIRM_COURSE", message: "Confirm successful completion of the current course." }]
  });
  await openFixtureResult(page, plannerResultFixture({ plans: [conditional] }));
  await expect(page.locator(".result-status-value")).toHaveText("Ready with conditions");
  await expect(page.locator(".plan-conditions")).toContainText("Confirm successful completion of the current course.");

  await page.unroute("**/api/majors/map");
  const advisor = fixturePlan({
    readinessStatus: "ADVISOR_ACTION_REQUIRED",
    planDisposition: "COMPLETE_ADVISOR_ACTION_REQUIRED",
    advisorActions: [{ code: "ADVISOR_APPROVAL", message: "Meet with your advisor to confirm this approval." }]
  });
  await openFixtureResult(page, plannerResultFixture({ plans: [advisor] }));
  await expect(page.locator(".result-status-value")).toHaveText("Needs advisor attention");
  await expect(page.locator(".plan-advisor-actions")).toContainText("Meet with your advisor to confirm this approval.");
});
