import { expect, test } from "./nightly-observability.js";
import AxeBuilder from "@axe-core/playwright";
import {
  courseOccurrences, projectReportHtmlArtifact, projectReportJsonArtifact, projectSelectedPlanArtifact, projectionMismatches
} from "../oracle/economics-artifact-projection.js";
import {
  resetPlanner, chooseStanding, continueToCourses, generatePlans, setCourseStatus
} from "./cp7-helpers.js";

async function openPlan(page, standing, { early = false, completed = [], date = "2026-09-23", graduationYear = null } = {}) {
  await resetPlanner(page);
  await chooseStanding(page, standing);
  await page.locator("details.more-details > summary").first().click();
  await page.getByLabel("Plan creation date", { exact: true }).fill(date);
  if (early) await page.getByRole("button", { name: "I’d like to graduate one year early", exact: true }).click();
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
  const selected = plans.find(plan => plan.id === (early ? "one-year-early" : "balanced"));
  expect(selected).toBeTruthy();
  await page.getByRole("button", { name: new RegExp(`^(Choose|Review selected) ${selected.label}$`) }).click();
  return { selected, plans, student: response.request().postDataJSON().student };
}

function card(page, code) {
  return page.locator(".term-card li").filter({ has: page.locator(".plan-course-summary > strong", { hasText: code }) }).first();
}

function validationResponse(page) {
  return page.waitForResponse(response => response.url().endsWith("/api/majors/map")
    && response.request().postDataJSON()?.action === "validate-plan");
}

test("malformed edit requests preserve the saved plan and allow a later valid move", async ({ page }) => {
  await openPlan(page, "freshman", { early: true });
  const control = page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true });
  await page.route("**/api/majors/map", route => route.continue({ postData: '{"action":"validate-plan",' }), { times: 1 });
  const rejected = page.waitForResponse(response => response.url().endsWith("/api/majors/map"));
  await control.selectOption("winter-2027");
  expect((await rejected).status()).toBe(400);
  await expect(control).toHaveValue("spring-2027");
  await expect(card(page, "MAT 217").getByRole("alert")).toContainText("invalid JSON");
  await page.reload();
  await expect(control).toHaveValue("spring-2027");
  const accepted = validationResponse(page);
  await control.selectOption("winter-2027");
  expect((await accepted).status()).toBe(200);
  await page.reload();
  await expect(control).toHaveValue("winter-2027");
});

test("move selectors, rejection feedback, successful move, undo, and reload agree", async ({ page }) => {
  const { selected, student, plans } = await openPlan(page, "freshman", { early: true });
  const core = page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true });
  const course = selected.terms.flatMap(term => term.courses).find(course => course.course === "MAT 217");
  expect(await core.locator("option").evaluateAll(options => options.map(option => option.value)))
    .toEqual(course.moveDestinationOptions.map(option => option.id));
  expect(await core.locator("option").evaluateAll(options => options.filter(option => !option.disabled).map(option => option.value)))
    .toEqual(course.moveDestinationIds);
  const unsupportedWinter = core.locator('option[value="winter-2029"]');
  await expect(unsupportedWinter).toHaveAttribute("disabled", "");
  await expect(unsupportedWinter).toContainText(/Unavailable:.*prerequisites/i);
  await expect(page.getByRole("combobox", { name: "Move ECO 222 to another term", exact: true })).toHaveCount(1);
  await expect(card(page, "ECO 222")).toContainText(/No other term currently passes complete plan checks/);
  await expect(page.getByRole("combobox", { name: "Move ECO 461 to another term", exact: true })).toHaveCount(1);
  await expect(card(page, "ECO 461")).toContainText(/No other term currently passes complete plan checks/);

  const directRejection = await page.request.post("/api/majors/map", { data: {
    action: "validate-plan", student, plan: selected, plans,
    edit: { type: "move", planId: selected.id, fromTermId: "winter-2027", toTermId: "fall-2027", courseId: "eco-113" }
  } });
  expect(directRejection.status()).toBe(422);
  await expect(page.getByRole("button", { name: "Undo last plan edit" })).toHaveCount(0);

  const statistics = page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true });
  const movedResponse = validationResponse(page);
  await statistics.selectOption("winter-2027");
  const moved = await movedResponse;
  expect(moved.status()).toBe(200);
  const movedPlan = (await moved.json()).plan;
  const refreshedStatistics = movedPlan.terms.flatMap(term => term.courses).find(course => course.course === "MAT 217");
  expect(refreshedStatistics.moveDestinationOptions.map(option => option.id)).toEqual(movedPlan.terms.map(term => term.slotId));
  expect(refreshedStatistics.moveDestinationIds).toContain("winter-2027");
  expect(movedPlan.terms.find(term => term.slotId === "winter-2027").courses.some(course => course.course === "MAT 217")).toBe(true);
  await expect(page.locator("main")).not.toContainText("Seat availability for MAT 217-S was last checked");
  await expect(page.locator('.term-card[data-term-key="Spring"]', { hasText: "Spring/May" }).first()).toContainText("No courses placed");
  await expect(card(page, "ECO 113").getByRole("alert")).toHaveCount(0);
  const visibleCodes = await page.locator(".term-card .plan-course-summary > strong").allInnerTexts();
  expect(visibleCodes.sort()).toEqual(movedPlan.terms.flatMap(term => term.courses.map(course => course.course)).sort());
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
  await page.getByRole("button", { name: "Undo last plan edit" }).click();
  await expect(page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true })).toHaveValue("spring-2027");
  await expect(page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true }).locator('option[value="spring-2028"]'))
    .toHaveAttribute("disabled", "");

  const savedResponse = validationResponse(page);
  await page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true }).selectOption("winter-2027");
  expect((await savedResponse).status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true })).toHaveValue("winter-2027");
  await page.getByRole("button", { name: "← Back to plan comparison", exact: true }).click();
  await page.getByRole("button", { name: /^(Choose|Review selected) Balanced$/ }).click();
  await page.getByRole("button", { name: "← Back to plan comparison", exact: true }).click();
  await page.getByRole("button", { name: /^(Choose|Review selected) One Year Early$/ }).click();
  await expect(page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true })).toHaveValue("winter-2027");
  expect(reportParity).toEqual([]);
});

test("after an elective replacement the May 2027 card still rejects an unsupported move", async ({ page }) => {
  const { student, plans } = await openPlan(page, "senior", {
    date: "2026-07-30",
    completed: ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "BUSN 323"]
  });
  const may = page.locator('.term-card[data-term-key="Spring"]');
  await expect(may).toContainText("ECO 222");
  await expect(may.locator(".plan-course-summary > strong")).toHaveCount(1);
  const replacement = may.getByRole("combobox", { name: "Choose elective for Spring/May", exact: true });
  const option = replacement.locator("option", { hasText: "ECO 224" });
  const value = await option.getAttribute("value");
  const response = validationResponse(page);
  await replacement.selectOption(value);
  const replacementResponse = await response;
  expect(replacementResponse.status()).toBe(200);
  const updatedPlan = (await replacementResponse.json()).plan;
  await expect(may).toContainText("ECO 224");
  await expect(may.locator(".plan-course-summary > strong")).toHaveCount(1);
  const updatedElective = updatedPlan.terms.find(term => term.slotId === "spring-2027").courses.find(course => course.course === "ECO 224");
  expect(updatedElective.alternativeOptions.some(option => option.course === "ECO 222"
    && ["ALLOWED", "CONDITIONAL"].includes(option.status))).toBe(true);
  expect(updatedElective.moveDestinationOptions.some(option => option.status === "BLOCKED")).toBe(true);
  await expect(page.getByRole("combobox", { name: "Move ECO 224 to another term", exact: true })).toHaveCount(1);
  await expect(card(page, "ECO 224")).toContainText(/No other term currently passes complete plan checks/);
  await page.getByRole("button", { name: "Undo last plan edit" }).click();
  await expect(may).toContainText("ECO 222");
  await page.reload();
  await expect(page.locator('.term-card[data-academic-year="2026/2027"][data-term-key="Spring"]')).toContainText("ECO 222");
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
  const first = page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true });
  const second = page.getByRole("combobox", { name: "Move ECO 114 to another term", exact: true });
  expect(selected.terms.flatMap(term => term.courses).find(course => course.course === "ECO 114").moveDestinationIds)
    .toContain("fall-2027");
  const response = validationResponse(page);
  await first.selectOption("winter-2027");
  await expect(first).toBeDisabled();
  await expect(second).toBeDisabled();
  release();
  expect((await response).status()).toBe(200);
  await expect(page.locator(".plan-edit-status")).toContainText("updated and remains valid");
  expect(validationRequests).toBe(1);
});

test("a move error remains readable and announced at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPlan(page, "freshman", { early: true });
  const control = page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true });
  await control.focus();
  await page.route("**/api/majors/map", route => route.fulfill({
    status: 422,
    contentType: "application/json",
    body: JSON.stringify({ error: "That plan change cannot be saved. The selected term fails complete plan validation." })
  }), { times: 1 });
  const response = validationResponse(page);
  await control.selectOption("winter-2027");
  expect((await response).status()).toBe(422);
  const feedback = card(page, "MAT 217").getByRole("alert");
  await expect(feedback).toBeVisible();
  await expect(feedback).toContainText("fails complete plan validation");
  await expect(control).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const accessibility = await new AxeBuilder({ page }).include(".plan-course-edit-feedback")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
});

for (const scenario of [
  { code: "ECO 461", options: { graduationYear: "2031" }, from: "winter-2030", to: "winter-2031" },
  { code: "ECO 222", options: { early: true }, from: "spring-2028", to: "winter-2028" }
]) test(`ordinary freshman ${scenario.code === "ECO 222" ? "cannot move" : "can move"} ${scenario.code} from ${scenario.from} to ${scenario.to}`, async ({ page }) => {
  const { selected, plans, student } = await openPlan(page, "freshman", scenario.options);
  const control = page.getByRole("combobox", { name: `Move ${scenario.code} to another term`, exact: true });
  if (scenario.code === "ECO 222") {
    await expect(control).toHaveCount(1);
    await expect(card(page, scenario.code)).toContainText(/No other term currently passes complete plan checks/);
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
  await expect(control).toHaveValue(scenario.from);
  await expect(control.locator(`option[value="${scenario.to}"]`)).toBeEnabled();
  if (scenario.code === "ECO 461") {
    await expect(control.locator('option[value="winter-2029"]')).toHaveAttribute("disabled", "");
    await expect(control.locator('option[value="winter-2029"]')).toContainText(/valid senior Winter slot/);
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
  await control.selectOption(scenario.to);
  const saved = await response;
  expect(saved.status()).toBe(200);
  const plan = (await saved.json()).plan;
  const moved = plan.terms.find(term => term.slotId === scenario.to).courses.find(course => course.course === scenario.code);
  expect(moved).toBeTruthy();
  expect(moved.section).toBe("");
  expect(moved.availability).toBeNull();
  expect(moved.meeting).toBeNull();
  expect(moved.preliminaryScheduleEvidence).toBeUndefined();
  if (scenario.code === "ECO 222") expect(moved.source).toBe("projected-offering");
  const before = selected.terms.flatMap(term => term.courses.map(course => `${course.requirementId}:${term.slotId}`)).sort();
  const after = plan.terms.flatMap(term => term.courses.map(course => `${course.requirementId}:${term.slotId}`)).sort();
  expect(after).toEqual(before.map(value => value === `${moved.requirementId}:${scenario.from}` ? `${moved.requirementId}:${scenario.to}` : value).sort());
  await expect(page.locator("main")).toContainText("Later unpublished schedules are shown as planning projections");
  await page.reload();
  await expect(control).toHaveValue(scenario.to);
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
  const control = page.getByRole("combobox", { name: "Move ECO 461 to another term", exact: true });
  await expect(control).toHaveCount(1);
  await expect(card(page, "ECO 461")).toContainText(/No other term currently passes complete plan checks/);
  const originalCards = await page.locator(".term-card").evaluateAll(cards => cards.map(item => ({
    year: item.dataset.academicYear, term: item.dataset.termKey,
    courses: [...item.querySelectorAll(".plan-course-summary > strong")].map(course => course.textContent)
  })));
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
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Move ECO 461 to another term", exact: true })).toHaveCount(1);
  expect(await page.locator(".term-card").evaluateAll(cards => cards.map(item => ({
    year: item.dataset.academicYear, term: item.dataset.termKey,
    courses: [...item.querySelectorAll(".plan-course-summary > strong")].map(course => course.textContent)
  })))).toEqual(originalCards);
  expect(selected.id).toBe("balanced");
});

test("already-senior ECO 461 retains valid Winter moves", async ({ page }) => {
  const { selected, student, plans } = await openPlan(page, "senior", {
    date: "2026-09-23",
    graduationYear: "2028",
    completed: ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "BUSN 323", "ECO 221", "ECO 222", "ECO 234", "ECO 333"]
  });
  const control = page.getByRole("combobox", { name: "Move ECO 461 to another term", exact: true });
  await expect(control).toHaveValue("winter-2028");
  await expect(control.locator('option[value="winter-2027"]')).toBeEnabled();

  const accepted = validationResponse(page);
  await control.selectOption("winter-2027");
  const response = await accepted;
  expect(response.status()).toBe(200);
  const edited = (await response.json()).plan;
  const capstone = edited.terms.find(term => term.slotId === "winter-2027").courses
    .find(course => course.course === "ECO 461");
  expect(capstone.source).toBe("verified-offering");

  const original = selected.terms.find(term => term.slotId === "winter-2028").courses.find(course => course.course === "ECO 461");
  const direct = await page.request.post("/api/majors/map", { data: {
    action: "validate-plan", student, plan: selected, plans,
    edit: { type: "move", planId: selected.id, fromTermId: "winter-2028", toTermId: "winter-2027", courseId: original.requirementId }
  } });
  expect(direct.status()).toBe(200);
});

test("ECO 222 projected May options, disabled Winter, undo persistence, and report guidance agree", async ({ page }) => {
  const { plans, student } = await openPlan(page, "freshman", { early: true });
  const spring2029 = page.locator('.term-card[data-academic-year="2028/2029"][data-term-key="Spring"]');
  const makeRoom = spring2029.getByRole("combobox", { name: "Move ECO elective to another term", exact: true });
  await expect(makeRoom.locator('option[value="fall-2028"]')).toBeEnabled();
  const freeMayResponse = validationResponse(page);
  await makeRoom.selectOption("fall-2028");
  const freeMay = await freeMayResponse;
  expect(freeMay.status()).toBe(200);
  const planWithFreeMay = (await freeMay.json()).plan;
  const updatedPlans = plans.map(plan => plan.id === planWithFreeMay.id ? planWithFreeMay : plan);
  const eco222 = planWithFreeMay.terms.flatMap(term => term.courses.map(course => ({ term, course })))
    .find(item => item.course.course === "ECO 222");
  expect(eco222.course.moveDestinationOptions.find(option => option.id === "spring-2029").status).toBe("CONDITIONAL");
  expect(eco222.course.moveDestinationOptions.find(option => option.id === "spring-2029").message).toMatch(/future schedule is unpublished/i);

  const control = page.getByRole("combobox", { name: "Move ECO 222 to another term", exact: true });
  await expect(control.locator('option[value="spring-2029"]')).toBeEnabled();
  await expect(control.locator('option[value="winter-2028"]')).toHaveAttribute("disabled", "");
  const unsupportedWinter = await page.request.post("/api/majors/map", { data: {
    action: "validate-plan", student, plan: planWithFreeMay, plans: updatedPlans,
    edit: { type: "move", planId: planWithFreeMay.id, fromTermId: eco222.term.slotId,
      toTermId: "winter-2028", courseId: eco222.course.requirementId }
  } });
  expect(unsupportedWinter.status()).toBe(422);

  const acceptedResponse = validationResponse(page);
  await control.selectOption("spring-2029");
  const accepted = await acceptedResponse;
  expect(accepted.status()).toBe(200);
  const movedPlan = (await accepted.json()).plan;
  const movedECO222 = movedPlan.terms.find(term => term.slotId === "spring-2029").courses.find(course => course.course === "ECO 222");
  expect(["catalog-statement", "projected-offering"]).toContain(movedECO222.source);
  expect(movedECO222.moveGuidance.studentMessage).toMatch(/Conditional move choices|No other term/i);
  const persistedGuidance = movedECO222.moveGuidance.studentMessage;

  await page.reload();
  await expect(page.getByRole("combobox", { name: "Move ECO 222 to another term", exact: true })).toHaveValue("spring-2029");
  await expect(card(page, "ECO 222")).toContainText(persistedGuidance);
  const reportPlans = updatedPlans.map(plan => plan.id === movedPlan.id ? movedPlan : plan);
  const reportInput = { student, preparedDate: "2026-09-23", selectedPlan: movedPlan, plans: reportPlans };
  const reportResponse = await page.request.post("/api/reports/economics", { data: { ...reportInput, format: "json" } });
  expect(reportResponse.status()).toBe(200);
  const report = await reportResponse.json();
  const reportECO222 = report.terms.find(term => term.slotId === "spring-2029").courses.find(course => course.code === "ECO 222");
  expect(reportECO222.moveGuidance.studentMessage).toBe(persistedGuidance);
  expect(report.catalog.advisorAttention.some(notice => notice.message.includes(`ECO 222: ${persistedGuidance}`))).toBe(true);
  const htmlResponse = await page.request.post("/api/reports/economics", { data: { ...reportInput, format: "html" } });
  expect(htmlResponse.status()).toBe(200);
  const html = await htmlResponse.text();
  expect(html).toContain(persistedGuidance);
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
  const control = page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true });
  const original = selected.terms.find(term => term.courses.some(course => course.course === "MAT 217"));
  expect(original.slotId).not.toBe("spring-2028");
  await expect(control.locator('option[value="spring-2028"]')).toHaveCount(1);
  const response = validationResponse(page);
  await control.selectOption("spring-2028");
  const saved = await response;
  expect(saved.status()).toBe(200);
  const plan = (await saved.json()).plan;
  const course = plan.terms.find(term => term.slotId === "spring-2028").courses.find(course => course.course === "MAT 217");
  expect(course.source).toBe("projected-offering");
  expect(course.section).toBe("");
  await page.reload();
  await expect(control).toHaveValue("spring-2028");
  await expect(page.locator("main")).toContainText("Later unpublished schedules are shown as planning projections");
});

test("unpublished intermediate dropdowns omit the counterpart's occupied term in both directions", async ({ page }) => {
  const { selected } = await openPlan(page, "sophomore", {
    date: "2027-07-30", completed: ["ECO 113", "ECO 114", "MAT 113", "MAT 217"]
  });
  for (const [code, counterpart] of [["ECO 213", "ECO 214"], ["ECO 214", "ECO 213"]]) {
    const own = selected.terms.find(term => term.courses.some(course => course.course === code));
    const other = selected.terms.find(term => term.courses.some(course => course.course === counterpart));
    expect(own.slotId).not.toBe(other.slotId);
    const control = page.getByRole("combobox", { name: `Move ${code} to another term`, exact: true });
    await expect(control).toHaveValue(own.slotId);
    const counterpartOption = control.locator(`option[value="${other.slotId}"]`);
    await expect(counterpartOption).toHaveAttribute("disabled", "");
    await expect(counterpartOption).toContainText(/unpublished|verified schedule/i);
    const course = own.courses.find(course => course.course === code);
    expect(await control.locator("option").evaluateAll(options => options.map(option => option.value)))
      .toEqual(course.moveDestinationOptions.map(option => option.id));
    expect(await control.locator("option").evaluateAll(options => options.filter(option => !option.disabled).map(option => option.value)))
      .toEqual(course.moveDestinationIds);
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
  await page.reload();
  await expect(page.getByText("Your saved answers are kept. Generate new plans to check them against the current policy and schedule.", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Status for ECO 113", exact: true })
    .getByRole("button", { name: "Completed", exact: true })).toHaveAttribute("aria-pressed", "true");
  await generatePlans(page);
  await page.getByRole("button", { name: /^(Choose|Review selected) One Year Early$/ }).click();
  const control = page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true });
  await expect.poll(() => control.locator("option").count()).toBeGreaterThan(1);
  await page.reload();
  await expect.poll(() => control.locator("option").count()).toBeGreaterThan(1);
});

for (const outcome of ["accepted", "rejected"]) {
  test(`a delayed ${outcome} edit cannot change a regenerated report or its undo`, async ({ page }) => {
    await openPlan(page, "freshman", { early: true });
    const statistics = page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true });
    const firstMove = validationResponse(page);
    await statistics.selectOption("winter-2027");
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
    if (outcome === "accepted") await statistics.selectOption("spring-2027");
    else await page.getByRole("combobox", { name: "Move ECO 114 to another term", exact: true }).selectOption("fall-2027");
    await intercepted;
    await page.getByRole("button", { name: "Edit answers", exact: true }).click();
    await page.getByRole("button", { name: "Back to about you", exact: true }).click();
    const date = page.getByLabel("Plan creation date", { exact: true });
    if (!await date.isVisible()) await page.locator("details.more-details > summary").first().click();
    await date.fill("2027-09-23");
    await continueToCourses(page);
    await generatePlans(page);
    await page.getByRole("button", { name: /^(Choose|Review selected) One Year Early$/ }).click();
    await expect(statistics).toHaveValue("spring-2028");
    const visibleReport = await page.locator("main").innerText();
    const savedReport = await page.evaluate(() => JSON.parse(sessionStorage.getItem("econ-planner-generated-session")).report);
    release();
    await page.waitForFunction(() => window.delayedEditConsumed === true);
    await expect(statistics).toHaveValue("spring-2028");
    expect(await page.locator("main").innerText()).toBe(visibleReport);
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("econ-planner-generated-session")).report)).toEqual(savedReport);
    await expect(page.getByRole("button", { name: "Undo last plan edit" })).toHaveCount(0);
    await page.reload();
    await expect(statistics).toHaveValue("spring-2028");
    await expect(page.getByRole("button", { name: "Undo last plan edit" })).toHaveCount(0);
    await page.getByRole("button", { name: "Compare plans", exact: true }).click();
    await page.getByRole("button", { name: /^(Choose|Review selected) One Year Early$/ }).click();
    await expect(statistics).toHaveValue("spring-2028");
  });
}

for (const policyState of ["changed", "missing", "unavailable"]) {
  test(`saved answers survive a ${policyState} policy fingerprint without restoring current plans`, async ({ page }) => {
    await openPlan(page, "freshman", { early: true, completed: ["ECO 113"] });
    const savedAnswers = await page.evaluate(() => JSON.parse(localStorage.getItem("econ-planner-ui-state")).formData);
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
    await page.reload();
    await expect(page.getByText("Your saved answers are kept. Generate new plans to check them against the current policy and schedule.", { exact: true })).toBeVisible();
    await expect(page.locator(".term-card")).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Status for ECO 113", exact: true }).getByRole("button", { name: "Completed", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("econ-planner-ui-state")).formData)).toEqual(savedAnswers);
    await page.unroute("**/api/majors/map");
    await generatePlans(page);
    await page.getByRole("button", { name: /^(Choose|Review selected) One Year Early$/ }).click();
    await expect(page.locator(".term-card").first()).toBeVisible();
    await page.reload();
    await expect(page.locator(".term-card").first()).toBeVisible();
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
  for (const code of ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "BUSN 323", "ECO 161", "ECO 234"]) {
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
  await page.getByRole("button",{name:new RegExp(`^(Choose|Review selected) ${plan.label}$`)}).click();
  const destination = page.getByRole("combobox",{name:"Move ECO 321 to another term",exact:true}).locator('option[value="spring-2027"]');
  await expect(destination).toHaveAttribute("disabled", "");
  await expect(destination).toContainText(/published term limit.*1\.25/);
  await expect(destination).toContainText(/not listed|verified/);
});
