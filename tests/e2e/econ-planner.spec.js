import { expect, test } from "@playwright/test";

async function resetPlanner(page) {
  await page.goto("/?layout=apple");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Build your economics course plan" })).toBeVisible();
}

async function setStanding(page, label) {
  const group = page.getByRole("group", { name: "Class standing" });
  const button = group.getByRole("button", { name: label });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

async function setPlanDate(page, date) {
  await page.getByLabel("Plan creation date", { exact: true }).fill(date);
}

function courseStatus(page, code, status) {
  return page
    .getByRole("group", { name: `Status for ${code}` })
    .getByRole("button", { name: status, exact: true });
}

async function generatePlans(page) {
  await page.getByRole("button", { name: /Generate my plans/ }).click();
  await expect(page.getByRole("heading", { name: "Compare your plans" })).toBeVisible({ timeout: 15000 });
}

test.beforeEach(async ({ page }) => {
  await resetPlanner(page);
});

test("standing, term, graduation, course status, and prerequisite controls stay coherent", async ({ page }) => {
  await page.getByRole("textbox", { name: "Student name (optional)" }).fill("Alex Student");

  const expectedByStanding = new Map([
    ["Freshman", "Spring/May 2030"],
    ["Sophomore", "Spring/May 2029"],
    ["Junior", "Spring/May 2028"],
    ["Senior", "Spring/May 2027"]
  ]);
  for (const [standing, expectedGraduation] of expectedByStanding) {
    await setStanding(page, standing);
    await setPlanDate(page, "2026-07-31");
    await expect(page.getByLabel("Expected graduation")).toHaveValue(expectedGraduation);
    await expect(page.getByLabel("Planning starts")).toHaveValue("Fall 2026");
  }

  await setStanding(page, "Freshman");
  await setPlanDate(page, "2026-08-23");
  await expect(page.getByRole("heading", { name: "What year will you be in this fall?" })).toBeVisible();
  await setPlanDate(page, "2026-08-24");
  await expect(page.getByRole("heading", { name: "What year are you in this academic year?" })).toBeVisible();
  await setPlanDate(page, "2026-09-01");
  await expect(page.getByLabel("Planning starts")).toHaveValue("Winter 2027");
  await setPlanDate(page, "2027-02-01");
  await expect(page.getByLabel("Planning starts")).toHaveValue("Spring/May 2027");
  await setPlanDate(page, "2027-04-15");
  await expect(page.getByLabel("Planning starts")).toHaveValue("Fall 2027");

  const completed113 = courseStatus(page, "ECO 113", "Completed");
  const progress113 = courseStatus(page, "ECO 113", "In progress");
  await completed113.click();
  await expect(completed113).toHaveAttribute("aria-pressed", "true");
  await progress113.click();
  await expect(completed113).toHaveAttribute("aria-pressed", "false");
  await expect(progress113).toHaveAttribute("aria-pressed", "true");
  await progress113.click();
  await expect(progress113).toHaveAttribute("aria-pressed", "false");

  const completed213 = courseStatus(page, "ECO 213", "Completed");
  await completed213.click();
  const prerequisiteDialog = page.getByRole("dialog", { name: "Confirm prerequisites for ECO 213" });
  await expect(prerequisiteDialog).toBeFocused();
  await expect(page.getByRole("button", { name: "Confirm Taken" })).toBeDisabled();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(completed213).toBeFocused();

  await completed213.click();
  await page.getByRole("group", { name: "Status for prerequisite ECO 113" })
    .getByRole("button", { name: "Taken", exact: true }).click();
  await page.getByRole("group", { name: "Status for prerequisite MAT 121" })
    .getByRole("button", { name: "Taken", exact: true }).click();
  await page.getByRole("button", { name: "Confirm Taken" }).click();
  await expect(completed213).toHaveAttribute("aria-pressed", "true");
  await completed113.click();
  await expect(completed213).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("status")).toContainText("ECO 213 was cleared");

  await page.getByRole("button", { name: "Clear selections" }).click();
  await expect(page.getByRole("textbox", { name: "Student name (optional)" })).toHaveValue("Alex Student");
  await expect(page.getByLabel("Plan creation date", { exact: true })).toHaveValue("2027-04-15");
  await expect(page.getByText("0 selected", { exact: true })).toBeVisible();
  await page.getByRole("searchbox").fill("ECO 333");
  await page.getByRole("searchbox").press("Enter");
  await expect(page.getByRole("heading", { name: "Build your economics course plan" })).toBeVisible();
});

test("transfer students choose graduation and Hanover entry years instead of class standing", async ({ page }) => {
  await setPlanDate(page, "2027-01-10");
  await page.getByRole("button", { name: "Are you a transfer student? Choose your graduation year instead." }).click();

  await expect(page.getByRole("heading", { name: "Transfer student planning" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Class standing" })).toHaveCount(0);
  for (const year of [2027, 2028, 2029, 2030]) {
    await expect(page.getByRole("button", { name: `Spring/May ${year}` })).toBeVisible();
  }
  await expect(page.getByLabel("Other expected graduation year")).toHaveValue("2031");

  await page.getByRole("button", { name: "Spring/May 2030" }).click();
  await page.getByLabel("When did you first enroll at Hanover?").selectOption("2025-2026");
  await expect(page.getByLabel("Expected graduation", { exact: true })).toHaveValue("Spring/May 2030");

  await setPlanDate(page, "2030-09-01");
  await expect(page.getByLabel("Expected graduation", { exact: true })).toHaveValue("To be confirmed");
  await expect(page.getByLabel("When did you first enroll at Hanover?")).toHaveValue("");
  await expect(page.locator(".transfer-validation")).toContainText("Choose an expected graduation year");

  await page.getByRole("button", { name: "Use regular class-year choices" }).click();
  await expect(page.getByRole("group", { name: "Class standing" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Transfer student planning" })).toHaveCount(0);
});

test("generation is single-flight and distinct plans support compare, history, refresh, isolated edit, and undo", async ({ page }) => {
  await page.getByRole("textbox", { name: "Student name (optional)" }).fill("Alex Student");
  await setPlanDate(page, "2026-07-31");
  await courseStatus(page, "ECO 113", "Completed").click();

  let generationRequests = 0;
  await page.route("**/api/majors/map", async route => {
    const body = route.request().postDataJSON();
    if (body?.action !== "validate-plan") {
      generationRequests += 1;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await route.continue();
  });

  const generateButton = page.getByRole("button", { name: /Generate my plans/ });
  await generateButton.dblclick();
  await expect(page.getByRole("heading", { name: "Compare your plans" })).toBeVisible({ timeout: 15000 });
  expect(generationRequests).toBe(1);

  const cards = page.locator("article[data-plan-id]");
  await expect(cards).toHaveCount(4);
  const displayedPlanIds = new Set(await cards.evaluateAll(items => items.map(item => item.dataset.planId)));
  expect(displayedPlanIds).toEqual(new Set(["plan-1", "plan-2", "plan-3", "plan-c2"]));
  const originalSchedules = Object.fromEntries(await cards.evaluateAll(items => items.map(item => [
    item.dataset.planId,
    item.querySelector("tbody")?.innerText || ""
  ])));
  expect(new Set(Object.values(originalSchedules)).size).toBe(4);

  for (const card of await cards.all()) {
    const exactRows = card.locator("tbody tr").filter({ hasNotText: "Term to be confirmed" });
    for (const row of await exactRows.allInnerTexts()) {
      expect(row.includes("ECO 213") && row.includes("ECO 214")).toBe(false);
    }
    await expect(card.getByText("ECO 461").first()).toBeVisible();
    await expect(card.getByRole("cell", { name: "Winter", exact: true }).last()).toBeVisible();
  }

  await page.getByRole("checkbox", { name: "Show differences only" }).check();
  await expect(page.getByRole("checkbox", { name: "Show differences only" })).toBeChecked();
  await page.getByRole("button", { name: /(?:Choose|Review selected) Plan B/ }).click();
  await expect(page.getByRole("heading", { name: "Review Plan B" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Plan B" })).toHaveAttribute("aria-selected", "true");

  await page.goBack();
  await expect(page.getByRole("button", { name: "Review selected Plan B" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Review Plan B" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Review Plan B" })).toBeVisible();
  await expect(page.getByText("Alex Student", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Remove ECO 114" }).click();
  await expect(page.locator(".plan-edit-status")).toContainText("updated as a draft");
  await expect(page.locator(".plan-validation-errors")).toContainText("Requirement eco-114 remains unscheduled");
  await page.reload();
  await expect(page.getByRole("button", { name: "Undo last plan edit" })).toBeVisible();
  await page.getByRole("button", { name: "Compare plans" }).click();

  const editedCards = page.locator("article[data-plan-id]");
  const editedSchedules = Object.fromEntries(await editedCards.evaluateAll(items => items.map(item => [
    item.dataset.planId,
    item.querySelector("tbody")?.innerText || ""
  ])));
  expect(editedSchedules["plan-1"]).toBe(originalSchedules["plan-1"]);
  expect(editedSchedules["plan-2"]).not.toBe(originalSchedules["plan-2"]);
  expect(editedSchedules["plan-3"]).toBe(originalSchedules["plan-3"]);
  expect(editedSchedules["plan-c2"]).toBe(originalSchedules["plan-c2"]);
  await expect(page.locator('article[data-plan-id="plan-2"] .plan-validation')).toContainText("Needs attention");

  await page.getByRole("button", { name: "Review Plan B issues" }).click();
  await page.getByRole("button", { name: "Undo last plan edit" }).click();
  await expect(page.getByRole("button", { name: "Remove ECO 114" })).toBeVisible();
  await expect(page.locator(".plan-edit-status")).toContainText("Plan B was restored");

  await page.getByRole("combobox", { name: "Move ECO 114 to another term" })
    .selectOption({ label: "2026/2027 Winter" });
  await expect(page.locator(".plan-edit-status")).toContainText("updated as a draft");
  await expect(page.locator(".plan-validation-errors")).toContainText("not verified");
  await page.getByRole("button", { name: "Undo last plan edit" }).click();

  await page.getByRole("button", { name: "Regenerate plans" }).click();
  await expect(page.getByRole("heading", { name: "Compare your plans" })).toBeVisible({ timeout: 15000 });
  expect(generationRequests).toBe(2);

  await page.getByRole("button", { name: "Back to course selection" }).click();
  await expect(page.getByRole("textbox", { name: "Student name (optional)" })).toHaveValue("Alex Student");
  await expect(courseStatus(page, "ECO 113", "Completed")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Return to generated plans" })).toBeVisible();
  await page.getByRole("button", { name: "Return to generated plans" }).click();
  await expect(page.getByRole("heading", { name: "Compare your plans" })).toBeVisible();
  await page.getByRole("button", { name: "Back to course selection" }).click();
  await setStanding(page, "Sophomore");
  await expect(page.getByRole("button", { name: "Return to generated plans" })).toHaveCount(0);
});

test("missing information and generation failures stay visible without losing inputs", async ({ page }) => {
  await page.goto("/?layout=apple&view=plan&plan=plan-2");
  await expect(page.getByRole("heading", { name: "Build your economics course plan" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("no longer available");
  await expect(page).not.toHaveURL(/view=plan/);

  const generateButton = page.getByRole("button", { name: /Generate my plans/ });
  await page.getByLabel("Plan creation date", { exact: true }).fill("");
  await expect(generateButton).toBeDisabled();

  await setPlanDate(page, "2026-07-31");
  await expect(generateButton).toBeEnabled();
  await setPlanDate(page, "2025-09-01");
  await courseStatus(page, "ECO 113", "Completed").click();
  await page.route("**/api/majors/map", route => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "Planner service is temporarily unavailable." })
  }));

  await generateButton.click();
  await expect(page.getByRole("status")).toContainText("Planner service is temporarily unavailable.");
  await expect(generateButton).toBeEnabled();
  await expect(courseStatus(page, "ECO 113", "Completed")).toHaveAttribute("aria-pressed", "true");
});

test("graduation-first senior workflow shows one highest-ranked realistic plan and advisor warnings", async ({ page }) => {
  await setStanding(page, "Senior");
  await setPlanDate(page, "2026-07-30", "yes");
  for (const code of ["ECO 113", "ECO 114"]) {
    await courseStatus(page, code, "Completed").click();
  }
  await courseStatus(page, "MAT 113 / MAT 121", "Completed").click();
  await page.locator(".choice-option").filter({ hasText: "MAT 113" }).click();
  await courseStatus(page, "ECO 214", "Completed").click();

  await page.getByRole("button", { name: /Generate my plans/ }).click();
  await expect(page.getByRole("heading", { name: "Your feasible plan" })).toBeVisible({ timeout: 15000 });
  const cards = page.locator("article[data-plan-id]");
  await expect(cards).toHaveCount(1);
  await expect(page.getByText(/more than two Economics courses/).first()).toBeVisible();
  await expect(page.getByText(/Schedule confirmation required/).first()).toBeVisible();
  for (const card of await cards.all()) {
    await expect(card.getByText("MAT 217")).toBeVisible();
    await expect(card.getByText("ECO 213")).toBeVisible();
    await expect(card.getByText("ECO 461")).toBeVisible();
    await expect(card.getByText("ECO 321")).toBeVisible();
    await expect(card.getByText("ECO 234")).toBeVisible();
    await expect(card.getByText("ECO 333")).toBeVisible();
    await expect(card.getByText("ECO 221")).toBeVisible();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("selected elective options persist through server validation and PDF errors stay student friendly", async ({ page }) => {
  await setStanding(page, "Senior");
  await setPlanDate(page, "2026-07-30");
  for (const code of ["ECO 113", "ECO 114"]) {
    await courseStatus(page, code, "Completed").click();
  }
  await courseStatus(page, "MAT 113 / MAT 121", "Completed").click();
  await page.locator(".choice-option").filter({ hasText: "MAT 113" }).click();
  await courseStatus(page, "ECO 214", "Completed").click();

  await page.getByRole("button", { name: /Generate my plans/ }).click();
  await expect(page.getByRole("heading", { name: "Your feasible plan" })).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: /Review selected Plan/ }).click();
  await expect(page.getByText("Plan verification and conditions", { exact: true })).toBeVisible();

  const elective = page.getByRole("combobox", { name: /Choose elective for/ });
  await expect(elective).toBeVisible();
  const options = await elective.locator("option").evaluateAll(items => items.map(item => ({ value: item.value, text: item.textContent })));
  expect(options.length).toBeGreaterThan(1);
  const initial = await elective.inputValue();
  const alternative = options.find(option => option.value !== initial);
  await elective.selectOption(alternative.value);
  await expect(page.locator(".plan-edit-status")).toContainText("updated and remains valid");
  await expect(elective).toHaveValue(alternative.value);

  await page.reload();
  await expect(page.getByRole("combobox", { name: /Choose elective for/ })).toHaveValue(alternative.value);
  await page.getByRole("button", { name: "Download PDF" }).click();
  await expect(page.locator(".pdf-download-status")).toContainText("PDF downloads are not enabled", { timeout: 15000 });
});

test("mobile principal workflow keeps controls and prerequisite dialog inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setPlanDate(page, "2026-07-31");
  await page.getByRole("button", { name: "Are you a transfer student? Choose your graduation year instead." }).click();
  const transferCard = page.getByRole("region", { name: "Transfer student planning" });
  await expect(transferCard).toBeVisible();
  const transferCardBox = await transferCard.boundingBox();
  expect(transferCardBox.x).toBeGreaterThanOrEqual(0);
  expect(transferCardBox.x + transferCardBox.width).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Use regular class-year choices" }).click();
  const completed213 = courseStatus(page, "ECO 213", "Completed");
  await completed213.click();
  const dialog = page.getByRole("dialog", { name: "Confirm prerequisites for ECO 213" });
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Cancel" }).click();

  await courseStatus(page, "ECO 113", "Completed").click();
  await generatePlans(page);
  await expect(page.locator("article[data-plan-id]")).toHaveCount(4);
  await page.waitForTimeout(350);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Choose Plan C-2" }).click();
  await expect(page.getByRole("heading", { name: "Review Plan C-2" })).toBeVisible();
});
