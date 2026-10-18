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
  await page.getByRole("button", { name: "Review this plan: Balanced" }).click();
  await expect(page.getByRole("heading", { name: "Review Balanced" })).toBeVisible();
}

async function visibleSchedule(page) {
  return page.locator(".term-card").evaluateAll(cards => cards.map(card => ({
    academicYear: card.dataset.academicYear,
    termKey: card.dataset.termKey,
    courses: [...card.querySelectorAll(".plan-course-summary > strong")].map(course => course.textContent.trim())
  })));
}

for (const responseStatus of [422, 200]) {
  test(`a duplicate-plan edit response (${responseStatus}) leaves the visible comparison unchanged`, async ({ page }) => {
    const balanced = fixturePlan();
    balanced.terms[0].courses[0].moveDestinationOptions = [
      {id:"2026-FALL",status:"CURRENT",label:"Fall 2026"},
      {id:"2027-WINTER",status:"ALLOWED",label:"Winter 2027"}
    ];
    const explore = structuredClone(balanced);
    explore.id = "explore-first";
    explore.label = "Explore the Major";
    explore.terms[1].courses.push(...explore.terms[0].courses);
    explore.terms[0].courses = [];
    await openFixtureResult(page, plannerResultFixture({ plans: [balanced, explore] }));
    await page.getByRole("button", { name: "Review this plan: Balanced" }).click();
    await expect(page.getByRole("heading", { name: "Review Balanced" })).toBeVisible();
    const originalSchedule = await visibleSchedule(page);
    await page.getByRole("button",{name:"Change ECO 113",exact:true}).click();
    const moveControl = page.getByRole("combobox", { name: "Change ECO 113 to" });

    await page.unroute("**/api/majors/map");
    await page.route("**/api/majors/map", async route => {
      const request = route.request().postDataJSON();
      expect(request.action).toBe("validate-plan");
      const reason = "Balanced and Explore the Major have the same material schedule.";
      await route.fulfill({
        status: responseStatus,
        contentType: "application/json",
        body: JSON.stringify(responseStatus === 422
          ? { code: "INVALID_PLAN_SET", error: `That plan change cannot be saved. ${reason}`, planSetValidation: { valid: false, errors: [reason] } }
          : { plan: { ...request.plan, validation: { valid: true } }, planSetValidation: { valid: false, errors: [reason] } })
      });
    });

    await expect(moveControl.locator('option[value="move:2027-WINTER"]')).toHaveCount(1);
    await moveControl.selectOption("move:2027-WINTER");
    await page.getByRole("button",{name:"Apply change",exact:true}).click();
    await expect(page.locator(".plan-course-edit-feedback")).toContainText("same material schedule");
    await expect(page.locator(".plan-edit-status")).toHaveText("Change could not be saved.");
    await expect(page.locator(".plan-edit-status")).not.toContainText("updated and remains valid");
    await expect.poll(() => visibleSchedule(page)).toEqual(originalSchedule);
    await expect(page.getByRole("button", { name: "Undo last plan edit" })).toHaveCount(0);
    await expect(page.getByRole("button",{name:"Apply change",exact:true})).toBeFocused();
  });
}

test("Freshman, Sophomore, and Junior can request the shared accelerated comparison while Senior cannot", async ({ page }) => {
  await resetPlanner(page);

  for (const standing of ["freshman", "sophomore", "junior"]) {
    await chooseStanding(page, standing);
    const label = standing === "junior"
      ? "I’d like to graduate next year"
      : "I’d like to graduate one year early";
    const early = page.getByRole("button", { name: label, exact: true });
    await expect(early).toBeVisible();
    await expect(early).toHaveAttribute("aria-pressed", "false");
    await early.click();
    await expect(early).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".cp7-summary")).toContainText("One-year-early target");
    await early.click();
    await expect(early).toHaveAttribute("aria-pressed", "false");
  }

  await chooseStanding(page, "senior");
  await expect(page.getByRole("button", { name: /graduate (?:one year early|next year)/i })).toHaveCount(0);
  await expect(page.locator(".cp7-summary")).not.toContainText("One-year-early target");

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

test("saved Senior One Year Early state migrates to Standard with a temporary explanation", async ({ page }) => {
    const explanation = "One Year Early is available through junior standing. We kept your saved answers and changed this senior plan to the standard graduation timeline.";
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
    }, { storageKey: UI_STORAGE_KEY, savedStanding: "senior" });
    await page.goto("/?layout=apple");

    await expect(page.locator(".summary-attention")).toContainText(explanation);
    await expect(page.locator(".cp7-summary")).toContainText("Senior");
    await expect(page.locator(".cp7-summary")).toContainText("ECO 113");
    await expect(page.getByRole("button", { name: /graduate (?:one year early|next year)/i })).toHaveCount(0);
    await expect.poll(() => page.evaluate(storageKey => {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      return {
        academicStanding: saved.formData.academicStanding,
        planningPace: saved.formData.planningPace,
        completedCourse: saved.formData.courses.find(course => course.code === "ECO 113")?.status
      };
    }, UI_STORAGE_KEY)).toEqual({
        academicStanding: "senior",
      planningPace: "standard",
      completedCourse: "completed"
    });

    await chooseStanding(page, "sophomore");
    await expect(page.getByText(explanation, { exact: true })).toHaveCount(0);
});

test("saved Junior One Year Early state remains selected", async ({ page }) => {
  await page.addInitScript(storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({
      schemaVersion: 6,
      formData: {
        academicStanding: "junior",
        planningPace: "one_year_early",
        planCreationDate: "2026-08-09",
        planCreationDateEdited: true,
        courses: []
      },
      courseSearch: ""
    }));
  }, UI_STORAGE_KEY);
  await page.goto("/?layout=apple");

  await expect(page.getByRole("button", { name: "I’d like to graduate next year", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".summary-attention")).toHaveCount(0);
});

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
  await page.getByRole("button", { name: "My expected graduation year is different" }).click();

  const graduation = page.getByLabel("When do you expect to graduate?");
  await expect(graduation).toBeVisible();
  await expect(page.getByLabel("When did you first enroll at Hanover?")).toHaveCount(0);
  await expect(page.getByText(/Are you a transfer student/i)).toHaveCount(0);

  await page.getByRole("button", { name: "Continue to your courses" }).click();
  await expect(graduation).toBeFocused();
  await graduation.selectOption({ index: 1 });
  const expectedGraduationYear = await graduation.inputValue();
  await expect(page.locator(".custom-target")).toContainText(`Spring/May ${expectedGraduationYear}`);

  await continueToCourses(page);
  await generatePlans(page);
  expect(postedStudent).toMatchObject({
    academicStanding: "sophomore",
    isTransferStudent: false,
    customGraduationEnabled: true,
    customExpectedGraduationYear: expectedGraduationYear
  });
});

test("course statuses are single-select, clear on a second click, and update the summary by code", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await continueToCourses(page);

  const group = courseStatusGroup(page, "ECO 113");
  const completed = group.getByRole("button", { name: "Completed" });
  const takingNow = group.getByRole("button", { name: "Taking now" });
  await expect(group.getByRole("button")).toHaveCount(2);
  await expect(group.getByRole("button", { name: "Not taken / not sure" })).toHaveCount(0);
  await expect(page.getByText("Required math course", { exact: true })).toBeVisible();
  await expect(page.getByText("Choose a statistics course", { exact: true })).toBeVisible();
  await expect(page.getByText("Choose a money and finance course", { exact: true })).toBeVisible();
  await expect(page.getByText("Essential Pre-Calculus", { exact: true })).toBeVisible();
  await expect(page.getByText("Investments", { exact: true })).toBeVisible();
  await expect(page.getByText("Money and Financial Markets", { exact: true })).toBeVisible();
  await completed.click();
  await expect(completed).toHaveAttribute("aria-pressed", "true");
  await expect(takingNow).toHaveAttribute("aria-pressed", "false");
  await expect(group.locator(".is-selected")).toHaveCount(1);
  await expect(page.locator(".cp7-summary")).toContainText("ECO 113");

  await takingNow.click();
  await expect(completed).toHaveAttribute("aria-pressed", "false");
  await expect(takingNow).toHaveAttribute("aria-pressed", "true");
  await expect(group.locator("[aria-pressed='true']")).toHaveCount(1);
  await takingNow.click();
  await expect(group.locator("[aria-pressed='true']")).toHaveCount(0);
  await expect(page.locator(".cp7-summary .summary-details > div").filter({ hasText: "Taking now" })).toContainText("None selected");
});

test("progress navigation returns to About you and advances to Your courses", async ({ page }) => {
  await resetPlanner(page);
  await expect(page.getByRole("img", { name: "Urveska" })).toBeVisible();
  const aboutYou = page.getByRole("navigation", { name: "Planner progress" })
    .getByRole("button", { name: "About you", exact: true });
  expect(await aboutYou.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(15.6, 1);
  await chooseStanding(page, "freshman");
  await continueToCourses(page);

  await aboutYou.click();
  await expect(page.getByRole("heading", { name: "Where are you in your degree?" })).toBeVisible();

  await page.getByRole("navigation", { name: "Planner progress" })
    .getByRole("button", { name: "Your courses", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "Which courses have you finished or are taking now?" })).toBeVisible();
  await expect(page.getByText("Your plans", { exact: true })).toHaveAttribute("aria-disabled", "true");
});

test("ordinary intake hides catalog selection and states the active planning basis", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await expect(page.getByLabel(/catalog year/i)).toHaveCount(0);
  await expect(page.getByText("Planning requirements: 2025–2026 Economics catalog and confirmed department policies.", { exact: true })).toBeVisible();
  await expect(page.getByText(/official degree audit may differ/i)).toBeVisible();
});

test("intake and generated results survive a normal reload", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "sophomore");
  await continueToCourses(page);
  await setCourseStatus(page, "ECO 113", "Completed");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Which courses have you finished or are taking now?" })).toBeVisible();
  await expect(courseStatusGroup(page, "ECO 113").getByRole("button", { name: "Completed" })).toHaveAttribute("aria-pressed", "true");

  await fulfillPlanner(page, plannerResultFixture());
  await generatePlans(page);
  await expect(page.getByRole("heading", { name: /Your feasible plan|Compare your course plans/ })).toBeVisible();
  await page.reload();
  await expect(page.locator(".result-status-value")).toHaveText("Ready to plan");
  await expect(page.getByText("EconPlanner is a planning guide, not an official degree audit.", { exact: true })).toHaveCount(1);
});

test("Clear all cancels safely and then removes intake and generated state", async ({ page }) => {
  await openFixtureResult(page, plannerResultFixture());
  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Clear all answers and generated plans?" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".result-status-value")).toHaveText("Ready to plan");

  await page.getByRole("button", { name: "Clear all", exact: true }).click();
  await dialog.getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Where are you in your degree?" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Class standing" }).locator("[aria-pressed='true']")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("econ-planner-ui-state"));
    return {
      standing: saved?.formData?.academicStanding || "",
      selectedCourses: (saved?.formData?.courses || []).filter(course => course.status !== "not_started").length,
      scheduleSetByTerm: saved?.formData?.scheduleSetByTerm || {},
      session: sessionStorage.getItem("econ-planner-generated-session")
    };
  })).toEqual({ standing: "", selectedCourses: 0, scheduleSetByTerm: {}, session: null });
});

test("drop/add checkbox is accessible, exact-term persistent, request-bound, and mobile safe", async ({ page }) => {
  await resetPlanner(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseStanding(page, "freshman");
  await page.locator("details.more-details > summary", { hasText: "More details" }).first().click();
  await page.getByLabel("Plan creation date", { exact: true }).fill("2026-08-24");

  const checkbox = page.getByRole("checkbox", { name: /My schedule for Fall 2026 is already set/ });
  await expect(checkbox).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  await page.getByRole("button", { name: /graduate one year early/ }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(checkbox).toBeFocused();
  await expect.poll(() => checkbox.evaluate(element => getComputedStyle(element).outlineStyle)).toBe("solid");
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  await expect.poll(() => page.evaluate(() => (
    JSON.parse(localStorage.getItem("econ-planner-ui-state"))?.formData?.scheduleSetByTerm?.["fall-2026"]
  ))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.reload();
  await expect(checkbox).toBeChecked();
  await page.locator("details.more-details > summary", { hasText: "More details" }).first().click();
  await page.getByLabel("Plan creation date", { exact: true }).fill("2026-08-29");
  await expect(checkbox).toHaveCount(0);
  await page.getByLabel("Plan creation date", { exact: true }).fill("2026-08-24");
  await expect(checkbox).toBeChecked();

  let submitted = null;
  page.on("request", request => {
    if (request.url().endsWith("/api/majors/map") && request.method() === "POST") submitted = request.postDataJSON();
  });
  await fulfillPlanner(page, plannerResultFixture());
  await continueToCourses(page);
  await generatePlans(page);
  expect(submitted.student.scheduleSetByTerm).toEqual({ "fall-2026": true });
});

test("custom graduation and acceleration stay separate", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "sophomore");
  const early = page.getByRole("button", { name: "I’d like to graduate one year early", exact: true });
  await early.click();
  await page.getByRole("button", { name: "My expected graduation year is different" }).click();
  await expect(early).toHaveCount(0);
  await expect(page.locator(".summary-status")).toContainText("accelerated comparison was turned off");
  await page.getByLabel("When do you expect to graduate?").selectOption({ index: 1 });
  await expect(page.locator(".cp7-summary")).toContainText("Custom graduation target");
  await expect(page.locator(".cp7-summary")).not.toContainText("One-year-early target");
  await page.getByRole("button", { name: "Use my standard class-year timeline" }).click();
  await expect(page.getByRole("button", { name: "I’d like to graduate one year early", exact: true })).toHaveAttribute("aria-pressed", "false");
});

test("study abroad reserves the whole actual term and restores a remembered manual reservation", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await page.locator("details.more-details > summary", { hasText: "More details" }).first().click();
  await page.getByText("Adjust your schedule (optional)", { exact: true }).click();
  const studyToggle = page.getByRole("button", { name: "I plan to study abroad during my junior year" });
  await studyToggle.click();
  const selectedTerm = await page.getByLabel("Study-abroad term").locator("option:checked").innerText();
  await expect(page.getByText(`No Economics courses will be scheduled in ${selectedTerm}.`, { exact: true })).toBeVisible();
  const reserved = page.getByLabel(`Course units reserved in ${selectedTerm}`);
  await expect(reserved).toBeDisabled();
  const wholeCapacity = Number(await reserved.inputValue());
  expect(wholeCapacity).toBeGreaterThan(0);
  await expect(page.locator(".cp7-summary")).toContainText(`No Economics courses in ${selectedTerm}`);

  await studyToggle.click();
  await expect(reserved).toBeEnabled();
  await reserved.selectOption("1");
  await studyToggle.click();
  await studyToggle.click();
  await expect(reserved).toHaveValue("1");
  await expect(page.locator(".cp7-summary")).toContainText(`${selectedTerm}: 1`);
});

test("accelerated results expose the backend Possible, Not possible, and More information needed findings", async ({ page }) => {
  for (const [status, label] of [
    ["POSSIBLE", "Possible"],
    ["NOT_POSSIBLE", "Not possible"],
    ["MORE_INFORMATION_NEEDED", "More information needed"]
  ]) {
    await page.unroute("**/api/majors/map").catch(() => {});
    const plans = status === "POSSIBLE"
      ? [fixturePlan(), fixturePlan({ id: "one-year-early", label: "One Year Early" })]
      : [fixturePlan()];
    await openFixtureResult(page, plannerResultFixture({
      plans,
      acceleratedResult: {
        requested: true,
        status,
        label: "Graduate one year early",
        standardTarget: "Spring/May 2030",
        acceleratedTarget: "Spring/May 2029",
        message: `Backend accelerated finding: ${label}.`
      }
    }));
    if (status === "POSSIBLE") {
      const earlyPlan = page.locator('article[data-plan-id="one-year-early"]');
      await expect(page.locator(".accelerated-result")).toHaveCount(0);
      await expect(earlyPlan.locator(".early-plan-status")).toHaveText(label);
      await expect(earlyPlan).toContainText("Standard plan");
      await expect(earlyPlan).toContainText("Spring/May 2030");
      await expect(earlyPlan).toContainText("This plan");
      await expect(earlyPlan).toContainText("Spring/May 2029");
      await expect(earlyPlan.locator(".comparison-plan-summary > p")).toHaveCount(0);
    } else {
      await expect(page.locator(".accelerated-result-status")).toHaveText(label);
      await expect(page.locator(".accelerated-result")).toContainText(`Backend accelerated finding: ${label}.`);
      await expect(page.locator(".accelerated-result")).toContainText("Standard target");
      await expect(page.locator(".accelerated-result")).toContainText("Accelerated target");
      await expect(page.locator(".accelerated-result")).toContainText("Spring/May 2030");
      await expect(page.locator(".accelerated-result")).toContainText("Spring/May 2029");
    }
  }
});

test("completion source choices are compact, eligibility-limited, saved, and cleared", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await continueToCourses(page);

  const eco113 = page.locator("#course-eco-113");
  const eco213 = page.locator("#course-eco-213");
  await expect(eco113.getByRole("button", { name: "Transfer or AP credit?" })).toHaveCount(0);
  await expect(eco113.getByRole("button", { name: "Another college / transfer credit" })).toHaveCount(0);
  await expect(eco113.getByRole("button", { name: "AP or exam credit" })).toHaveCount(0);

  await setCourseStatus(page, "ECO 113", "Completed");
  const sourceAction = eco113.getByRole("button", { name: "Transfer or AP credit?" });
  await expect(sourceAction).toBeVisible();
  await expect(sourceAction).toHaveAttribute("aria-expanded", "false");
  await expect(eco113.getByRole("button", { name: "Another college / transfer credit" })).toHaveCount(0);
  await expect(eco113.getByRole("button", { name: "AP or exam credit" })).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("econ-planner-ui-state"));
    const course = saved.formData.courses.find(item => item.code === "ECO 113");
    return { status: course.status, source: course.source };
  })).toEqual({ status: "completed", source: "manual_code" });

  await sourceAction.click();
  await expect(eco113.getByRole("button", { name: "Hanover College" })).toHaveAttribute("aria-pressed", "true");
  await expect(eco113.getByRole("button", { name: "Another college / transfer credit" })).toBeVisible();
  await expect(eco113.getByRole("button", { name: "AP or exam credit" })).toBeVisible();

  await setCourseStatus(page, "ECO 213", "Completed");
  await eco213.getByRole("button", { name: "Transfer or AP credit?" }).click();
  await expect(eco213.getByRole("button", { name: "Another college / transfer credit" })).toBeVisible();
  await expect(eco213.getByRole("button", { name: "AP or exam credit" })).toHaveCount(0);

  await sourceAction.click();
  await eco113.getByRole("button", { name: "Another college / transfer credit" }).click();
  await expect(eco113).toContainText("Selected: Another college / transfer credit");
  await expect(eco113).toContainText("review-required until its supporting evidence is approved");
  await expect.poll(async () => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("econ-planner-ui-state"));
    const course = saved.formData.courses.find(item => item.code === "ECO 113");
    return { status: course.status, source: course.source };
  })).toEqual({ status: "transfer", source: "transfer_equivalency_unapproved" });

  await page.reload();
  const restoredEco113 = page.locator("#course-eco-113");
  await expect(restoredEco113.getByRole("button", { name: "Completed" })).toHaveAttribute("aria-pressed", "true");
  await expect(restoredEco113).toContainText("Selected: Another college / transfer credit");
  await expect(restoredEco113.getByRole("button", { name: "Another college / transfer credit" })).toHaveCount(0);
  await restoredEco113.getByRole("button", { name: "Transfer or AP credit?" }).click();
  await expect(restoredEco113.getByRole("button", { name: "Another college / transfer credit" })).toHaveAttribute("aria-pressed", "true");
  await restoredEco113.getByRole("button", { name: "Hanover College" }).click();
  await expect(restoredEco113).not.toContainText("Selected: Another college / transfer credit");
  await expect.poll(async () => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("econ-planner-ui-state"));
    const course = saved.formData.courses.find(item => item.code === "ECO 113");
    return { status: course.status, source: course.source };
  })).toEqual({ status: "completed", source: "manual_code" });

  await restoredEco113.getByRole("button", { name: "Another college / transfer credit" }).click();
  await page.locator(".cp7-summary").getByRole("button", { name: "Clear all", exact: true }).click();
  await page.getByRole("dialog", { name: "Clear all answers and generated plans?" })
    .getByRole("button", { name: "Clear all", exact: true })
    .click();
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("econ-planner-ui-state"));
    const course = saved?.formData?.courses?.find(item => item.code === "ECO 113");
    return { status: course?.status || "", source: course?.source || "" };
  })).toEqual({ status: "not_started", source: "manual_code" });
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
  const choiceHeading = eco213.locator(".prerequisite-question-heading")
    .filter({ hasText: "Choose a prerequisite option" });
  await expect(choiceHeading).toHaveText("Choose a prerequisite option");
  await expect(eco213).not.toContainText("One of the current valid options is needed.");
  await expect(courseStatusGroup(page, "ECO 113", "Status for prerequisite")).toBeVisible();
  await expect(courseStatusGroup(page, "MAT 113", "Status for prerequisite")).toBeVisible();
  await expect(courseStatusGroup(page, "MAT 121", "Status for prerequisite")).toBeVisible();

  const headingBox = await choiceHeading.locator("strong").boundingBox();
  const controlsBox = await courseStatusGroup(page, "MAT 113", "Status for prerequisite").boundingBox();
  expect(headingBox).not.toBeNull();
  expect(controlsBox).not.toBeNull();
  expect(Math.abs(
    headingBox.x + headingBox.width / 2 - (controlsBox.x + controlsBox.width / 2)
  )).toBeLessThan(3);

  await setCourseStatus(page, "MAT 113", "Not taken / not sure", "Status for prerequisite");
  const mat113 = courseStatusGroup(page, "MAT 113", "Status for prerequisite");
  await expect(mat113.locator(".is-selected")).toHaveCount(1);
  await expect(mat113.getByRole("button", { name: "Completed" })).toHaveAttribute("aria-pressed", "false");
  await expect(mat113.getByRole("button", { name: "Taking now" })).toHaveAttribute("aria-pressed", "false");
  await expect(mat113.getByRole("button", { name: "Not taken / not sure" })).toHaveAttribute("aria-pressed", "true");
  await mat113.getByRole("button", { name: "Not taken / not sure" }).click();
  await expect(mat113.locator(".is-selected")).toHaveCount(0);

  await setCourseStatus(page, "ECO 213", "Taking now");
  await setCourseStatus(page, "ECO 214", "Taking now");
  const eco214 = page.locator("#course-eco-214 .inline-prerequisite");
  await expect(eco214).toBeVisible();
  await expect(eco214).toContainText("Before we can use ECO 214");
  await expect(courseStatusGroup(page, "ECO 114", "Status for prerequisite")).toBeVisible();
  await expect(eco214).not.toContainText("concurrency exception");
});

for (const course of ["ECO 213", "ECO 214"]) {
  for (const targetStatus of ["Completed", "Taking now"]) {
    test(`${course} ${targetStatus.toLowerCase()} requires every inline prerequisite answer`, async ({ page }) => {
      await resetPlanner(page);
      await chooseStanding(page, "freshman");
      await continueToCourses(page);
      await setCourseStatus(page, course, targetStatus);

      const dependent = page.locator(`#course-${course.toLowerCase().replaceAll(" ", "-")}`);
      const generate = page.getByRole("button", { name: "Generate my plans" });
      await expect(dependent.locator(".inline-prerequisite")).toBeVisible();
      await expect(generate).toBeDisabled();
      await expect(page.locator(".cp7-summary").getByText("Needs attention")).toBeVisible();
      await expect(page.locator(".cp7-summary")).toContainText(`${course} prerequisite question`);
      const summaryRow = page.locator(".cp7-summary").getByText(targetStatus, { exact: true }).locator("..");
      await expect(summaryRow).toContainText("None selected");

      const unanswered = dependent.locator(".prerequisite-question").first();
      const questionId = await unanswered.getAttribute("id");
      await page.locator(".cp7-summary").getByRole("button", { name: new RegExp(`${course} prerequisite question`) }).first().click();
      await expect(page.locator(`#${questionId}`)).toBeFocused();

      let requests = 0;
      await page.route("**/api/majors/map", async route => {
        requests += 1;
        await route.abort();
      });
      await page.locator("form").evaluate(form => form.requestSubmit());
      await expect(page.locator(".summary-status")).toContainText("Answer the highlighted prerequisite questions");
      expect(requests).toBe(0);

      await expect.poll(() => page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem("econ-planner-ui-state"));
        return saved?.formData?.courses;
      }).then(courses => courses?.find(item => item.code === course)?.status))
        .toBe(targetStatus === "Completed" ? "completed" : "in_progress");
      await page.reload();
      await expect(generate).toBeDisabled();
      await expect(dependent.locator(".inline-prerequisite")).toBeVisible();

      const prerequisiteGroups = dependent.locator(".prerequisite-option");
      const optionsCount = await prerequisiteGroups.count();
      for (let index = 0; index < optionsCount; index += 1) {
        await prerequisiteGroups.nth(index).getByRole("button", { name: "Not taken / not sure" }).click();
      }
      await expect(generate).toBeEnabled();
      await expect(page.locator(".cp7-summary")).toContainText(course);

      const group = prerequisiteGroups.first().getByRole("button", { name: "Not taken / not sure" });
      await group.click();
      await expect(generate).toBeDisabled();
    });
  }
}

test("completed prerequisites recorded on the course cards are not asked again", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await continueToCourses(page);
  for (const course of ["ECO 113", "MAT 113", "ECO 114", "MAT 121"]) {
    await setCourseStatus(page, course, "Completed");
  }
  for (const dependent of ["ECO 213", "ECO 214"]) {
    await setCourseStatus(page, dependent, "Taking now");
    await expect(page.locator(`#course-${dependent.toLowerCase().replaceAll(" ", "-")} .inline-prerequisite`)).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Generate my plans" })).toBeEnabled();
  await expect(page.locator(".cp7-summary").getByText("Taking now").locator(".."))
    .toContainText("ECO 213 · ECO 214");
});

for (const [math, economics] of [
  ["MAT 113", "ECO 213"],
  ["MAT 121", "ECO 213"],
  ["MAT 113", "ECO 214"],
  ["MAT 121", "ECO 214"]
]) {
  test(`accelerated plan explains ${math} before ${economics}`, async ({ page }) => {
    const accelerated = fixturePlan({ id: "one-year-early", label: "Graduate One Year Early" });
    accelerated.isEarlyGraduation = true;
    accelerated.terms = [
      { slotId: "math", academicYear: "2026-2027", termKey: "Fall", term: "Fall 2026", displayTerm: "Fall 2026", courses: [{ course: math, title: "College Algebra" }] },
      { slotId: "eco", academicYear: "2026-2027", termKey: "Winter", term: "Winter 2027", displayTerm: "Winter 2027", courses: [{ course: economics, title: "Intermediate Economics" }] }
    ];
    await openFixtureResult(page, plannerResultFixture({ plans: [accelerated] }));
    await page.getByRole("button", { name: "Review this plan: Graduate One Year Early" }).click();
    await expect(page.locator(".accelerated-math-sequence-note")).toContainText(`${math} is scheduled before ${economics}`);
    await expect(page.locator(".accelerated-math-sequence-note")).toContainText("without special approval for concurrent math");
    await expect(page.locator(".accelerated-math-sequence-note")).toContainText("approval is not guaranteed");
  });
}

for (const [math, economics] of [
  ["MAT 113", "ECO 213"],
  ["MAT 121", "ECO 213"],
  ["MAT 113", "ECO 214"],
  ["MAT 121", "ECO 214"]
]) {
  test(`concurrent ${math} and ${economics} retains its instructor approval warning`, async ({ page }) => {
    const accelerated = fixturePlan({ id: "one-year-early", label: "Graduate One Year Early" });
    accelerated.isEarlyGraduation = true;
    const approvalWarning = `${math} may be taken with ${economics} only with approval from the ${economics} instructor.`;
    accelerated.studentMessages = [approvalWarning];
    accelerated.planConditions = [{ id: "instructor-approval", kind: "approval", message: approvalWarning }];
    accelerated.terms = [{
      slotId: "concurrent",
      academicYear: "2026-2027",
      termKey: "Fall",
      term: "Fall 2026",
      displayTerm: "Fall 2026",
      courses: [
        { course: math, title: "College Algebra" },
        { course: economics, title: "Intermediate Economics", planningMarkers: ["Approval required"], approvalRequired: [{ authority: `${economics} instructor` }] }
      ]
    }];
    await openFixtureResult(page, plannerResultFixture({ plans: [accelerated] }));
    await page.getByRole("button", { name: "Review this plan: Graduate One Year Early" }).click();
    await expect(page.locator(".accelerated-math-sequence-note")).toHaveCount(0);
    await expect(page.locator(".plan-course-approval")).toContainText("Advisor approval needed");
    await expect(page.locator("[data-plan-conditions]")).toContainText(approvalWarning);
  });
}

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

  await expect(page.getByRole("button", { name: "Generate my plans" })).toBeEnabled();
  await page.getByRole("button", { name: "Generate my plans" }).click();
  await expect(page.locator("#course-eco-213")).toBeFocused();
  await expect(dependent).toHaveAttribute("aria-pressed", "true");
  await expect(prerequisite).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".cp7-summary")).toContainText("Correct the highlighted prerequisite issues");
});

test("ordinary results show backend readiness and explain the plan once in its card", async ({ page }) => {
  const fixture = plannerResultFixture({
    candidateOutcomes: [{ id: "balanced", label: "Balanced", status: "VERIFIED_FEASIBLE", displayed: true }]
  });
  await openFixtureResult(page, fixture);

  await expect(page.locator(".result-status-value")).toHaveText("Ready to plan");
  await expect(page.locator("details.result-diagnostics")).toHaveCount(0);
  const description = page.getByText("Spreads the required classes you still need across the years before you graduate.", {exact:true});
  await expect(description).toHaveCount(1);
  await expect(description).toBeVisible();
});

test("structured INPUT_BLOCKED asks for the missing detail and preserves a return path", async ({ page }) => {
  await openFixtureResult(page, inputBlockedFixture(), 422);

  await expect(page.locator(".result-status-value")).toHaveText("Needs one more detail");
  await expect(page.locator(".no-plan-state")).toContainText("We need one more detail before we can build your plan.");
  await expect(page.locator(".no-plan-state")).toContainText("When do you expect to graduate?");
  await expect(page.locator(".no-plan-state")).not.toContainText("No plan exists");
  await page.getByRole("button", { name: "Review my answers" }).click();
  await expect(page.getByRole("heading", { name: /Where are you in your degree\?|Which courses have you finished or are taking now\?/ })).toBeVisible();
  await expect(page.locator(".cp7-summary")).toContainText("Freshman");
  await expect(page.locator(".no-plan-state")).toHaveCount(0);
});

test("SEARCH_INCOMPLETE and INFEASIBLE_PROVEN remain visibly distinct", async ({ page }) => {
  await openFixtureResult(page, searchIncompleteFixture());
  await expect(page.locator(".no-plan-state")).toContainText("We could not finish checking every possible plan.");
  await expect(page.locator(".no-plan-state")).toContainText("This does not mean a plan is impossible.");
  await expect(page.locator(".result-status-value")).toHaveText("More information needed");

  await page.unroute("**/api/majors/map");
  await openFixtureResult(page, infeasibleFixture());
  await expect(page.locator(".no-plan-state")).toContainText("No complete plan fits this graduation target under the current requirements and course timing.");
  await expect(page.locator(".no-plan-state")).toContainText("Review your graduation timeline");
});

test("missing scoped offering evidence is shown as More information needed", async ({page}) => {
  const fixture = infeasibleFixture();
  const economics = fixture.programs.find(program => program.economicsPlanResult);
  economics.economicsPlanResult.category = "NEEDS_ADVISOR_ATTENTION";
  economics.economicsPlanResult.conclusion = "UNKNOWN";
  economics.economicsPlanResult.reason = "MISSING_OFFERING";
  economics.economicsPlanResult.evidence.blockingReasons = [];
  await openFixtureResult(page,fixture);
  await expect(page.locator('.result-status-value')).toHaveText('More information needed');
  await expect(page.locator('.no-plan-state')).toContainText('Course offering evidence is incomplete');
  await expect(page.locator('.no-plan-state')).toContainText('does not establish that major completion is impossible');
});

test("a freshman receives the Balanced and Explore the Major normal comparisons", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  await continueToCourses(page);
  await generatePlans(page);

  await expect(page.locator('article[data-plan-id="balanced"]')).toBeVisible();
  await expect(page.locator('article[data-plan-id="explore-first"]')).toBeVisible();
  await expect(page.locator('article[data-plan-id="one-year-early"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Review this plan: Explore the Major" }).click();
  await expect(page.getByRole("heading", { name: "Review Explore the Major" })).toBeVisible();
  await expect(page.locator(".plan-course-availability")).not.toHaveCount(0);
  await expect(page.locator(".plan-course-availability").first()).toHaveText("Seat availability not confirmed");

  const availability = page.locator("details.schedule-availability");
  await expect(availability).toBeVisible();
  await expect(availability).not.toHaveAttribute("open", "");
  await availability.locator(":scope > summary").click();
  await expect(availability.getByText("Seat availability hasn’t been confirmed. Check the registration system before you register.")).toBeVisible();
  await expect(availability.locator(".seat-term-list dd")).not.toHaveCount(0);
  await expect(availability.locator(".recorded-seat-information")).not.toHaveAttribute("open", "");
  await availability.getByText("Recorded seat information", { exact: true }).click();
  await expect(availability).toContainText("These sections were recorded as open, but the observation dates are unavailable.");
  await expect(page.locator(".result-diagnostics")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("validated options retained");
  await availability.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("compact-panels-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await availability.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("compact-panels-mobile.png") });
});

test("CP5 displays distinct Balanced, Explore the Major, and One Year Early plans", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "freshman");
  const early = page.getByRole("button", { name: "I’d like to graduate one year early", exact: true });
  await early.click();
  await continueToCourses(page);
  const response = await generatePlans(page);
  const payload = await response.json();
  const economics = payload.programs.find(result => result.program?.id === "economics-base");

  await expect(page.locator('article[data-plan-id="balanced"]')).toBeVisible();
  await expect(page.locator('article[data-plan-id="explore-first"]')).toBeVisible();
  await expect(page.locator('article[data-plan-id="one-year-early"]')).toBeVisible();
  await expect(page.locator("article[data-plan-id]")).toHaveCount(3);
  await expect(page.locator("details.result-diagnostics")).toHaveCount(0);
  await expect(page.locator('article[data-plan-id="one-year-early"] .early-plan-status')).toHaveText("Possible");

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
  await expect(page.locator("[data-plan-conditions]")).toContainText("Confirm successful completion of the current course.");

  await page.unroute("**/api/majors/map");
  const advisor = fixturePlan({
    readinessStatus: "ADVISOR_ACTION_REQUIRED",
    planDisposition: "COMPLETE_ADVISOR_ACTION_REQUIRED",
    advisorActions: [{ code: "ADVISOR_APPROVAL", message: "Meet with your advisor to confirm this approval." }]
  });
  await openFixtureResult(page, plannerResultFixture({ plans: [advisor] }));
  await expect(page.locator(".result-status-value")).toHaveText("Needs advisor attention");
  await expect(page.locator("[data-plan-conditions]")).toContainText("Meet with your advisor to confirm this approval.");
});
