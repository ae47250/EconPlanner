import { expect, test } from "./nightly-observability.js";

const OVERFLOW_VIEWPORTS = [
  { name: "original mobile", width: 390, height: 844, repetitions: 5 },
  { name: "narrow phone", width: 320, height: 700, repetitions: 3 },
  { name: "desktop", width: 1440, height: 900, repetitions: 1 }
];
const LONG_WRAP_TOKEN = "FictionalOverflowWrapProbe".repeat(32);
const LONG_STUDENT_NAME = `Alexandria${LONG_WRAP_TOKEN}`;
const LONG_PLAN_DESCRIPTION = `Fictional plan description ${LONG_WRAP_TOKEN}`;
const LONG_COURSE_TITLE = `Fictional course title ${LONG_WRAP_TOKEN}`;
const LONG_PLAN_WARNING = `Fictional plan warning ${LONG_WRAP_TOKEN}`;
const LONG_APPROVAL_MESSAGE = `Fictional approval condition ${LONG_WRAP_TOKEN}`;

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

async function selectRequirementChoice(page, code) {
  const choice = page.getByRole("checkbox", { name: new RegExp(`^${code}\\b`) });
  await choice.evaluate(element => element.click());
  await expect(choice).toBeChecked();
}

function requestBody(request) {
  try {
    return request.postDataJSON();
  } catch {
    return null;
  }
}

function isGenerationRequest(request) {
  if (!request.url().endsWith("/api/majors/map") || request.method() !== "POST") return false;
  return requestBody(request)?.action !== "validate-plan";
}

async function installLongContentResponse(page) {
  await page.route("**/api/majors/map", async route => {
    if (!isGenerationRequest(route.request())) {
      await route.continue();
      return;
    }
    const upstream = await route.fetch();
    const data = await upstream.json();
    const economics = data.programs?.find(program => program.program?.id === "economics-base");
    const firstPlan = economics.economicsPlans?.[0];
    const selectedPlan = economics.economicsPlans?.find(plan => plan.label === "Plan C");
    if (firstPlan) firstPlan.description = LONG_PLAN_DESCRIPTION;
    if (selectedPlan) {
      const firstCourse = selectedPlan.terms?.flatMap(term => term.courses || [])[0];
      if (firstCourse) firstCourse.title = LONG_COURSE_TITLE;
      selectedPlan.studentMessages = [LONG_PLAN_WARNING, ...(selectedPlan.studentMessages || [])];
      selectedPlan.feasibility = {
        ...(selectedPlan.feasibility || {}),
        requiredApprovals: [
          {
            course: "ECO 999",
            prerequisite: "Fictional prerequisite",
            term: "Fictional term",
            authority: "Fictional approval authority",
            message: LONG_APPROVAL_MESSAGE
          },
          ...(selectedPlan.feasibility?.requiredApprovals || [])
        ]
      };
    }
    await route.fulfill({ response: upstream, json: data });
  });
}

async function assertNoHorizontalOverflow(page, label) {
  const measurement = await page.evaluate(() => {
    const root = document.documentElement;
    const clientWidth = root.clientWidth;
    const describe = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        element: element.tagName.toLowerCase(),
        id: element.id,
        className: typeof element.className === "string" ? element.className : "",
        left: Math.round(rect.left * 100) / 100,
        right: Math.round(rect.right * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        computedWidth: style.width,
        minWidth: style.minWidth,
        maxWidth: style.maxWidth,
        overflowX: style.overflowX,
        overflowWrap: style.overflowWrap,
        whiteSpace: style.whiteSpace,
        position: style.position,
        transform: style.transform,
        animationName: style.animationName
      };
    };
    const offenders = [...document.body.querySelectorAll("*")]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.left < -0.5 || rect.right > clientWidth + 0.5;
      })
      .slice(0, 12)
      .map(describe);
    return {
      clientWidth,
      scrollWidth: root.scrollWidth,
      overflow: root.scrollWidth - clientWidth,
      offenders
    };
  });
  expect(
    measurement.scrollWidth,
    `${label}: ${JSON.stringify(measurement)}`
  ).toBeLessThanOrEqual(measurement.clientWidth);
}

async function assertInsideViewport(locator, label) {
  const measurement = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const parentRect = element.parentElement.getBoundingClientRect();
    return {
      viewportWidth: document.documentElement.clientWidth,
      parentWidth: parentRect.width,
      width: rect.width,
      left: rect.left,
      right: rect.right
    };
  });
  expect(measurement.left, `${label}: ${JSON.stringify(measurement)}`).toBeGreaterThanOrEqual(0);
  expect(measurement.right, `${label}: ${JSON.stringify(measurement)}`).toBeLessThanOrEqual(measurement.viewportWidth);
}

async function assertLongTextWraps(locator, label) {
  const measurement = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const parentRect = element.parentElement.getBoundingClientRect();
    const style = getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
    return {
      viewportWidth: document.documentElement.clientWidth,
      parentWidth: parentRect.width,
      width: rect.width,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      lineHeight,
      lineRects: element.getClientRects().length,
      overflowWrap: style.overflowWrap,
      whiteSpace: style.whiteSpace
    };
  });
  expect(measurement.left, `${label}: ${JSON.stringify(measurement)}`).toBeGreaterThanOrEqual(0);
  expect(measurement.right, `${label}: ${JSON.stringify(measurement)}`).toBeLessThanOrEqual(measurement.viewportWidth);
  expect(measurement.width, `${label}: ${JSON.stringify(measurement)}`).toBeLessThanOrEqual(measurement.parentWidth + 0.5);
  expect(
    measurement.lineRects > 1 || measurement.height > measurement.lineHeight * 1.5,
    `${label} should wrap across lines: ${JSON.stringify(measurement)}`
  ).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await resetPlanner(page);
});

test("intake header shows the URVESKA logo above EconPlanner without the legacy E icon", async ({ page }) => {
  const brand = page.locator(".apple-brand");
  await expect(brand.getByRole("img", { name: "URVESKA" })).toHaveAttribute(
    "src",
    "/urveska-midnight-gold-underlined.png"
  );
  await expect(brand.getByText("EconPlanner", { exact: true })).toBeVisible();
  await expect(page.locator(".apple-brand-mark")).toHaveCount(0);
});

test("planning timeline is visually and semantically grouped", async ({ page }) => {
  const timeline = page.getByRole("region", { name: "What year will you be in this fall?" });
  await expect(timeline.getByText("Planning timeline", { exact: true })).toBeVisible();
  await expect(timeline.getByRole("group", { name: "Class standing" })).toBeVisible();
  await expect(timeline.getByRole("group", {
    name: "How quickly do you want this plan to finish?"
  })).toBeVisible();
  await expect(timeline.getByText(/fourth college year/)).toBeVisible();
  await expect(timeline.getByRole("button", {
    name: "Transfer students: Change graduation year"
  })).toHaveCount(0);
  await expect(page.getByRole("button", {
    name: "Transfer students: Change graduation year"
  })).toBeVisible();

  const visualGrouping = await timeline.evaluate(element => {
    const styles = getComputedStyle(element);
    return {
      backgroundColor: styles.backgroundColor,
      borderTopStyle: styles.borderTopStyle
    };
  });
  expect(visualGrouping.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(visualGrouping.borderTopStyle).toBe("solid");

  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const responsiveLayout = await timeline.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        viewportWidth: document.documentElement.clientWidth,
        pageWidth: document.documentElement.scrollWidth
      };
    });
    expect(responsiveLayout.left, `${width}px: ${JSON.stringify(responsiveLayout)}`).toBeGreaterThanOrEqual(0);
    expect(responsiveLayout.right, `${width}px: ${JSON.stringify(responsiveLayout)}`)
      .toBeLessThanOrEqual(responsiveLayout.viewportWidth);
    expect(responsiveLayout.pageWidth, `${width}px: ${JSON.stringify(responsiveLayout)}`)
      .toBe(responsiveLayout.viewportWidth);
    const horizonFields = await page.locator(".apple-horizon-detail-pair label").evaluateAll(labels => (
      labels.map(label => {
        const bounds = label.getBoundingClientRect();
        return { top: bounds.top, left: bounds.left, right: bounds.right };
      })
    ));
    expect(horizonFields).toHaveLength(2);
    expect(Math.abs(horizonFields[0].top - horizonFields[1].top), `${width}px: horizon fields wrapped`)
      .toBeLessThan(2);
    expect(horizonFields[1].right, `${width}px: horizon fields overflowed`)
      .toBeLessThanOrEqual(responsiveLayout.viewportWidth);
  }
});

test("planned non-major courses have their own card before course selection", async ({ page }) => {
  const nonMajorCard = page.locator(".non-major-intake-card");
  const courseCard = page.locator(".course-intake-card");
  await expect(nonMajorCard).toContainText("Enter planned non-major courses (optional)");

  const cardOrder = await nonMajorCard.evaluate((card, courseSelector) => {
    const course = document.querySelector(courseSelector);
    return Boolean(card.compareDocumentPosition(course) & Node.DOCUMENT_POSITION_FOLLOWING);
  }, ".course-intake-card");
  expect(cardOrder).toBe(true);

  await nonMajorCard.locator("summary").click();
  await expect(nonMajorCard.locator('input[type="number"]').first()).toBeVisible();
  await expect(courseCard.getByRole("heading", { name: "Which courses have you taken?" })).toBeVisible();
});

test("planned non-major course entries persist and reach the planner request", async ({ page }) => {
  const nonMajorCard = page.locator(".non-major-intake-card");
  await nonMajorCard.locator("summary").click();
  const firstReservedCourseInput = nonMajorCard.getByRole("spinbutton").first();
  await firstReservedCourseInput.fill("2");

  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(window.localStorage.getItem("econ-planner-ui-state") || "null");
    return Object.values(saved?.formData?.reservedCourseUnits || {}).includes(2);
  })).toBe(true);

  const responsePromise = page.waitForResponse(response => (
    response.url().endsWith("/api/majors/map")
      && response.request().method() === "POST"
      && response.request().postDataJSON()?.action !== "validate-plan"
  ));
  await page.getByRole("button", { name: /Generate my plans/ }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(Object.values(response.request().postDataJSON().student.reservedCourseUnits)).toContain(2);
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

test("planning pace requires and resets exact senior-standing confirmation", async ({ page }) => {
  await setPlanDate(page, "2026-07-31");
  const pace = page.getByRole("group", { name: "How quickly do you want this plan to finish?" });
  await expect(pace.getByRole("button", { name: "Standard pace" })).toHaveAttribute("aria-pressed", "true");

  await pace.getByRole("button", { name: "One year early" }).click();
  const confirmation = page.getByRole("group", {
    name: "Has the Registrar or your advisor confirmed that you will have senior standing by Winter 2029?"
  });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Yes, it is confirmed" }).click();
  await expect(confirmation.getByRole("button", { name: "Yes, it is confirmed" })).toHaveAttribute("aria-pressed", "true");

  await setStanding(page, "Sophomore");
  const updatedConfirmation = page.getByRole("group", {
    name: "Has the Registrar or your advisor confirmed that you will have senior standing by Winter 2028?"
  });
  await expect(updatedConfirmation.getByRole("button", { name: "Yes, it is confirmed" })).toHaveAttribute("aria-pressed", "false");

  await updatedConfirmation.getByRole("button", { name: "Yes, it is confirmed" }).click();
  await setPlanDate(page, "2026-09-01");
  await expect(page.getByRole("group", {
    name: "Has the Registrar or your advisor confirmed that you will have senior standing by Winter 2028?"
  }).getByRole("button", { name: "Yes, it is confirmed" })).toHaveAttribute("aria-pressed", "false");

  await pace.getByRole("button", { name: "One extra year" }).click();
  await expect(page.getByText(/Has the Registrar or your advisor confirmed/)).toHaveCount(0);
  await expect(page.getByLabel("Expected graduation", { exact: true })).toHaveValue("Spring/May 2030");

  await setStanding(page, "Senior");
  await expect(pace.getByRole("button", { name: "One year early" })).toHaveCount(0);
});

test("transfer students choose graduation and Hanover entry years instead of class standing", async ({ page }) => {
  await setPlanDate(page, "2027-01-10");
  await page.getByRole("button", { name: "Transfer students: Change graduation year" }).click();

  await expect(page.getByRole("heading", { name: "Transfer student planning" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Class standing" })).toHaveCount(0);
  for (const year of [2027, 2028, 2029, 2030]) {
    await expect(page.getByRole("button", { name: `Spring/May ${year}` })).toBeVisible();
  }
  await expect(page.getByLabel("Other expected graduation year")).toHaveValue("2031");

  await page.getByRole("button", { name: "Spring/May 2027" }).click();
  await page.getByLabel("When did you first enroll at Hanover?").selectOption("2026-2027");
  const compressedConfirmation = page.getByRole("group", {
    name: "Has the Registrar or your advisor confirmed that you will have senior standing by Winter 2027?"
  });
  await expect(compressedConfirmation).toBeVisible();
  await compressedConfirmation.getByRole("button", { name: "Yes, it is confirmed" }).click();

  await page.getByRole("button", { name: "Spring/May 2030" }).click();
  await page.getByLabel("When did you first enroll at Hanover?").selectOption("2025-2026");
  await expect(page.getByText(/Has the Registrar or your advisor confirmed/)).toHaveCount(0);
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
  await expect(cards).toHaveCount(3);
  const displayedPlanIds = new Set(await cards.evaluateAll(items => items.map(item => item.dataset.planId)));
  expect(displayedPlanIds).toEqual(new Set(["plan-1", "plan-2", "plan-3"]));
  const originalSchedules = Object.fromEntries(await cards.evaluateAll(items => items.map(item => [
    item.dataset.planId,
    item.querySelector("tbody")?.innerText || ""
  ])));
  expect(new Set(Object.values(originalSchedules)).size).toBe(3);
  const displayedTermCounts = await cards.evaluateAll(items => items.map(item => item.querySelectorAll("tbody tr").length));
  expect(new Set(displayedTermCounts).size).toBe(1);
  expect(displayedTermCounts[0]).toBeGreaterThan(0);

  for (const card of await cards.all()) {
    const exactRows = card.locator("tbody tr").filter({ hasNotText: "Term to be confirmed" });
    for (const row of await exactRows.allInnerTexts()) {
      expect(row.includes("ECO 213") && row.includes("ECO 214")).toBe(false);
    }
    await expect(card.getByText("ECO 461").first()).toBeVisible();
    await expect(card.getByRole("cell", { name: "Winter", exact: true }).last()).toBeVisible();
    await expect(card.getByText("No major course assigned", { exact: true }).first()).toBeVisible();
  }

  const advisorAttention = page.locator(".advisor-attention");
  await expect(advisorAttention.getByRole("heading", { name: "Graduation planning assumptions" })).toHaveCount(1);
  await expect(advisorAttention.getByRole("heading", { name: "Published 2026/2027 schedule checks" })).toBeVisible();
  await expect(advisorAttention.getByRole("heading", { name: "Projected placement" })).toBeVisible();
  await expect(advisorAttention.getByText("Graduation planning assumption", { exact: true })).toHaveCount(0);
  await expect(advisorAttention.getByText(/ECO 213 and ECO 214 tend to be offered in different terms/)).toBeVisible();
  const projectedPlacementTerms = advisorAttention.locator(".projected-placement-list li");
  await expect(projectedPlacementTerms.first()).toBeVisible();
  const projectedTerms = await projectedPlacementTerms.evaluateAll(items => items.map(item => item.dataset.term));
  expect(new Set(projectedTerms).size).toBe(projectedTerms.length);
  for (const projectedTerm of projectedTerms) {
    expect(projectedTerm).toMatch(/^(Fall|Winter|Spring\/May|May|Summer) \d{4}$/);
  }
  const projectedTermSortKey = term => {
    const [, season, year] = term.match(/^(Fall|Winter|Spring\/May|May|Summer) (\d{4})$/);
    const seasonOrder = { Winter: 0, "Spring/May": 1, May: 1, Summer: 2, Fall: 3 };
    return Number(year) * 10 + seasonOrder[season];
  };
  expect(projectedTerms).toEqual(
    [...projectedTerms].sort((left, right) => projectedTermSortKey(left) - projectedTermSortKey(right))
  );
  const selectedCompareCard = page.locator("article.comparison-plan-card.is-selected");
  await expect(selectedCompareCard).toHaveCount(1);
  const selectedComparePlanId = await selectedCompareCard.getAttribute("data-plan-id");
  await expect(advisorAttention).toHaveAttribute("data-plan-id", selectedComparePlanId);
  await expect(advisorAttention.getByText(/Warnings shown for Plan/)).toBeVisible();
  const selectedAvailability = page.locator(".schedule-availability");
  await expect(selectedAvailability.getByText("ECO 114", { exact: false })).toHaveCount(3);
  await expect(selectedAvailability.getByText("ECO 213", { exact: false })).toHaveCount(0);
  const selectedAdvisorText = await advisorAttention.innerText();

  await page.getByRole("checkbox", { name: "Highlight differences" }).check();
  await expect(page.getByRole("checkbox", { name: "Highlight differences" })).toBeChecked();
  await expect(page.getByText(/Blue courses are shared by every plan in the same term/)).toBeVisible();
  for (const card of await cards.all()) {
    const sharedCapstone = card.locator(".comparison-shared-course").filter({ hasText: "ECO 461" });
    await expect(sharedCapstone).toHaveCount(1);
    await expect(sharedCapstone).toBeVisible();
  }
  await page.getByRole("button", { name: /(?:Choose|Review selected) Plan B/ }).click();
  await expect(page.getByRole("heading", { name: "Review Plan B" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Plan B" })).toHaveAttribute("aria-selected", "true");
  const planBAdvisorAttention = page.locator(".advisor-attention");
  await expect(planBAdvisorAttention).toHaveAttribute("data-plan-id", "plan-2");
  expect(await planBAdvisorAttention.innerText()).not.toBe(selectedAdvisorText);
  await expect(page.locator(".schedule-availability").getByText("ECO 214", { exact: false })).toHaveCount(0);

  await page.goBack();
  await expect(page.getByRole("button", { name: "Review selected Plan B" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Review Plan B" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Review Plan B" })).toBeVisible();
  await expect(page.getByText("Alex Student", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Remove ECO 114" }).click();
  await expect(page.locator(".plan-edit-status")).toContainText("That plan change cannot be saved");
  await expect(page.locator(".plan-edit-status")).toContainText(/ECO 214 is missing prerequisites: ECO 114|Requirement eco-114 remains unscheduled/);
  await expect(page.getByRole("button", { name: "Remove ECO 114" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Undo last plan edit" })).toHaveCount(0);
  await page.getByRole("button", { name: "Compare plans" }).click();

  const editedCards = page.locator("article[data-plan-id]");
  const editedSchedules = Object.fromEntries(await editedCards.evaluateAll(items => items.map(item => [
    item.dataset.planId,
    item.querySelector("tbody")?.innerText || ""
  ])));
  expect(editedSchedules["plan-1"]).toBe(originalSchedules["plan-1"]);
  expect(editedSchedules["plan-2"]).toBe(originalSchedules["plan-2"]);
  expect(editedSchedules["plan-3"]).toBe(originalSchedules["plan-3"]);

  await page.getByRole("button", { name: "Review selected Plan B" }).click();
  await expect(page.getByRole("button", { name: "Remove ECO 114" })).toBeVisible();

  await page.getByRole("combobox", { name: "Move ECO 114 to another term" })
    .selectOption({ label: "2026/2027 Winter" });
  await expect(page.locator(".plan-edit-status")).toContainText("That plan change cannot be saved");
  await expect(page.locator(".plan-edit-status")).toContainText("not verified");
  await expect(page.getByRole("combobox", { name: "Move ECO 114 to another term" })).toHaveValue("fall-2026");
  await expect(page.getByRole("button", { name: "Undo last plan edit" })).toHaveCount(0);

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
  await selectRequirementChoice(page, "MAT 113");
  await courseStatus(page, "ECO 214", "Completed").click();

  await page.getByRole("button", { name: /Generate my plans/ }).click();
  await expect(page.getByRole("heading", { name: "Your feasible plan" })).toBeVisible({ timeout: 15000 });
  const cards = page.locator("article[data-plan-id]");
  await expect(cards).toHaveCount(1);
  await expect(page.getByText(/more than two Economics courses/).first()).toBeVisible();
  const offeringConfirmation = page.locator(".advisor-attention li", {
    hasText: "Confirm offerings and time conflicts:"
  });
  await expect(offeringConfirmation).toHaveCount(1);
  for (const statisticsChoice of ["ECO 257", "MAT 217", "PSY 217"]) {
    await expect(offeringConfirmation).toContainText(statisticsChoice);
  }
  for (const card of await cards.all()) {
    await expect(card.getByText("Statistics requirement")).toBeVisible();
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
  await selectRequirementChoice(page, "MAT 113");
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

test("PDF download recovers cleanly after failed and aborted requests", async ({ page }) => {
  await setStanding(page, "Senior");
  await setPlanDate(page, "2026-07-30");
  for (const code of ["ECO 113", "ECO 114"]) {
    await courseStatus(page, code, "Completed").click();
  }
  await courseStatus(page, "MAT 113 / MAT 121", "Completed").click();
  await selectRequirementChoice(page, "MAT 113");
  await courseStatus(page, "ECO 214", "Completed").click();
  await page.getByRole("button", { name: /Generate my plans/ }).click();
  await expect(page.getByRole("heading", { name: "Your feasible plan" })).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: /Review selected Plan/ }).click();

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

  const recoveredRequest = page.waitForRequest(request => request.url().endsWith("/api/reports/economics"));
  await download.click();
  await recoveredRequest;
});

test("a structurally malformed successful planner response is rejected before storage", async ({ page }) => {
  await setPlanDate(page, "2026-07-30");
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

test("comparison entry, dialog, and long content stay inside every target viewport", async ({ page }) => {
  test.setTimeout(180000);
  await installLongContentResponse(page);

  for (const viewport of OVERFLOW_VIEWPORTS) {
    for (let repetition = 1; repetition <= viewport.repetitions; repetition += 1) {
      const label = `${viewport.name} ${viewport.width}px repetition ${repetition}`;
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await resetPlanner(page);
      await setPlanDate(page, "2026-07-31");
      await page.getByRole("textbox", { name: "Student name (optional)" }).fill(LONG_STUDENT_NAME);

      await page.getByRole("button", { name: "Transfer students: Change graduation year" }).click();
      const transferCard = page.getByRole("region", { name: "Transfer student planning" });
      await expect(transferCard).toBeVisible();
      await assertInsideViewport(transferCard, `${label} transfer card`);
      await assertNoHorizontalOverflow(page, `${label} transfer state`);

      await page.getByRole("button", { name: "Use regular class-year choices" }).click();
      const completed213 = courseStatus(page, "ECO 213", "Completed");
      await completed213.click();
      const dialog = page.getByRole("dialog", { name: "Confirm prerequisites for ECO 213" });
      await expect(dialog).toBeVisible();
      await assertInsideViewport(dialog, `${label} prerequisite dialog`);
      await assertNoHorizontalOverflow(page, `${label} prerequisite dialog`);
      await page.getByRole("button", { name: "Cancel" }).click();

      await courseStatus(page, "ECO 113", "Completed").click();
      const generationResponse = page.waitForResponse(response => isGenerationRequest(response.request()));
      await page.getByRole("button", { name: /Generate my plans/ }).click();
      expect((await generationResponse).status()).toBe(200);
      await expect(page.getByRole("heading", { name: "Compare your plans" })).toBeVisible({ timeout: 15000 });
      await expect(page.locator("article[data-plan-id]")).toHaveCount(3);
      await assertNoHorizontalOverflow(page, `${label} comparison entry`);

      const studentName = page.getByText(LONG_STUDENT_NAME, { exact: true });
      const planDescription = page.getByText(LONG_PLAN_DESCRIPTION, { exact: true });
      await expect(studentName).toBeVisible();
      await expect(planDescription).toBeVisible();
      await assertLongTextWraps(studentName, `${label} fictional student name`);
      await assertLongTextWraps(planDescription, `${label} fictional plan description`);
      await assertNoHorizontalOverflow(page, `${label} long content`);

      await page.getByRole("button", { name: "Choose Plan C" }).click();
      await expect(page.getByRole("heading", { name: "Review Plan C" })).toBeVisible();
      const courseTitle = page.getByText(LONG_COURSE_TITLE, { exact: true });
      const planWarning = page.getByText(LONG_PLAN_WARNING, { exact: true });
      const approvalMessage = page.getByText(LONG_APPROVAL_MESSAGE, { exact: true });
      await expect(courseTitle).toBeVisible();
      await expect(planWarning).toBeVisible();
      await expect(approvalMessage).toBeVisible();
      await assertLongTextWraps(courseTitle, `${label} fictional course title`);
      await assertLongTextWraps(planWarning, `${label} fictional plan warning`);
      await assertLongTextWraps(approvalMessage, `${label} fictional approval`);
      await assertNoHorizontalOverflow(page, `${label} selected plan`);
    }
  }
});
