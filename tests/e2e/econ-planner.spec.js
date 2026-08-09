import { expect, test } from "./nightly-observability.js";

const UI_STORAGE_KEY = "econ-planner-ui-state";

async function resetPlanner(page) {
  await page.goto("/?layout=apple");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Build your economics course plan" })).toBeVisible();
}

async function seedFreshman(page, planningPace = "standard") {
  await page.evaluate(({ storageKey, pace }) => {
    window.localStorage.setItem(storageKey, JSON.stringify({
      schemaVersion: 6,
      formData: {
        displayName: "Strategy Test Student",
        academicStanding: "freshman",
        planningPace: pace,
        projectedSeniorStandingConfirmation: null,
        planCreationDate: "2026-07-30",
        planCreationDateEdited: true,
        isTransferStudent: false,
        transferExpectedGraduationYear: "",
        transferEntryAcademicYear: "",
        expectedGraduationTerm: "",
        reservedCourseUnits: {},
        courses: [],
        advisorApprovals: ""
      },
      courseSearch: ""
    }));
  }, { storageKey: UI_STORAGE_KEY, pace: planningPace });
  await page.reload();
}

async function generate(page) {
  const responsePromise = page.waitForResponse(response => (
    response.url().endsWith("/api/majors/map")
      && response.request().method() === "POST"
      && response.request().postDataJSON()?.action !== "validate-plan"
  ));
  await page.getByRole("button", { name: /Generate my plans/ }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(page.getByRole("heading", { name: /Compare your plans|Your feasible plan/ })).toBeVisible();
  return response.json();
}

async function reviewBalanced(page) {
  await resetPlanner(page);
  await seedFreshman(page);
  await generate(page);
  await page.getByRole("button", { name: "Review selected Balanced" }).click();
  await expect(page.getByRole("heading", { name: "Review Balanced" })).toBeVisible();
}

test("a freshman receives the Balanced and Explore the Major normal comparisons", async ({ page }) => {
  await resetPlanner(page);
  await seedFreshman(page);
  await generate(page);

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
  await seedFreshman(page, "one_year_early");
  const payload = await generate(page);
  const economics = payload.programs.find(result => result.program?.id === "economics-base");

  await expect(page.locator('article[data-plan-id="balanced"]')).toBeVisible();
  await expect(page.locator('article[data-plan-id="explore-first"]')).toBeVisible();
  await expect(page.locator('article[data-plan-id="one-year-early"]')).toBeVisible();
  await expect(page.getByText("One Year Early:", { exact: true })).toBeVisible();
  await expect(page.locator("article[data-plan-id]" )).toHaveCount(3);

  const displayedSchedules = await page.locator("article[data-plan-id] .compact-schedule tbody")
    .evaluateAll(tables => tables.map(table => table.innerText));
  expect(new Set(displayedSchedules).size).toBe(3);
  expect(economics.economicsPlans).toHaveLength(3);
  expect(new Set(economics.economicsPlans.map(plan => JSON.stringify(plan.terms))).size).toBe(3);
  expect(economics.economicsCandidateOutcomes).toHaveLength(3);
  expect(economics.economicsCandidateOutcomes.every(outcome => (
    outcome.candidatePool?.complete === false
  ))).toBe(true);
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
  await seedFreshman(page);
  await page.route("**/api/majors/map", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ programs: [] })
  }));

  await page.getByRole("button", { name: /Generate my plans/ }).click();
  await expect(page.getByRole("heading", { name: "Build your economics course plan" })).toBeVisible();
  await expect(page.locator(".generate-card .status")).toContainText("invalid response");
  await expect(page.locator("main.comparison-page")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.sessionStorage.getItem("econ-planner-generated-session"))).toBeNull();
});
