import { selectedPlanCard, visitPlan } from "./cp7-helpers.js";
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  courseOccurrences, projectReportHtmlArtifact, projectReportJsonArtifact, projectSelectedPlanArtifact, projectionMismatches
} from "../oracle/economics-artifact-projection.js";
import {
  resetPlanner, reloadPlanner, chooseStanding, continueToCourses, generatePlans, setCourseStatus
} from "./cp7-helpers.js";

// These journeys include generation, edits and server revalidation of all saved plans.
// Keep a bounded journey budget while retaining each state and rejection assertion.
test.beforeEach(() => test.setTimeout(60000));

async function openPlan(page, standing, { early = false, completed = [], date = "2026-09-23", graduationYear = null } = {}) {
  await resetPlanner(page);
  await chooseStanding(page, standing);
  await page.locator("details.more-details > summary").first().click();
  await page.getByLabel("Plan creation date", { exact: true }).fill(date);
  if (early) await page.getByRole("button", { name: standing === "junior" ? "I’d like to graduate next year" : "I’d like to graduate one year early", exact: true }).click();
  if (graduationYear) {
    await page.getByRole("button", { name: "My expected graduation year is different", exact: true }).click();
    await page.getByRole("combobox", { name: "When do you expect to graduate?", exact: true }).selectOption(graduationYear);
  }
  await continueToCourses(page);
  for (const code of completed) {
    if (!await page.getByRole("group", { name: `Status for ${code}`, exact: true }).isVisible()) {
      await page.getByRole("searchbox", { name: "Search courses", exact: true }).fill(code);
    }
    await setCourseStatus(page, code, "Completed");
    await page.getByRole("searchbox", { name: "Search courses", exact: true }).fill("");
  }
  const response = await generatePlans(page);
  expect(response.status()).toBe(200);
  const result = await response.json();
  const plans = result.programs.find(item => item.program.id === "economics-base").economicsPlans;
  const selected = plans.find(plan => plan.id === (early && standing !== "junior" ? "one-year-early" : "balanced"));
  expect(selected).toBeTruthy();
  await visitPlan(page, selected.id);
  return { selected, plans, student: response.request().postDataJSON().student, planCard: selectedPlanCard(page) };
}

function card(page, code) {
  const plan = selectedPlanCard(page);
  return plan.locator(`.comparison-editable-course:has(button[aria-label^="Change ${code}"])`).first();
}

function termRow(scope, selector = "") {
  const plan = typeof scope.url === "function" ? selectedPlanCard(scope) : scope;
  return plan.locator(`.compact-schedule tr[data-term-id]${selector}`);
}

async function visibleCourseCodes(plan) {
  return plan.locator('.comparison-editable-course button[aria-label^="Change "], .comparison-editable-course .comparison-fixed-course > strong')
    .evaluateAll(nodes => nodes.map(node => node.textContent.replace(/\s*▾$/, "").trim().replace(/-[A-Z]$/, "")));
}

async function visibleSchedule(plan) {
  return plan.locator(".compact-schedule tr[data-term-id]").evaluateAll(rows => rows.map(row => ({
    termId: row.dataset.termId,
    courses: [...row.querySelectorAll(".comparison-editable-course button[aria-label^='Change '], .comparison-editable-course .comparison-fixed-course > strong")]
      .map(node => node.textContent.replace(/\s*▾$/, "").trim().replace(/-[A-Z]$/, ""))
  })));
}

function moveControl(scope, code) {
  const plan = typeof scope.url === "function" ? selectedPlanCard(scope) : scope;
  return plan.locator(`.plan-course-actions[aria-label^="Changes for ${code}"]`);
}

async function applyMove(control, destination) {
  const actions = control;
  const change = actions.getByRole("button", { name: /^Change / });
  if (await change.getAttribute("aria-expanded") !== "true") await change.click();
  const option = control.locator(`[data-change-choice="move:${destination}"]`);
  const conditional = await option.getAttribute("data-change-status") === "CONDITIONAL";
  await option.click();
  if (conditional) {
    const apply = actions.getByRole("button", { name: "Apply change", exact: true });
    await expect(apply).toBeVisible();
    await apply.click();
  }
}

async function showChanges(page, code) {
  const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const button = page.getByRole("button", { name: new RegExp(`^Change ${escaped}(?:-[A-Z])?$`) }).first();
  if (await button.getAttribute("aria-expanded") !== "true") await button.click();
}

function validationResponse(page) {
  return page.waitForResponse(response => response.url().endsWith("/api/majors/map")
    && response.request().postDataJSON()?.action === "validate-plan");
}

test("interrupted saved validation keeps edited plans recoverable and retry restores selection and undo", async ({ page }) => {
  await openPlan(page, "freshman", { early: true });
  const control = moveControl(page, "MAT 217");
  const moved = validationResponse(page);
  await applyMove(control, "winter-2027");
  expect((await moved).status()).toBe(200);
  await expect(control).toHaveAttribute("data-current-term", "move:winter-2027");
  const original = await page.evaluate(() => sessionStorage.getItem("econ-planner-generated-session"));
  await page.clock.install();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let held = 0;
  await page.route("**/api/majors/map", async route => {
    if (route.request().postDataJSON()?.action === "validate-plan") {
      held += 1;
      await gate;
    }
    await route.continue().catch(() => {});
  });
  await page.reload();
  await expect.poll(() => held).toBe(1);
  await expect(page.getByRole("status")).toContainText("Checking saved plans: 1 of 4");
  await page.clock.fastForward(16000);
  await expect(page.locator(".planner-loading")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("econ-planner-generated-session"))).toBe(original);
  await page.clock.fastForward(15000);
  await expect(page.locator(".summary-status")).toContainText("Your saved plans and edits are kept");
  await expect(control).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("econ-planner-generated-session"))).toBe(original);
  release();
  await page.unrouteAll({ behavior: "wait" });
  await page.getByRole("button", { name: "Retry saved plans", exact: true }).click();
  await expect(control).toHaveAttribute("data-current-term", "move:winter-2027", { timeout: 30000 });
  await expect(page.getByRole("button", { name: "Undo last plan edit" })).toBeVisible();
  await reloadPlanner(page);
  await expect(control).toHaveAttribute("data-current-term", "move:winter-2027");
  await page.getByRole("button", { name: "Undo last plan edit" }).click();
  await reloadPlanner(page);
  await expect(control).toHaveAttribute("data-current-term", "move:spring-2027");
});

test("a slow validation beyond the former deadline completes with progress and restores all plans", async ({ page }) => {
  await openPlan(page, "sophomore", { early: true });
  const original = await page.evaluate(() => sessionStorage.getItem("econ-planner-generated-session"));
  await page.clock.install();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let held = 0;
  await page.route("**/api/majors/map", async route => {
    if (route.request().postDataJSON()?.action === "validate-plan" && ++held === 1) await gate;
    await route.continue().catch(() => {});
  });
  await page.reload();
  await expect.poll(() => held).toBe(1);
  await page.clock.fastForward(16000);
  await expect(page.getByRole("status")).toContainText("Checking saved plans: 1 of 3");
  expect(await page.evaluate(() => sessionStorage.getItem("econ-planner-generated-session"))).toBe(original);
  release();
  await expect(selectedPlanCard(page).locator("[data-major-requirements-checklist]")).toBeVisible({ timeout: 30000 });
  await page.unrouteAll({ behavior: "wait" });
  expect(held).toBe(3);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("econ-planner-generated-session")).selectedPlanId)).toBe("one-year-early");
});

test("temporary policy verification failure survives reload, while obsolete and invalid saved plans require regeneration", async ({ page }) => {
  await openPlan(page, "sophomore", { early: true });
  const original = await page.evaluate(() => sessionStorage.getItem("econ-planner-generated-session"));
  await page.route("**/api/majors/map", route => route.fulfill({ status: 503, body: "temporarily unavailable" }));
  for (let reload = 0; reload < 2; reload += 1) {
    await reloadPlanner(page);
    await expect(page.getByRole("button", { name: "Retry saved plans", exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("econ-planner-generated-session"))).toBe(original);
  }
  await page.unrouteAll();
  await page.getByRole("button", { name: "Retry saved plans", exact: true }).click();
  await expect(selectedPlanCard(page).locator("[data-major-requirements-checklist]")).toBeVisible({ timeout: 30000 });
  await page.evaluate(() => {
    const key = "econ-planner-generated-session";
    const saved = JSON.parse(sessionStorage.getItem(key));
    saved.plannerFingerprint = "sha256:obsolete";
    sessionStorage.setItem(key, JSON.stringify(saved));
  });
  await reloadPlanner(page);
  await expect(page.locator(".summary-status")).toContainText("Generate new plans");
  expect(await page.evaluate(() => sessionStorage.getItem("econ-planner-generated-session"))).toBeNull();
  await page.evaluate(raw => sessionStorage.setItem("econ-planner-generated-session", raw), original);
  await page.route("**/api/majors/map", route => route.request().method() === "POST"
    ? route.fulfill({ status: 422, json: { error: "Saved assignment fails academic validation" } }) : route.continue());
  await reloadPlanner(page);
  await expect(page.locator(".summary-status")).toContainText("does not pass current academic checks");
  expect(await page.evaluate(() => sessionStorage.getItem("econ-planner-generated-session"))).toBeNull();
});

test("late restoration responses cannot overwrite changed answers and newly generated plans", async ({ page }) => {
  await openPlan(page, "sophomore", { early: true });
  await page.route("**/api/majors/map", route => route.fulfill({ status: 503, body: "unavailable" }));
  await reloadPlanner(page);
  await page.unrouteAll();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let held = 0;
  await page.route("**/api/majors/map", async route => {
    if (route.request().postDataJSON()?.action !== "validate-plan") return route.continue();
    const response = await route.fetch();
    held += 1;
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole("button", { name: "Retry saved plans", exact: true }).click();
  await expect.poll(() => held).toBe(1);
  await setCourseStatus(page, "ECO 113", "Completed");
  const generated = await generatePlans(page);
  expect(generated.status()).toBe(200);
  release();
  await page.unrouteAll({ behavior: "wait" });
  await visitPlan(page, "balanced");
  await expect(selectedPlanCard(page).locator('[data-requirement-checklist-id="eco-113"]')).toContainText("Completed");
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem("econ-planner-generated-session")));
  expect(saved.selectedPlanId).toBe("balanced");
  expect(saved.report.programs.find(program => program.economicsPlans).economicsPlans[0].majorRequirementsChecklist.rows[0].status).toBe("completed");
});

test("each plan selection, requirement states and notes survive repeated reloads", async ({ page }) => {
  const { plans } = await openPlan(page, "sophomore", { early: true, completed: ["ECO 113", "MAT 113", "ECO 161"] });
  for (const plan of plans) {
    await visitPlan(page, plan.id);
    for (let reload = 0; reload < 2; reload += 1) {
      await reloadPlanner(page);
      const planCard = selectedPlanCard(page);
      await expect(planCard.locator('[data-requirement-checklist-id="eco-113"]')).toContainText("Completed");
      await expect(planCard.locator("[data-requirement-checklist-id]")).toHaveCount(12);
      expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("econ-planner-generated-session")).selectedPlanId)).toBe(plan.id);
      await planCard.getByText("More about this plan", {exact:true}).click();
      await expect(planCard.getByRole("heading", { name: "Published schedules as of the plan date (September 23, 2026)", exact: true })).toBeVisible();
      await expect(planCard.locator('[data-plan-note="history"]')).toHaveCount(0);
    }
  }
});

test("malformed edit requests preserve the saved plan and allow a later valid move", async ({ page }) => {
  await openPlan(page, "freshman", { early: true });
  const control = moveControl(page, "MAT 217");
  await page.route("**/api/majors/map", route => route.continue({ postData: '{"action":"validate-plan",' }), { times: 1 });
  const rejected = page.waitForResponse(response => response.url().endsWith("/api/majors/map"));
  await applyMove(control, "winter-2027");
  expect((await rejected).status()).toBe(400);
  await expect(termRow(page, '[data-term-id="spring-2027"]')).toContainText("MAT 217");
  await expect(selectedPlanCard(page).locator(".comparison-edit-status")).toContainText("invalid JSON");
  await reloadPlanner(page);
  await expect(control).toHaveAttribute("data-current-term", "move:spring-2027");
  const accepted = validationResponse(page);
  await applyMove(control, "winter-2027");
  expect((await accepted).status()).toBe(200);
  await expect(control).toHaveAttribute("data-current-term", "move:winter-2027");
  await reloadPlanner(page);
  await expect(control).toHaveAttribute("data-current-term", "move:winter-2027");
});

test("move selectors, rejection feedback, successful move, undo, and reload agree", async ({ page }) => {
  const { selected, student, plans } = await openPlan(page, "freshman", { early: true });
  const core = moveControl(page, "MAT 217");
  const course = selected.terms.flatMap(term => term.courses).find(course => course.course === "MAT 217");
  expect(await core.locator('[data-change-choice^="move:"]').evaluateAll(options => options.map(option => option.dataset.changeChoice.replace("move:", ""))))
    .toEqual([...course.moveDestinationIds.filter(id => id !== course.moveDestinationOptions.find(option => option.status === "CURRENT").id)]);
  expect(await core.locator('[data-change-choice^="move:"]').evaluateAll(options => options.filter(option => !option.disabled).map(option => option.dataset.changeChoice.replace("move:", ""))))
    .toEqual([...course.moveDestinationIds.filter(id => id !== course.moveDestinationOptions.find(option => option.status === "CURRENT").id)]);
  const unsupportedWinter = core.locator('button[data-change-choice="move:winter-2029"]');
  await expect(unsupportedWinter).toHaveCount(0);

  await expect(selectedPlanCard(page).getByRole("button", {name:"Change Economics elective (200 level or higher)",exact:true}).first()).toBeVisible();
  await expect(selectedPlanCard(page).getByRole("button", {name:"Change ECO 461",exact:true})).toHaveCount(0);

  const directRejection = await page.request.post("/api/majors/map", { data: {
    action: "validate-plan", student, plan: selected, plans,
    edit: { type: "move", planId: selected.id, fromTermId: "winter-2027", toTermId: "fall-2027", courseId: "eco-113" }
  } });
  expect(directRejection.status()).toBe(422);
  await expect(selectedPlanCard(page).getByRole("button", { name: "Undo last plan edit" })).toHaveCount(0);

  const statistics = moveControl(page, "MAT 217");
  const movedResponse = validationResponse(page);
  await applyMove(statistics, "winter-2027");
  const moved = await movedResponse;
  expect(moved.status()).toBe(200);
  const movedPlan = (await moved.json()).plan;
  const refreshedStatistics = movedPlan.terms.flatMap(term => term.courses).find(course => course.course === "MAT 217");
  expect(refreshedStatistics.moveDestinationOptions.map(option => option.id)).toEqual(movedPlan.terms.map(term => term.slotId));
  expect(refreshedStatistics.moveDestinationIds).toContain("winter-2027");
  expect(movedPlan.terms.find(term => term.slotId === "winter-2027").courses.some(course => course.course === "MAT 217")).toBe(true);
  await expect(page.locator("main")).not.toContainText("Seat availability for MAT 217-S was last checked");
  await expect(termRow(page, '[data-term-id="spring-2027"]')).not.toContainText("MAT 217");
  await expect(card(page, "ECO 113").getByRole("alert")).toHaveCount(0);
  const visibleCodes = await visibleCourseCodes(selectedPlanCard(page));
  expect(visibleCodes.sort()).toEqual(movedPlan.terms.flatMap(term => term.courses.map(course => course.course === "ECO elective" && course.minimumLevel >= 200 ? "Economics elective (200 level or higher)" : course.course)).sort());
  const reportInput = {
    student: moved.request().postDataJSON().student,
    preparedDate: "2026-09-23",
    selectedPlan: movedPlan,
    plans: moved.request().postDataJSON().plans
  };
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
  await selectedPlanCard(page).getByRole("button", { name: "Undo last plan edit" }).click();
  await expect(moveControl(page, "MAT 217")).toHaveAttribute("data-current-term", "move:spring-2027");
  await expect(moveControl(page, "MAT 217").locator('button[data-change-choice="move:spring-2028"]'))
    .toHaveCount(0);

  const savedResponse = validationResponse(page);
  await applyMove(moveControl(page, "MAT 217"), "winter-2027");
  expect((await savedResponse).status()).toBe(200);
  await expect(moveControl(page, "MAT 217")).toHaveAttribute("data-current-term", "move:winter-2027");
  await reloadPlanner(page);
  await expect(moveControl(page, "MAT 217")).toHaveAttribute("data-current-term", "move:winter-2027");
  await visitPlan(page, "balanced");
  await visitPlan(page, "one-year-early");
  await expect(moveControl(page, "MAT 217")).toHaveAttribute("data-current-term", "move:winter-2027");
  expect(reportParity).toEqual([]);
});

test("after an elective replacement the May 2027 card still rejects an unsupported move", async ({ page }) => {
  const { student, plans } = await openPlan(page, "senior", {
    date: "2026-07-30",
    completed: ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "BUSN 323"]
  });
  const may = termRow(page, '[data-term-id="spring-2027"]');
  await expect(may).toContainText("ECO 222");
  await expect(may.locator(".comparison-editable-course")).toHaveCount(1);
  await may.getByRole("button", {name:/^Change ECO 222(?:-[A-Z])?$/}).click();
  const replacement = moveControl(may, "ECO 222");
  const response = validationResponse(page);
  await replacement.locator('[data-change-choice="replace:spring-2027:ECO 224"]').click();
  await may.getByRole("button", {name:"Apply change",exact:true}).click();
  const replacementResponse = await response;
  expect(replacementResponse.status()).toBe(200);
  const updatedPlan = (await replacementResponse.json()).plan;
  await expect(may).toContainText("ECO 224");
  await expect(may.locator(".comparison-editable-course")).toHaveCount(1);
  const updatedElective = updatedPlan.terms.find(term => term.slotId === "spring-2027").courses.find(course => course.course === "ECO 224");
  expect(updatedElective.alternativeOptions.some(option => option.course === "ECO 222"
    && ["ALLOWED", "CONDITIONAL"].includes(option.status))).toBe(true);
  expect(updatedElective.moveDestinationOptions.some(option => option.status === "BLOCKED")).toBe(true);
  await expect(moveControl(page, "ECO 224")).toHaveCount(1);
  await expect(card(page, "ECO 224").locator('button[data-change-choice^="move:"]')).toHaveCount(0);
  await selectedPlanCard(page).getByRole("button", { name: "Undo last plan edit" }).click();
  await expect(may).toContainText("ECO 222");
  await reloadPlanner(page);
  await expect(termRow(page, '[data-term-id="spring-2027"]')).toContainText("ECO 222");
  const mayTerm = updatedPlan.terms.find(term => term.slotId === "spring-2027");
  const elective = mayTerm.courses.find(course => course.course === "ECO 224");
  const selected = await page.request.post("/api/majors/map", {
    data: {
      action: "validate-plan", student, plan: updatedPlan,
      plans: plans.map(plan => plan.id === updatedPlan.id ? updatedPlan : plan),
      edit: { type: "move", planId: updatedPlan.id, fromTermId: mayTerm.slotId,
        toTermId: "winter-2027", courseId: elective.requirementId }
    }
  });
  expect(selected.status()).toBe(422);
  expect((await selected.json()).error).toMatch(/no verified, conflict-free section in Winter 2027/);
});

test("move controls stay disabled during an outstanding validation request", async ({ page }) => {
  const { selected } = await openPlan(page, "freshman", { early: true });
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
  const first = moveControl(page, "MAT 217");
  const second = moveControl(page, "ECO 114");
  expect(selected.terms.flatMap(term => term.courses).find(course => course.course === "ECO 114").moveDestinationIds)
    .toContain("fall-2027");
  const response = validationResponse(page);
  await applyMove(first, "winter-2027");
  await expect(first.getByRole("button", { name: /^Change / })).toBeDisabled();
  await expect(second.getByRole("button", { name: /^Change / })).toBeDisabled();
  release();
  expect((await response).status()).toBe(200);
  await expect(selectedPlanCard(page).locator(".comparison-edit-status")).toContainText("Moved to");
  expect(validationRequests).toBe(1);
});

test("a move error remains readable and announced at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPlan(page, "freshman", { early: true });
  const control = moveControl(page, "MAT 217");
  await showChanges(page, "MAT 217");
  await control.getByRole("button", { name: /^Change / }).focus();
  await page.route("**/api/majors/map", route => route.fulfill({
    status: 422,
    contentType: "application/json",
    body: JSON.stringify({ error: "That plan change cannot be saved. The selected term fails complete plan validation." })
  }), { times: 1 });
  const response = validationResponse(page);
  await applyMove(control, "winter-2027");
  expect((await response).status()).toBe(422);
  const feedback = selectedPlanCard(page).locator(".comparison-edit-status");
  await expect(feedback).toBeVisible();
  await expect(feedback).toContainText("fails complete plan validation");
  await expect(card(page, "MAT 217").locator('[data-change-choice="move:winter-2027"]')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const accessibility = await new AxeBuilder({ page }).include(".comparison-edit-status")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
});

for (const scenario of [
  { code: "ECO 461", options: { graduationYear: "2031" }, from: "winter-2030", to: "winter-2031" },
  { code: "ECO elective", options: { early: true }, from: "fall-2027", to: "fall-2028" }
]) test(`ordinary freshman ${scenario.code === "ECO elective" ? "cannot move" : "can move"} ${scenario.code} from ${scenario.from} to ${scenario.to}`, async ({ page }) => {
  const { selected, plans, student } = await openPlan(page, "freshman", scenario.options);
  const control = moveControl(page, scenario.code === "ECO elective" ? "Economics elective (200 level or higher)" : scenario.code).first();
  if (scenario.code === "ECO elective") {
    await expect(control).toHaveCount(1);
    const source = selected.terms.find(term => term.slotId === scenario.from);
    const course = source.courses.find(item => item.course === scenario.code);
    const rejected = await page.request.post("/api/majors/map", { data: {
      action: "validate-plan", student, plan: selected, plans,
      edit: { type: "move", planId: selected.id, fromTermId: source.slotId, toTermId: scenario.to, courseId: course.requirementId }
    } });
    expect(rejected.status()).toBe(422);
    expect((await rejected.json()).error).toMatch(/May|term|offering/i);
    return;
  }
  await expect(control).toHaveAttribute("data-current-term", `move:${scenario.from}`);
  await expect(control.locator(`button[data-change-choice="move:${scenario.to}"]`)).toBeEnabled();
  if (scenario.code === "ECO 461") {
    await expect(control.locator('button[data-change-choice="move:winter-2029"]')).toHaveCount(0);
    await expect(card(page, "ECO 461")).toContainText(/senior|standing/i);
    const source = selected.terms.find(term => term.slotId === scenario.from);
    const course = source.courses.find(item => item.course === scenario.code);
    const rejected = await page.request.post("/api/majors/map", { data: {
      action: "validate-plan", student, plan: selected, plans,
      edit: { type: "move", planId: selected.id, fromTermId: source.slotId, toTermId: "winter-2029", courseId: course.requirementId }
    } });
    expect(rejected.status()).toBe(422);
    expect((await rejected.json()).error).toMatch(/valid senior Winter slot/);
  }
  const response = validationResponse(page);
  await applyMove(control, scenario.to);
  const saved = await response;
  expect(saved.status()).toBe(200);
  const plan = (await saved.json()).plan;
  const moved = plan.terms.find(term => term.slotId === scenario.to).courses.find(course => course.course === scenario.code);
  expect(moved).toBeTruthy();
  expect(moved.section).toBe("");
  expect(moved.availability).toBeNull();
  expect(moved.meeting).toBeNull();
  expect(moved.preliminaryScheduleEvidence).toBeUndefined();
  if (scenario.code === "ECO elective") expect(moved.source).toBe("projected-offering");
  const before = selected.terms.flatMap(term => term.courses.map(course => `${course.requirementId}:${term.slotId}`)).sort();
  const after = plan.terms.flatMap(term => term.courses.map(course => `${course.requirementId}:${term.slotId}`)).sort();
  expect(after).toEqual(before.map(value => value === `${moved.requirementId}:${scenario.from}` ? `${moved.requirementId}:${scenario.to}` : value).sort());
  await expect(page.locator(".projection-readiness-note")).toHaveCount(0);
  await reloadPlanner(page);
  await expect(control).toHaveAttribute("data-current-term", `move:${scenario.to}`);
  const input = { student, preparedDate: "2026-09-23", selectedPlan: plan };
  const json = await page.request.post("/api/reports/economics", { data: { ...input, format: "json" } });
  expect(json.status()).toBe(200);
  const report = await json.json();
  const expected = projectSelectedPlanArtifact(plan, { advisorNotices: report.catalog?.advisorAttention || [] });
  expect(projectionMismatches(expected, projectReportJsonArtifact(report))).toEqual([]);
  const html = await page.request.post("/api/reports/economics", { data: { ...input, format: "html" } });
  expect(html.status()).toBe(200);
  const htmlProjection = projectReportHtmlArtifact(await html.text());
  // HTML includes empty calendar terms omitted by the selected-plan JSON.
  const occupied = projection => ({ ...projection, terms: projection.terms.filter(term => term.courses.length) });
  expect(projectionMismatches(occupied(expected), occupied(htmlProjection))).toEqual([]);
});

test("completed prerequisite timing does not allow a standard freshman capstone in junior Winter", async ({ page }) => {
  const { selected, student } = await openPlan(page, "freshman");
  const control = moveControl(page, "ECO 461");
  await expect(control.locator("[data-change-choice]")).toHaveCount(0);
  const originalSchedule = await visibleSchedule(selectedPlanCard(page));
  const capstone = selected.terms.flatMap(term => term.courses.map(course => ({ term, course })))
    .find(item => item.course.course === "ECO 461");
  const rejected = await page.request.post("/api/majors/map", { data: {
    action: "validate-plan", student,
    plan: selected, edit: { type: "move", planId: selected.id, fromTermId: capstone.term.slotId,
      toTermId: "winter-2029", courseId: capstone.course.requirementId }
  } });
  expect(rejected.status()).toBe(422);
  expect((await rejected.json()).error).toContain("not in a valid senior Winter slot");
  await expect(page.getByRole("button", { name: "Undo last plan edit" })).toHaveCount(0);
  await reloadPlanner(page);
  await expect(page.getByRole("button", {name:"Change ECO 461",exact:true})).toHaveCount(0);
  expect(await visibleSchedule(selectedPlanCard(page))).toEqual(originalSchedule);
  expect(selected.id).toBe("balanced");
});

test("OD8: one remaining senior course starts in the earliest eligible Winter and can move back", async ({ page }) => {
  const { selected, student, plans } = await openPlan(page, "senior", {
    date: "2026-09-23",
    graduationYear: "2028",
    completed: ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "BUSN 323", "ECO 221", "ECO 222", "ECO 234", "ECO 333"]
  });
  const control = moveControl(page, "ECO 461");
  await expect(control).toHaveAttribute("data-current-term", "move:winter-2027");
  await expect(control.locator('button[data-change-choice="move:winter-2028"]')).toBeEnabled();
  const original = selected.terms.find(term => term.slotId === "winter-2027").courses.find(course => course.course === "ECO 461");
  expect(original.source).toBe("verified-offering");
  expect(selected.preferredDistributionException).toBeNull();
  expect(selected.annualDistributionException).toBeNull();

  const accepted = validationResponse(page);
  await applyMove(control, "winter-2028");
  const response = await accepted;
  expect(response.status()).toBe(200);
  const edited = (await response.json()).plan;
  const capstone = edited.terms.find(term => term.slotId === "winter-2028").courses
    .find(course => course.course === "ECO 461");
  expect(capstone).toBeTruthy();
  expect(edited.validation.valid).toBe(true);

  const movedBackResponse = validationResponse(page);
  await applyMove(moveControl(page, "ECO 461"), "winter-2027");
  const movedBack = (await movedBackResponse).json();
  expect((await movedBack).plan.terms.find(term => term.slotId === "winter-2027").courses.find(course => course.course === "ECO 461").source).toBe("verified-offering");
  const direct = await page.request.post("/api/majors/map", { data: {
    action: "validate-plan", student, plan: selected, plans,
    edit: { type: "move", planId: selected.id, fromTermId: "winter-2027", toTermId: "winter-2028", courseId: original.requirementId }
  } });
  expect(direct.status()).toBe(200);
});

test("Generic elective May moves, one-elective limits, persistence, and concise reports agree", async ({ page }) => {
  const { plans, student } = await openPlan(page, "freshman", { early: true });
  const spring2029 = termRow(page, '[data-term-id="spring-2029"]');
  const makeRoom = moveControl(spring2029, "Economics elective (200 level or higher)");
  await expect(makeRoom.locator('button[data-change-choice="move:winter-2029"]')).toBeEnabled();
  const freeMayResponse = validationResponse(page);
  await applyMove(makeRoom, "winter-2029");
  const freeMay = await freeMayResponse;
  expect(freeMay.status()).toBe(200);
  const planWithFreeMay = (await freeMay.json()).plan;
  const updatedPlans = plans.map(plan => plan.id === planWithFreeMay.id ? planWithFreeMay : plan);
  const eco222 = planWithFreeMay.terms.flatMap(term => term.courses.map(course => ({ term, course })))
    .find(item => item.term.slotId === "spring-2028" && item.course.course === "ECO elective");
  expect(eco222.course.moveDestinationOptions.find(option => option.id === "spring-2029").status).toBe("CONDITIONAL");
  expect(eco222.course.moveDestinationOptions.find(option => option.id === "spring-2029").message).toMatch(/exact schedule has not been published/i);

  const control = moveControl(termRow(page, '[data-term-id="spring-2028"]'), "Economics elective (200 level or higher)");
  await expect(control.locator('button[data-change-choice="move:spring-2029"]')).toBeEnabled();
  await control.getByRole("button", { name: /^Change / }).click();
  await expect(control.locator('.change-menu-option[data-change-choice="move:spring-2029"] small')).toHaveCount(0);
  await expect(control.locator('.change-confirm-warning')).toHaveText('Schedule not yet published.');
  await expect(control.locator('button[data-change-choice="move:winter-2029"]')).toHaveCount(0);
  const unsupportedWinter = await page.request.post("/api/majors/map", { data: {
    action: "validate-plan", student, plan: planWithFreeMay, plans: updatedPlans,
    edit: { type: "move", planId: planWithFreeMay.id, fromTermId: eco222.term.slotId,
      toTermId: "winter-2029", courseId: eco222.course.requirementId }
  } });
  expect(unsupportedWinter.status()).toBe(422);

  const acceptedResponse = validationResponse(page);
  await applyMove(control, "spring-2029");
  const accepted = await acceptedResponse;
  expect(accepted.status()).toBe(200);
  const movedPlan = (await accepted.json()).plan;
  const movedECO222 = movedPlan.terms.find(term => term.slotId === "spring-2029").courses.find(course => course.course === "ECO elective");
  expect(["catalog-statement", "projected-offering"]).toContain(movedECO222.source);
  expect(movedECO222.moveGuidance.studentMessage).toMatch(/Conditional move choices|No other term/i);
  const persistedGuidance = movedECO222.moveGuidance.studentMessage;

  await reloadPlanner(page);
  await expect(moveControl(spring2029, "Economics elective (200 level or higher)")).toHaveAttribute("data-current-term", "move:spring-2029");
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("econ-planner-generated-session")).report.programs
    .find(program => program.economicsPlans).economicsPlans.find(plan => plan.id === "one-year-early").terms
    .find(term => term.slotId === "spring-2029").courses.find(course => course.course === "ECO elective").moveGuidance.studentMessage)).toBe(persistedGuidance);
  const reportPlans = updatedPlans.map(plan => plan.id === movedPlan.id ? movedPlan : plan);
  const reportInput = { student, preparedDate: "2026-09-23", selectedPlan: movedPlan, plans: reportPlans };
  const reportResponse = await page.request.post("/api/reports/economics", { data: { ...reportInput, format: "json" } });
  expect(reportResponse.status()).toBe(200);
  const report = await reportResponse.json();
  const reportECO222 = report.terms.find(term => term.slotId === "spring-2029").courses.find(course => course.code === "ECO elective");
  expect(reportECO222.moveGuidance.studentMessage).toBe(persistedGuidance);
  expect(report.catalog.advisorAttention.some(notice => notice.message.includes(`ECO elective: ${persistedGuidance}`))).toBe(false);
  const htmlResponse = await page.request.post("/api/reports/economics", { data: { ...reportInput, format: "html" } });
  expect(htmlResponse.status()).toBe(200);
  const html = await htmlResponse.text();
  expect(html).not.toContain(persistedGuidance);
  const expected = projectSelectedPlanArtifact(movedPlan, { advisorNotices: report.catalog?.advisorAttention || [] });
  expect(projectionMismatches(expected, projectReportJsonArtifact(report))).toEqual([]);
  const occupied = projection => ({ ...projection, terms: projection.terms.filter(term => term.courses.length) });
  expect(projectionMismatches(occupied(expected), occupied(projectReportHtmlArtifact(html)))).toEqual([]);
});

test("MAT 217 can move to an unpublished May and persist in the selected plan", async ({ page }) => {
  const { selected } = await openPlan(page, "sophomore", {
    date: "2027-07-30",
    completed: ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "BUSN 323", "ECO 221", "ECO 222", "ECO 234", "ECO 333"]
  });
  const control = moveControl(page, "MAT 217");
  const original = selected.terms.find(term => term.courses.some(course => course.course === "MAT 217"));
  expect(original.slotId).not.toBe("spring-2028");
  await expect(control.locator('button[data-change-choice="move:spring-2028"]')).toHaveCount(1);
  const response = validationResponse(page);
  await applyMove(control, "spring-2028");
  const saved = await response;
  expect(saved.status()).toBe(200);
  const plan = (await saved.json()).plan;
  const course = plan.terms.find(term => term.slotId === "spring-2028").courses.find(course => course.course === "MAT 217");
  expect(course.source).toBe("projected-offering");
  expect(course.section).toBe("");
  await reloadPlanner(page);
  await expect(control).toHaveAttribute("data-current-term", "move:spring-2028");
  await expect(page.locator(".projection-readiness-note")).toHaveCount(0);
});

test("unpublished intermediate dropdowns omit the counterpart's occupied term in both directions", async ({ page }) => {
  const { selected } = await openPlan(page, "sophomore", {
    date: "2027-07-30", completed: ["ECO 113", "ECO 114", "MAT 113", "MAT 217"]
  });
  for (const [code, counterpart] of [["ECO 213", "ECO 214"], ["ECO 214", "ECO 213"]]) {
    const own = selected.terms.find(term => term.courses.some(course => course.course === code));
    const other = selected.terms.find(term => term.courses.some(course => course.course === counterpart));
    expect(own.slotId).not.toBe(other.slotId);
    const control = moveControl(page, code);
    await expect(control).toHaveAttribute("data-current-term", `move:${own.slotId}`);
    const counterpartOption = control.locator(`button[data-change-choice="move:${other.slotId}"]`);
    await expect(counterpartOption).toHaveCount(0);

    const course = own.courses.find(course => course.course === code);
    expect(await control.locator("[data-change-choice^=\"move:\"]").evaluateAll(options => options.map(option => option.dataset.changeChoice.replace("move:", ""))))
      .toEqual([...course.moveDestinationIds.filter(id => id !== course.moveDestinationOptions.find(option => option.status === "CURRENT").id)]);
    expect(await control.locator("[data-change-choice^=\"move:\"]").evaluateAll(options => options.filter(option => !option.disabled).map(option => option.dataset.changeChoice.replace("move:", ""))))
      .toEqual([...course.moveDestinationIds.filter(id => id !== course.moveDestinationOptions.find(option => option.status === "CURRENT").id)]);
  }
});

test("pre-offering sessions regenerate while preserving saved course answers", async ({ page }) => {
  await openPlan(page, "freshman", { early: true, completed: ["ECO 113"] });
  await page.evaluate(() => {
    const key = "econ-planner-generated-session";
    const saved = JSON.parse(sessionStorage.getItem(key));
    saved.schemaVersion = 8;
    for (const program of saved.report.programs) for (const plan of program.economicsPlans || []) {
      for (const term of plan.terms) for (const course of term.courses) delete course.moveDestinationIds;
    }
    sessionStorage.setItem(key, JSON.stringify(saved));
  });
  await reloadPlanner(page);
  await expect(page.getByText("Your saved answers are kept. Generate new plans to check them against the current policy and schedule.", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Status for ECO 113", exact: true })
    .getByRole("button", { name: "Completed", exact: true })).toHaveAttribute("aria-pressed", "true");
  await generatePlans(page);
  await visitPlan(page, "one-year-early");
  const control = moveControl(page, "MAT 217");
  await expect.poll(() => control.locator("[data-change-choice^=\"move:\"]").count()).toBeGreaterThan(1);
  await reloadPlanner(page);
  await expect.poll(() => control.locator("[data-change-choice^=\"move:\"]").count()).toBeGreaterThan(1);
});

for (const outcome of ["accepted", "rejected"]) {
  test(`a delayed ${outcome} edit cannot change a regenerated report or its undo`, async ({ page }) => {
    await openPlan(page, "freshman", { early: true });
    const statistics = moveControl(page, "MAT 217");
    const firstMove = validationResponse(page);
    await applyMove(statistics, "winter-2027");
    expect((await firstMove).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Undo last plan edit" })).toBeVisible();

    // Model a transport that completes despite cancellation, so this tests the
    // response-context guard as well as the normal AbortController path.
    await page.evaluate(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const isEdit = typeof init?.body === "string" && JSON.parse(init.body).action === "validate-plan";
        const response = await originalFetch(input, isEdit ? { ...init, signal: undefined } : init);
        if (isEdit) {
          const readJson = response.json.bind(response);
          response.json = async () => {
            const data = await readJson();
            requestAnimationFrame(() => requestAnimationFrame(() => { window.delayedEditConsumed = true; }));
            return data;
          };
        }
        return response;
      };
    });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let received;
    const intercepted = new Promise(resolve => { received = resolve; });
    await page.route("**/api/majors/map", async route => {
      if (route.request().method() !== "POST" || route.request().postDataJSON()?.action !== "validate-plan") return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      received();
      await held;
      if (outcome === "accepted") await route.fulfill({ response });
      else await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: "That plan change cannot be saved. The selected term fails complete plan validation." })
      });
    });
    if (outcome === "accepted") await applyMove(statistics, "spring-2027");
    else await applyMove(moveControl(page, "ECO 114"), "fall-2027");
    await intercepted;
    await page.getByRole("navigation", { name: "Planner progress" }).getByRole("button", { name: "Your courses", exact: true }).click();
    await page.getByRole("button", { name: "Back to about you", exact: true }).click();
    const date = page.getByLabel("Plan creation date", { exact: true });
    if (!await date.isVisible()) await page.locator("details.more-details > summary").first().click();
    await date.fill("2027-09-23");
    await continueToCourses(page);
    await generatePlans(page);
    await visitPlan(page, "one-year-early");
    await expect(statistics).toHaveAttribute("data-current-term", "move:spring-2028");
    const visibleReport = await page.locator("main").innerText();
    const savedReport = await page.evaluate(() => JSON.parse(sessionStorage.getItem("econ-planner-generated-session")).report);
    release();
    await page.waitForFunction(() => window.delayedEditConsumed === true);
    await expect(statistics).toHaveAttribute("data-current-term", "move:spring-2028");
    expect(await page.locator("main").innerText()).toBe(visibleReport);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("econ-planner-generated-session")).report)).toEqual(savedReport);
    await expect(page.getByRole("button", { name: "Undo last plan edit" })).toHaveCount(0);
    await page.unroute("**/api/majors/map");
    await reloadPlanner(page);
    await expect(statistics).toHaveAttribute("data-current-term", "move:spring-2028");
    await expect(page.getByRole("button", { name: "Undo last plan edit" })).toHaveCount(0);
    await visitPlan(page, "one-year-early");
    await expect(statistics).toHaveAttribute("data-current-term", "move:spring-2028");
  });
}

for (const policyState of ["changed", "missing", "unavailable"]) {
  test(`saved answers survive a ${policyState} policy fingerprint without restoring current plans`, async ({ page }) => {
    await openPlan(page, "freshman", { early: true, completed: ["ECO 113"] });
    const savedAnswers = await page.evaluate(() => JSON.parse(localStorage.getItem("econ-planner-ui-state")).formData);
    const recoverable = await page.evaluate(() => sessionStorage.getItem("econ-planner-generated-session"));
    if (policyState === "missing") {
      await page.evaluate(() => {
        const saved = JSON.parse(sessionStorage.getItem("econ-planner-generated-session"));
        delete saved.plannerFingerprint;
        sessionStorage.setItem("econ-planner-generated-session", JSON.stringify(saved));
      });
    } else {
      await page.route("**/api/majors/map", route => {
        if (route.request().method() !== "GET") return route.continue();
        return route.fulfill({ status: policyState === "unavailable" ? 503 : 200,
          contentType: "application/json", body: JSON.stringify({ plannerFingerprint: "sha256:changed-policy" }) });
      });
    }
    await reloadPlanner(page);
    if (policyState === "unavailable") {
      await expect(page.locator(".summary-status")).toContainText("Your saved plans and edits are kept");
      await expect(page.getByRole("button", { name: "Retry saved plans", exact: true })).toBeVisible();
      expect(await page.evaluate(() => sessionStorage.getItem("econ-planner-generated-session"))).toBe(recoverable);
    } else {
      await expect(page.getByText("Your saved answers are kept. Generate new plans to check them against the current policy and schedule.", { exact: true })).toBeVisible();
    }
    await expect(page.locator(".comparison-plan-card")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Status for ECO 113", exact: true }).getByRole("button", { name: "Completed", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("econ-planner-ui-state")).formData)).toEqual(savedAnswers);
    await page.unroute("**/api/majors/map");
    await generatePlans(page);
    await visitPlan(page, "one-year-early");
    await expect(selectedPlanCard(page)).toBeVisible();
    await reloadPlanner(page);
    await expect(selectedPlanCard(page)).toBeVisible();
  });
}

test("recorded approval enables a conditional Winter overload and Spring moves retain the ceiling", async ({ page }) => {
  await resetPlanner(page);
  await chooseStanding(page, "senior");
  await page.locator("details.more-details > summary").first().click();
  await page.getByLabel("Plan creation date", {exact:true}).fill("2026-09-27");
  await page.getByText("Adjust your schedule (optional)", {exact:true}).click();
  await page.getByLabel("Course units reserved in Winter 2027", {exact:true}).selectOption("2");
  await page.getByLabel("Course units reserved in Spring/May 2027", {exact:true}).selectOption("1");
  await page.getByLabel("Advisor overload approval in Winter 2027", {exact:true}).selectOption("APPROVED");
  await page.getByLabel("Academic probation status in Winter 2027", {exact:true}).selectOption("NOT_ON_ACADEMIC_PROBATION");
  await continueToCourses(page);
  for (const code of ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "BUSN 323", "ECO 260", "ECO 234"]) {
    if (!await page.getByRole("group", {name:`Status for ${code}`, exact:true}).isVisible()) await page.getByRole("searchbox", {name:"Search courses",exact:true}).fill(code);
    await setCourseStatus(page, code, "Completed");
    await page.getByRole("searchbox", {name:"Search courses",exact:true}).fill("");
  }
  const response = await generatePlans(page);
  expect(response.status()).toBe(200);
  const economics = (await response.json()).programs.find(item=>item.economicsPlans);
  const plan = economics.economicsPlans[0];
  expect(plan.validation.conditions.some(item=>item.reasonCode==="TERM_OVERLOAD_APPROVED")).toBe(true);
  expect(plan.validation.tuitionAdvisories[0].modeledUnits).toBe(6);
  await visitPlan(page, plan.id);
  const destination = moveControl(page, "ECO 161").locator('button[data-change-choice="move:spring-2027"]');
  await expect(destination).toHaveCount(0);

  await expect(card(page, "ECO 161").locator(".course-choice-details")).toHaveCount(0);
});

for (const destination of ['fall-2027', 'winter-2028', 'spring-2028']) {
  test(`explicit elective conversion to ${destination}: cancel, save, reload, switch and one Undo`, async ({page}) => {
    await openPlan(page, 'freshman', {date:'2026-07-30'});
    await visitPlan(page, 'explore-first');
    const requirement = () => selectedPlanCard(page).locator('.comparison-editable-course[data-requirement-id="eco-elective-1"]');
    const original = await requirement().locator('.plan-course-actions > button').getAttribute('aria-label');
    await requirement().getByRole('button',{name:/^Change /}).click();
    await requirement().locator('[data-change-choice="replace:spring-2027:ECO 222"]').click();
    let response = validationResponse(page);
    await requirement().getByRole('button',{name:'Apply change',exact:true}).click();
    expect((await response).status()).toBe(200);
    await expect(requirement().locator('.plan-course-actions > button')).toHaveAttribute('aria-label', /^Change ECO 222(?:-[A-Z])?$/);
    const namedSnapshot = await page.evaluate(()=>JSON.parse(sessionStorage.getItem('econ-planner-generated-session')).report);
    await requirement().getByRole('button',{name:/^Change ECO 222(?:-[A-Z])?$/}).press('Enter');
    const choice = requirement().locator(`[data-change-choice="replace:${destination}:ECO elective"]`);
    await choice.click();
    await expect(requirement()).toContainText('Choose the exact course later.');
    await requirement().getByRole('button',{name:'Cancel',exact:true}).press('Enter');
    await expect(requirement().getByRole('button',{name:/^Change ECO 222(?:-[A-Z])?$/})).toBeFocused();
    expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('econ-planner-generated-session')).report)).toEqual(namedSnapshot);
    await requirement().getByRole('button',{name:/^Change ECO 222(?:-[A-Z])?$/}).press('Enter');
    await choice.click();
    response = validationResponse(page);
    await requirement().getByRole('button',{name:'Apply change',exact:true}).press('Enter');
    const saved = await response;
    expect(saved.status()).toBe(200);
    const plan = (await saved.json()).plan;
    const placed = plan.terms.find(term=>term.slotId===destination).courses.find(course=>course.requirementId==='eco-elective-1');
    expect(placed.course).toBe('ECO elective');
    expect(placed.minimumLevel).toBe(200);
    await expect(requirement().getByRole('button',{name:'Change Economics elective (200 level or higher)',exact:true})).toBeFocused();
      await expect(selectedPlanCard(page).locator('.comparison-edit-status')).not.toHaveClass(/is-error/);
    await expect(selectedPlanCard(page).getByRole('button',{name:'Undo last plan edit',exact:true})).toBeVisible();
    await reloadPlanner(page);
    await expect(requirement().locator('.plan-course-actions > button')).toHaveAttribute('aria-label', original);
    await visitPlan(page, 'balanced');
    await expect(selectedPlanCard(page).getByRole('button',{name:'Undo last plan edit',exact:true})).toHaveCount(0);
    await visitPlan(page, 'explore-first');
    await selectedPlanCard(page).getByRole('button',{name:'Undo last plan edit',exact:true}).click();
    await expect(requirement().locator('.plan-course-actions > button')).toHaveAttribute('aria-label', /^Change ECO 222(?:-[A-Z])?$/);
    await expect(selectedPlanCard(page).getByRole('button',{name:'Undo last plan edit',exact:true})).toHaveCount(0);
    await reloadPlanner(page);
    await expect(requirement().locator('.plan-course-actions > button')).toHaveAttribute('aria-label', /^Change ECO 222(?:-[A-Z])?$/);
  });
}

test('conversion failure keeps the named elective, supports retry and fits mobile', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await openPlan(page,'sophomore',{date:'2026-07-30'});
  await visitPlan(page,'explore-first');
  const requirement=selectedPlanCard(page).locator('.comparison-editable-course[data-requirement-id="eco-elective-1"]');
  await requirement.getByRole('button',{name:/^Change ECO 224(?:-[A-Z])?$/}).click();
  await requirement.locator('[data-change-choice="replace:fall-2027:ECO elective"]').click();
  await page.route('**/api/majors/map', route => route.request().postDataJSON()?.action==='validate-plan'
    ? route.fulfill({status:422,json:{error:'This change fails complete plan validation.'}}) : route.continue(), {times:1});
  let response=validationResponse(page);
  await requirement.getByRole('button',{name:'Apply change',exact:true}).click();
  expect((await response).status()).toBe(422);
  await expect(requirement.locator('.plan-course-actions > button')).toHaveAttribute('aria-label', /^Change ECO 224(?:-[A-Z])?$/);
  await expect(selectedPlanCard(page).getByRole('alert')).toContainText('fails complete plan validation');
  await expect(requirement.getByRole('button',{name:'Apply change',exact:true})).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  response=validationResponse(page);
  await requirement.getByRole('button',{name:'Apply change',exact:true}).click();
  expect((await response).status()).toBe(200);
  await expect(requirement.locator('.plan-course-actions > button')).toHaveAttribute('aria-label','Change Economics elective (200 level or higher)');
  await expect(selectedPlanCard(page).getByRole('button',{name:'Undo last plan edit',exact:true})).toBeVisible();
  const accessibility=await new AxeBuilder({page}).include('.comparison-plan-card.is-selected').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.screenshot({path:'test-results/selected-editor-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:900});
  await page.screenshot({path:'test-results/selected-editor-desktop.png',fullPage:true});
});

test('switching plans cancels a delayed conversion and leaves both plans unchanged', async ({page}) => {
  await openPlan(page,'sophomore',{date:'2026-07-30'});
  await visitPlan(page,'explore-first');
  const original = await page.evaluate(()=>JSON.parse(sessionStorage.getItem('econ-planner-generated-session')).report);
  // Ignore transport cancellation to exercise the response-context guard.
  await page.evaluate(()=>{
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const isEdit = init?.body && JSON.parse(init.body).action==='validate-plan';
      const response = await fetch(input, isEdit ? {...init, signal:undefined} : init);
      if (isEdit) {
        const json = response.json.bind(response);
        response.json = async () => { const data = await json(); requestAnimationFrame(()=>requestAnimationFrame(()=>{window.switchEditConsumed=true;})); return data; };
      }
      return response;
    };
  });
  let release;
  const gate = new Promise(resolve=>{release=resolve;});
  let received;
  const arrived = new Promise(resolve=>{received=resolve;});
  await page.route('**/api/majors/map', async route=>{
    if(route.request().postDataJSON()?.action!=='validate-plan') return route.continue();
    const response=await route.fetch();
    expect(response.status()).toBe(200);
    received();
    await gate;
    await route.fulfill({response});
  });
  const card = selectedPlanCard(page).locator('.comparison-editable-course[data-requirement-id="eco-elective-1"]');
  await card.getByRole('button',{name:/^Change ECO 224(?:-[A-Z])?$/}).click();
  await card.locator('[data-change-choice="replace:fall-2027:ECO elective"]').click();
  await card.getByRole('button',{name:'Apply change',exact:true}).click();
  await arrived;
  await visitPlan(page,'balanced');
  release();
  await page.unrouteAll({behavior:'wait'});
  await page.waitForFunction(()=>window.switchEditConsumed===true);
  await visitPlan(page,'explore-first');
  await expect(card.locator('.plan-course-actions > button')).toHaveAttribute('aria-label', /^Change ECO 224(?:-[A-Z])?$/);
  await expect(card.getByRole('button',{name:/^Change ECO 224(?:-[A-Z])?$/})).toHaveAttribute('aria-expanded','false');
  await expect(page.getByRole('button',{name:'Undo last plan edit',exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('econ-planner-generated-session')).report)).toEqual(original);
  await card.getByRole('button',{name:/^Change ECO 224(?:-[A-Z])?$/}).press('Enter');
  await card.getByRole('button', { name:/^Change ECO 224(?:-[A-Z])?$/ }).press('Escape');
  await expect(card.getByRole('button',{name:/^Change ECO 224(?:-[A-Z])?$/})).toBeFocused();
  await expect(card.locator('.course-change-panel')).toBeHidden();
});

async function dragCourse(page, source, destination, { blocked = false } = {}) {
  const handle = await source.locator('.course-drag-handle').boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 15, handle.y + handle.height / 2, { steps: 5 });
  if (blocked) {
    await expect(page.getByRole('status').filter({hasText:/Moving MAT 217(?:-[A-Z])?\. Release over a destination term\./})).toBeVisible();
  } else {
    await expect(destination).toHaveClass(/drop-(allowed|conditional)/);
  }
  const target = await destination.boundingBox();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await page.mouse.up();
}

test('dragging a course validates the move, persists it and supports Undo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1800 });
  await openPlan(page, 'freshman', { early: true });
  const source = card(page, 'MAT 217');
  const plan = selectedPlanCard(page);
  const destination = plan.locator('.compact-schedule [data-term-id="winter-2027"]');
  await dragCourse(page, source, destination);
  const confirmation = page.getByRole('region', { name: 'Review move conditions' });
  if (await confirmation.isVisible()) await confirmation.getByRole('button', { name: 'Apply move', exact: true }).click();
  await expect(destination.locator('.comparison-editable-course:has(button[aria-label^="Change MAT 217"])')).toContainText('MAT 217');
  await expect(plan.locator('.comparison-edit-status')).toContainText('Moved to');
  const accessibility = await new AxeBuilder({ page }).include('.comparison-plan-card.is-selected').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.screenshot({ path: '/tmp/econplanner-drag-preview.png', fullPage: true });
  await reloadPlanner(page);
  await expect(destination.locator('.comparison-editable-course:has(button[aria-label^="Change MAT 217"])')).toContainText('MAT 217');
  await plan.getByRole('button', { name: 'Undo last plan edit', exact: true }).click();
  await expect(plan.locator('.compact-schedule [data-term-id="spring-2027"] .comparison-editable-course')).toContainText('MAT 217');
});

test('dragging to an unavailable term leaves the schedule unchanged', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1800 });
  const { selected } = await openPlan(page, 'freshman', { early: true });
  const sourceTerm = selected.terms.find(term => term.courses.some(course => course.course === 'MAT 217'));
  const course = sourceTerm.courses.find(course => course.course === 'MAT 217');
  const blocked = course.moveDestinationOptions.find(option => !['CURRENT', 'ALLOWED', 'CONDITIONAL'].includes(option.status));
  expect(blocked).toBeTruthy();
  let edits = 0;
  page.on('request', request => { if (request.url().endsWith('/api/majors/map') && request.postDataJSON()?.action === 'validate-plan') edits += 1; });
  const plan = selectedPlanCard(page);
  const source = card(page, 'MAT 217');
  const destination = plan.locator(`.compact-schedule [data-term-id="${blocked.id}"]`);
  await dragCourse(page, source, destination, {blocked:true});
  await expect(plan.locator(`.compact-schedule [data-term-id="${sourceTerm.slotId}"] .comparison-editable-course:has(button[aria-label^="Change MAT 217"])`)).toContainText('MAT 217');
  expect(edits).toBe(0);
  await expect(page.getByRole('region', { name: 'Review move conditions' })).toHaveCount(0);
});


test('a rejected drag keeps the original course and explains the failure', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1800 });
  await openPlan(page, 'freshman', { early: true });
  await page.route('**/api/majors/map', route => route.request().postDataJSON()?.action === 'validate-plan'
    ? route.fulfill({ status: 422, json: { error: 'This change fails complete plan validation.' } }) : route.continue());
  const plan = selectedPlanCard(page);
  await dragCourse(page, card(page, 'MAT 217'), plan.locator('.compact-schedule [data-term-id="winter-2027"]'));
  await expect(plan.getByRole('alert')).toContainText('fails complete plan validation');
  await expect(plan.locator('.compact-schedule [data-term-id="spring-2027"] .comparison-editable-course')).toContainText('MAT 217');
  await expect(plan.getByRole('button', { name: 'Undo last plan edit', exact: true })).toHaveCount(0);
});

test('a conditional drag explains conditions and can be cancelled without saving', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 3000 });
  const { selected } = await openPlan(page, 'freshman', { early: true });
  const candidates = selected.terms.flatMap(term => term.courses.map(course => ({ term, course,
    destination: course.moveDestinationOptions?.find(option => option.status === 'CONDITIONAL') })));
  const candidate = candidates.find(item => item.destination);
  expect(candidate).toBeTruthy();
  const plan = selectedPlanCard(page);
  const source = plan.locator(`.compact-schedule [data-term-id="${candidate.term.slotId}"] .comparison-editable-course[data-requirement-id="${candidate.course.requirementId}"]`);
  await dragCourse(page, source, plan.locator(`.compact-schedule [data-term-id="${candidate.destination.id}"]`));
  const confirmation = page.getByRole('region', { name: 'Review move conditions' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toBeFocused();
  await confirmation.getByRole('button', { name: 'Cancel move', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(source).toBeVisible();
  await expect(plan.getByRole('button', { name: 'Undo last plan edit', exact: true })).toHaveCount(0);
});

test('comparison click menu edits in place and PDF receives that exact edited plan', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1400 });
  const { selected } = await openPlan(page, 'freshman', { early: true });
  const plan = page.locator(`[data-plan-id="${selected.id}"]`);
  const change = plan.getByRole('button', { name:/^Change MAT 217(?:-[A-Z])?$/ });
  await change.click();
  const options = plan.getByRole('region', { name:/^Change MAT 217(?:-[A-Z])? options$/ });
  await expect(options).toBeVisible();
  await expect(options.getByRole('combobox')).toHaveCount(0);
  await expect(options.getByRole('button', { name: 'Apply change', exact: true })).toHaveCount(0);
  const response = validationResponse(page);
  await options.locator('[data-change-choice="move:winter-2027"]').click();
  const saved = await response;
  expect(saved.status()).toBe(200);
  const edited = (await saved.json()).plan;
  await expect(plan.locator('.compact-schedule [data-term-id="winter-2027"]')).toContainText('MAT 217');
  await expect(page.getByRole('heading', { name: 'Compare your course plans', exact: true })).toBeVisible();
  let pdfRequest;
  await page.route('**/api/reports/economics', async route => {
    pdfRequest = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4\n% fictional download response\n%%EOF' });
  });
  await plan.getByRole('button', { name: `Download PDF Report: ${selected.label}`, exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'PDF ready' })).toBeVisible();
  expect(pdfRequest.selectedPlan.id).toBe(selected.id);
  expect(pdfRequest.selectedPlan.terms).toEqual(edited.terms);
  const accessibility = await new AxeBuilder({ page }).include('.comparison-grid').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(accessibility.violations).toEqual([]);
  await page.screenshot({ path: '/tmp/econplanner-inline-preview.png', fullPage: true });
});

test('comparison dragging cannot transfer a course to another plan', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1400 });
  const { selected, plans } = await openPlan(page, 'freshman', { early: true });
  const source = page.locator(`[data-plan-id="${selected.id}"] .comparison-editable-course`).filter({ has: page.getByRole('button', { name:/^Change MAT 217(?:-[A-Z])?$/ }) });
  const other = plans.find(plan => plan.id !== selected.id);
  const target = page.locator(`article[data-plan-id="${other.id}"] .compact-schedule [data-term-id="winter-2027"]`);
  const before = await page.locator('.compact-schedule').allTextContents();
  let edits = 0;
  page.on('request', request => { if (request.url().endsWith('/api/majors/map') && request.postDataJSON()?.action === 'validate-plan') edits += 1; });
  const handle = await source.locator('.course-drag-handle').boundingBox();
  await page.mouse.move(handle.x + 5, handle.y + 5);
  await page.mouse.down();
  await page.mouse.move(handle.x + 20, handle.y + 5, { steps: 5 });
  const box = await target.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 10, { steps: 10 });
  await page.mouse.up();
  expect(await page.locator('.compact-schedule').allTextContents()).toEqual(before);
  expect(edits).toBe(0);
});

test('comparison drag saves inside its own plan and can be undone there', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1400 });
  const { selected } = await openPlan(page, 'freshman', { early: true });
  const plan = page.locator(`[data-plan-id="${selected.id}"]`);
  const source = plan.locator('.comparison-editable-course:has(button[aria-label^="Change MAT 217"])');
  const target = plan.locator('.compact-schedule [data-term-id="winter-2027"]');
  const start = await source.locator('.course-drag-handle').boundingBox();
  await page.mouse.move(start.x + 5, start.y + 5);
  await page.mouse.down();
  await page.mouse.move(start.x + 20, start.y + 5, { steps: 5 });
  await expect(target).toHaveClass(/drop-allowed/);
  const end = await target.boundingBox();
  const response = validationResponse(page);
  await page.mouse.move(end.x + end.width - 20, end.y + 10, { steps: 10 });
  await page.mouse.up();
  expect((await response).status()).toBe(200);
  await expect(target).toContainText('MAT 217');
  await plan.getByRole('button', { name: 'Undo last plan edit', exact: true }).click();
  await expect(plan.locator('.compact-schedule [data-term-id="spring-2027"]')).toContainText('MAT 217');
});

for (const width of [390, 820, 1800]) test(`comparison dropdown stays inside the viewport at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await openPlan(page, 'freshman', { early: true });
  for (const index of [0, 2]) {
    const plan = page.locator('.comparison-plan-card').nth(index);
    const change = plan.getByRole('button', { name: /^Change / }).first();
    await change.click();
    const menu = plan.locator('.course-change-panel:not([hidden])');
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await menu.scrollIntoViewIfNeeded();
    const visibleAtLeftEdge = await menu.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(rect.left + 15, rect.top + 15));
    });
    expect(visibleAtLeftEdge).toBe(true);
    await change.press('Escape');
    await expect(menu).toHaveCount(0);
  }
});

test('conditional comparison move confirms beside the highlighted destination without scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1600 });
  const { selected } = await openPlan(page, 'freshman', { early: true });
  const candidate = selected.terms.flatMap(term => term.courses.map(course => ({ term, course,
    destination: course.moveDestinationOptions?.find(option => option.status === 'CONDITIONAL') }))).find(item => item.destination);
  expect(candidate).toBeTruthy();
  const plan = page.locator(`[data-plan-id="${selected.id}"]`);
  const source = plan.locator(`[data-requirement-id="${candidate.course.requirementId}"] .course-drag-handle`);
  const target = plan.locator(`.compact-schedule [data-term-id="${candidate.destination.id}"]`);
  const start = await source.boundingBox();
  await page.mouse.move(start.x + 5, start.y + 5);
  await page.mouse.down();
  await page.mouse.move(start.x + 20, start.y + 5, { steps: 5 });
  const end = await target.boundingBox();
  await page.mouse.move(end.x + end.width - 20, end.y + 10, { steps: 10 });
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.mouse.up();
  const confirmation = page.getByRole('region', { name: 'Review move conditions' });
  await expect(confirmation).toBeVisible();
  await expect(target).toHaveClass(/drop-pending/);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  const box = await confirmation.boundingBox();
  const destination = await target.boundingBox();
  expect(Math.abs(box.y - destination.y)).toBeLessThan(20);
  await confirmation.getByRole('button', { name: 'Cancel move', exact: true }).click();
  await expect(target).not.toHaveClass(/drop-pending/);
});

test('only one course menu stays open and expanded details remain on screen', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 600 });
  await openPlan(page, 'sophomore', { completed: ['ECO 113', 'ECO 114'], date: '2026-10-17' });
  const plan = page.locator('[data-plan-id="balanced"]');
  const triggers = plan.getByRole('button', { name: /^Change / });
  await triggers.first().click();
  await triggers.nth(1).click();
  await expect(page.locator('.course-change-panel:not([hidden])')).toHaveCount(1);
  await expect(triggers.first()).toHaveAttribute('aria-expanded', 'false');
  await triggers.first().click();
  const menu = plan.locator('.course-change-panel:not([hidden])');
  const menuBox = await menu.boundingBox();
  expect(menuBox.width).toBeGreaterThanOrEqual(280);
  expect(menuBox.x).toBeGreaterThanOrEqual(12);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(820 - 12);
  await expect(menu.getByRole('button', { name: 'Close course options' })).toBeVisible();
  await triggers.first().press('Escape');
  await expect(page.locator('.course-change-panel:not([hidden])')).toHaveCount(0);
});

test('concurrent move explains permission and details in plain language', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1200 });
  await openPlan(page, 'sophomore', { completed: ['ECO 113', 'ECO 114'], date: '2026-10-17' });
  const plan = page.locator('[data-plan-id="balanced"]');
  await plan.getByRole('button', { name:/^Change MAT 113(?:-[A-Z])?$/ }).click();
  const menu = plan.getByRole('region', { name:/^Change MAT 113(?:-[A-Z])? options$/ });
  await menu.locator('[data-change-choice="move:fall-2027"]').click();
  await expect(menu.locator('.change-confirm-warning')).toHaveText('Same term as ECO 213 — instructor approval needed.');
  await menu.getByText('Full check details', { exact: true }).click();
  await expect(menu).toContainText('Taking MAT 113 and ECO 213 in the same term needs approval from the ECO 213 instructor.');
  await expect(menu).not.toContainText(/modeled units|Projected placement|concurrently/);
  await expect(menu.locator('.course-choice-details')).toHaveCount(0);
});

test('one Add button per plan selects a term and an eligible Extra course, and regeneration preserves peers', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1400 });
  await openPlan(page, 'sophomore', { completed: ['ECO 113', 'ECO 114'], date: '2026-10-17' });
  const balanced = page.locator('[data-plan-id="balanced"]');
  await expect(balanced.getByRole('button', {name:'Add Econ course: Balanced',exact:true})).toHaveCount(1);
  await balanced.getByRole('button', {name:'Add Econ course: Balanced',exact:true}).click();
  const picker = balanced.getByRole('region', {name:'Add Econ course options: Balanced',exact:true});
  await picker.getByRole('button', {name:'Fall 2027',exact:true}).click();
  await expect(picker.getByRole('button', {name:/ECO 461/})).toHaveCount(0);
  const addedResponse = validationResponse(page);
  await picker.getByRole('button', {name:/Add a 200\+ elective/}).click();
  await picker.getByRole('button', {name:'Add course',exact:true}).click();
  const added = await (await addedResponse).json();
  expect(added.plan.terms.flatMap(term=>term.courses).some(course=>course.course==='ECO elective' && course.extra)).toBe(true);
  await expect(balanced.locator('.compact-schedule [data-term-id="fall-2027"]')).toContainText('Extra');
  const before = await balanced.locator('.compact-schedule tbody').innerText();
  const cards = page.locator('.comparison-plan-card');
  const other = cards.nth(1);
  const regenerated = validationResponse(page);
  await other.getByRole('button', {name:/^Regenerate this plan:/}).click();
  expect((await regenerated).status()).toBe(200);
  await expect(other).toContainText('This plan was regenerated.');
  expect(await balanced.locator('.compact-schedule tbody').innerText()).toBe(before);
  await expect(page.getByRole('button', {name:'Regenerate all plans',exact:true})).toBeVisible();
  const resetResponse = validationResponse(page);
  await balanced.getByRole('button', {name:'Regenerate this plan: Balanced',exact:true}).click();
  expect((await resetResponse).status()).toBe(200);
  await expect(balanced.locator('[data-requirement-id^="extra-economics-"]')).toHaveCount(0);
});


test("course menus omit source audits and fixed capstones have no move controls", async ({ page }) => {
  await openPlan(page, "sophomore", { completed: ["ECO 113", "ECO 114"] });
  const capstone = card(page, "ECO 461");
  await expect(capstone.getByRole("button", { name: /Change|Drag/ })).toHaveCount(0);
  const course = moveControl(page, "ECO 222");
  await course.getByRole("button", { name:/^Change ECO 222(?:-[A-Z])?$/ }).click();
  await expect(course.locator(".course-change-panel")).toBeVisible();
  await expect(course).not.toContainText("Why can’t I choose other terms?");
  await expect(course).not.toContainText("Sources");
  await expect(course).not.toContainText("Past schedules");
});


test("clicked card closes on pointer exit without moving schedule rows", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1200 });
  await openPlan(page, "sophomore", { completed: ["ECO 113", "ECO 114"] });
  const plan = page.locator('[data-plan-id="balanced"]');
  const course = plan.getByRole("button", { name:/^Change MAT 113(?:-[A-Z])?$/ });
  const before = await plan.locator(".compact-schedule").boundingBox();
  await course.hover();
  await expect(plan.getByRole("region", { name:/^Change MAT 113(?:-[A-Z])? options$/ })).toBeHidden();
  await course.click();
  const menu = plan.getByRole("region", { name:/^Change MAT 113(?:-[A-Z])? options$/ });
  await expect(menu).toBeVisible();
  const after = await plan.locator(".compact-schedule").boundingBox();
  expect(after).toEqual(before);
  await menu.hover();
  await expect(menu).toBeVisible();
  await page.getByRole("heading", { name: "Compare your course plans", exact: true }).hover();
  await expect(menu).toBeHidden();
  await expect(plan.getByRole("button", { name: /Review this plan/ })).toHaveCount(0);
  await expect(plan.getByRole("button", { name: "Download PDF Report: Balanced", exact: true })).toBeVisible();
});

test("each comparison card owns its notes and requirements checklist", async ({ page }) => {
  const { plans } = await openPlan(page, "sophomore", { completed: ["ECO 113", "ECO 114"] });
  for (const plan of plans) {
    const card = page.locator(`[data-plan-id="${plan.id}"]`);
    await card.locator(".comparison-plan-details > details").first().locator("summary").click();
    const conditions = card.locator("[data-plan-conditions]");
    for (const condition of plan.planConditions || []) {
      if (condition.kind !== "unmet") await expect(conditions).toContainText(condition.message);
    }
    const checklist = card.locator("[data-major-requirements-checklist]");
    await checklist.locator("summary").click();
    for (const row of plan.majorRequirementsChecklist.rows.filter(row => row.status !== "still_needed")) {
      await expect(checklist.locator(`[data-requirement-checklist-id="${row.id}"]`)).toContainText(row.label);
    }
    await expect(card.getByRole("button", { name: /Review this plan/ })).toHaveCount(0);
  }
  await expect(page.getByRole("combobox", { name: "Details for" })).toHaveCount(0);
});

test("difference highlighting leaves courses shared by any other plan plain", async ({ page }) => {
  const { plans } = await openPlan(page, "sophomore", { completed: ["ECO 113", "ECO 114"] });
  await page.getByRole("checkbox", { name: "Highlight differences" }).check();
  for (const plan of plans) for (const term of plan.terms) for (const course of term.courses) {
    const shared = plans.some(other => other.id !== plan.id && other.terms.some(otherTerm =>
      otherTerm.slotId === term.slotId && otherTerm.courses.some(otherCourse => otherCourse.course === course.course && (otherCourse.minimumLevel || 0) === (course.minimumLevel || 0))));
    const row = page.locator(`[data-plan-id="${plan.id}"] .compact-schedule [data-term-id="${term.slotId}"] [data-requirement-id="${course.requirementId}"]`);
    await expect(row).toHaveClass(shared ? /comparison-shared-course/ : /comparison-different-course/);
  }
});


test("confirmation stays open after the pointer leaves the course card", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1200 });
  await openPlan(page, "sophomore", { completed: ["ECO 113", "ECO 114"] });
  const plan = page.locator('[data-plan-id="balanced"]');
  await plan.getByRole("button", {name:/^Change MAT 113(?:-[A-Z])?$/}).click();
  const menu = plan.getByRole("region", {name:/^Change MAT 113(?:-[A-Z])? options$/});
  await menu.locator('[data-change-choice="move:fall-2027"]').click();
  await expect(menu.getByRole("button", {name:"Apply change",exact:true})).toBeVisible();
  await page.getByRole("heading", {name:"Compare your course plans",exact:true}).hover();
  await page.waitForTimeout(500); // Outlast the 350 ms option-card dismissal timer.
  await expect(menu.getByRole("button", {name:"Apply change",exact:true})).toBeVisible();
  await page.screenshot({ path: "/tmp/econplanner-confirmation-verified.png" });
  await menu.getByRole("button", {name:"Cancel",exact:true}).click();
  await expect(menu).toBeHidden();
});

test("Winter ECO 161 options exclude finance courses while Finance is still open", async ({ page }) => {
  const { selected } = await openPlan(page, "junior", { early: true, date: "2026-11-22", completed: ["ECO 113", "MAT 217"] });
  const plan = page.locator('[data-plan-id="balanced"]');
  expect(selected.majorRequirementsChecklist.rows.find(row => row.id === "finance").status).toBe("planned");
  await expect(page.getByText('Plans generated.', { exact: true })).toHaveCount(0);
  await expect(page.locator('.plan-edit-instructions strong')).toHaveText('Click a course to see where it can move. You can also drag it by the ⠿ handle.');
  await expect(page.locator('.plan-edit-instructions span')).toHaveText("While you drag, green terms are open, amber terms need approval or a check first, and gray terms show why the course can't go there.");
  await expect(plan.locator('[data-term-id="winter-2027"]')).toContainText('ECO 161');
  await plan.getByRole('button', { name: /^Change ECO 161(?:-[A-Z])?$/ }).click();
  const menu = plan.getByRole('region', { name: /^Change ECO 161(?:-[A-Z])? options$/ });
  for (const course of ['ECO 321', 'BUSN 323']) {
    await expect(menu.locator(`[data-change-choice$=":${course}"]`)).toHaveCount(0);
  }
});

test("Add Econ course adds a named eligible course in one click", async ({ page }) => {
  await openPlan(page, "freshman", { date: "2026-10-17" });
  const plan = page.locator('[data-plan-id="balanced"]');
  await plan.getByRole('button', { name: 'Add Econ course: Balanced', exact: true }).click();
  const picker = plan.getByRole('region', { name: 'Add Econ course options: Balanced', exact: true });
  await picker.getByRole('button', { name: 'Winter 2027', exact: true }).click();
  const addedResponse = validationResponse(page);
  await picker.getByRole('button', { name: /^ECO 161\b/ }).click();
  const added = await (await addedResponse).json();
  expect(added.plan.terms.find(term => term.slotId === 'winter-2027').courses.some(course => course.course === 'ECO 161' && course.extra)).toBe(true);
  await expect(picker).toBeHidden();
  await expect(plan.locator('[data-term-id="winter-2027"]')).toContainText('ECO 161');
});

for (const width of [390, 1440]) {
  test(`Add course card is readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openPlan(page, 'sophomore', { completed: ['ECO 113', 'ECO 114'] });
    const card = page.locator('[data-plan-id="balanced"]');
    await card.getByRole('button', { name: 'Add Econ course: Balanced', exact: true }).click();
    const picker = card.getByRole('region', { name: 'Add Econ course options: Balanced', exact: true });
    await page.screenshot({ path: `/tmp/econplanner-add-${width}.png` });
    const bounds = await picker.boundingBox();
    expect(bounds.width).toBeGreaterThanOrEqual(240);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    await picker.getByRole('button', { name: 'Fall 2027', exact: true }).click();
    await expect(picker.getByRole('button', { name: /Add a 200\+ elective/ })).toBeVisible();
  });
}

for (const width of [320, 1440]) {
  test(`ordinary plan selection and editing journey at ${width}px preserves both plans and agrees with reports`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await resetPlanner(page);
    await chooseStanding(page, 'freshman');
    await page.locator('details.more-details > summary').first().click();
    await page.getByLabel('Plan creation date', {exact:true}).fill('2026-07-30');
    await continueToCourses(page);
    const response = await generatePlans(page);
    const student = response.request().postDataJSON().student;
    const result = await response.json();
    const plans = result.programs.find(p=>p.economicsPlans).economicsPlans;
    const plan = plans.find(p=>p.label==='Explore the Major');
    expect(plan).toBeTruthy();
    const may = plan.terms.find(t=>t.termKey==='Spring' && t.courses.some(c=>c.course==='ECO elective' && c.moveDestinationOptions?.some(o=>['ALLOWED','CONDITIONAL'].includes(o.status))));
    expect(may).toBeTruthy();
    const course = may.courses.find(c=>c.course==='ECO elective' && c.moveDestinationOptions?.some(o=>['ALLOWED','CONDITIONAL'].includes(o.status)));
    for (const candidate of plans) {
      const candidateCard = await visitPlan(page, candidate.id);
      await expect(candidateCard).toHaveClass(/is-selected/);
      await expect(candidateCard.getByRole('heading',{name:candidate.label,exact:true})).toBeVisible();
    }
    const scope = await visitPlan(page, plan.id);
    const row = () => scope.locator(`.comparison-editable-course[data-requirement-id="${course.requirementId}"]`);
    await row().getByRole('button',{name:/^Change /}).press('Enter');
    const move = row().locator('[data-change-choice^="move:"]').first();
    const conditional = await move.getAttribute('data-change-status') === 'CONDITIONAL';
    let pending = validationResponse(page);
    await move.press('Enter');
    if(conditional) await row().getByRole('button',{name:'Apply change',exact:true}).press('Enter');
    expect((await pending).status()).toBe(200);
    await row().getByRole('button',{name:/^Change /}).press('Enter');
    // Select a confirmed named May offering before exercising conversion back
    // to an unnamed elective in an unpublished term.
    await row().locator('[data-change-choice="replace:spring-2027:ECO 222"]').press('Enter');
    pending = validationResponse(page);
    await row().getByRole('button',{name:'Apply change',exact:true}).press('Enter');
    expect((await pending).status()).toBe(200);
    await row().getByRole('button',{name:/^Change ECO 222(?:-[A-Z])?$/}).press('Enter');
    const replacement = row().locator('[data-change-choice="replace:fall-2027:ECO elective"]');
    await expect(replacement).toBeVisible();
    await replacement.press('Enter');
    await expect(row()).toContainText('Replace with a 200+ elective');
    await expect(row()).toContainText('Choose the exact course later.');
    pending = validationResponse(page);
    await row().getByRole('button',{name:'Apply change',exact:true}).press('Enter');
    const edited = await pending;
    expect(edited.status()).toBe(200);
    const updated = (await edited.json()).plan;
    const reportInput = { student, preparedDate:'2026-07-30',selectedPlan:updated,plans:plans.map(p=>p.id===updated.id?updated:p) };
    const json = await page.request.post('/api/reports/economics',{data:{...reportInput,format:'json'}});
    expect(json.status()).toBe(200);
    const report = await json.json();
    const expected = projectSelectedPlanArtifact(updated,{advisorNotices:report.catalog?.advisorAttention||[]});
    expect(projectionMismatches(expected,projectReportJsonArtifact(report))).toEqual([]);
    const html = await page.request.post('/api/reports/economics',{data:{...reportInput,format:'html'}});
    expect(html.status()).toBe(200);
    const occupied = p=>({...p,terms:p.terms.filter(t=>t.courses.length)});
    expect(projectionMismatches(occupied(expected),occupied(projectReportHtmlArtifact(await html.text())))).toEqual([]);
    await scope.getByRole('button',{name:'Undo last plan edit',exact:true}).press('Enter');
    await expect(row().getByRole('button',{name:/^Change ECO 222(?:-[A-Z])?$/})).toBeVisible();
    await expect(scope.getByRole('button',{name:'Undo last plan edit',exact:true})).toHaveCount(0);
    await reloadPlanner(page);
    await expect(row().getByRole('button',{name:/^Change ECO 222(?:-[A-Z])?$/})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const savedPlans = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('econ-planner-generated-session')).report.programs.find(p=>p.economicsPlans).economicsPlans);
    const exploreBefore = (await savedPlans()).find(p=>p.id===plan.id);
    const balancedScope = await visitPlan(page, 'balanced');
    const balancedRow = balancedScope.locator('.comparison-editable-course[data-requirement-id="eco-elective-1"]');
    await balancedRow.getByRole('button',{name:/^Change /}).press('Enter');
    const balancedMove = balancedRow.locator('[data-change-choice^="move:"]').first();
    const balancedDestination = await balancedMove.getAttribute('data-change-choice');
    const balancedConditional = await balancedMove.getAttribute('data-change-status') === 'CONDITIONAL';
    pending = validationResponse(page);
    await balancedMove.press('Enter');
    if (balancedConditional) await balancedRow.getByRole('button',{name:'Apply change',exact:true}).press('Enter');
    const balancedEdit = await pending;
    expect(balancedEdit.status()).toBe(200);
    const expectedBalanced = (await balancedEdit.json()).plan;
    const savedBalanced = async () => (await savedPlans()).find(p=>p.id==='balanced');
    await expect.poll(async () => (await savedBalanced()).terms).toEqual(expectedBalanced.terms);
    const balancedBefore = (await savedPlans()).find(p=>p.id==='balanced');
    expect(balancedBefore.terms).toEqual(expectedBalanced.terms);
    await visitPlan(page, 'explore-first');
    await expect(row().getByRole('button',{name:/^Change ECO 222(?:-[A-Z])?$/})).toBeVisible();
    await reloadPlanner(page);
    expect((await savedPlans()).find(p=>p.id===plan.id).terms).toEqual(exploreBefore.terms);
    await visitPlan(page, 'balanced');
    await expect(balancedRow.locator('.plan-course-actions')).toHaveAttribute('data-current-term',balancedDestination);
    expect((await savedBalanced()).terms).toEqual(expectedBalanced.terms);
  });
}
