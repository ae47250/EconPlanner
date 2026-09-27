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
  const { selected } = await openPlan(page, "freshman", { early: true });
  const core = page.getByRole("combobox", { name: "Move ECO 113 to another term", exact: true });
  const course = selected.terms.flatMap(term => term.courses).find(course => course.course === "ECO 113");
  expect(await core.locator("option").evaluateAll(options => options.map(option => option.value))).toEqual(course.moveDestinationIds);
  expect(course.moveDestinationIds.every(id => !id.startsWith("spring-"))).toBe(true);
  await expect(page.getByRole("combobox", { name: "Move ECO 222 to another term", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Move ECO 461 to another term", exact: true })).toBeVisible();

  await core.focus();
  const rejectedResponse = validationResponse(page);
  await core.selectOption("fall-2027");
  expect((await rejectedResponse).status()).toBe(422);
  await expect(core).toBeFocused();
  await expect(core).toHaveValue("winter-2027");
  await expect(card(page, "ECO 113").getByRole("alert")).toContainText("ECO 213 is missing prerequisites: ECO 113");
  await expect(page.getByRole("button", { name: "Undo last plan edit" })).toHaveCount(0);

  const statistics = page.getByRole("combobox", { name: "Move MAT 217 to another term", exact: true });
  const movedResponse = validationResponse(page);
  await statistics.selectOption("winter-2027");
  const moved = await movedResponse;
  expect(moved.status()).toBe(200);
  const movedPlan = (await moved.json()).plan;
  expect(movedPlan.terms.find(term => term.slotId === "winter-2027").courses.some(course => course.course === "MAT 217")).toBe(true);
  await expect(page.locator("main")).not.toContainText("Seat availability for MAT 217-S was last checked");
  await expect(page.locator('.term-card[data-term-key="Spring"]', { hasText: "Spring/May" }).first()).toContainText("No courses placed");
  await expect(card(page, "ECO 113").getByRole("alert")).toHaveCount(0);
  const visibleCodes = await page.locator(".term-card .plan-course-summary > strong").allInnerTexts();
  expect(visibleCodes.sort()).toEqual(movedPlan.terms.flatMap(term => term.courses.map(course => course.course)).sort());
  const reportInput = { student: moved.request().postDataJSON().student, preparedDate: "2026-09-23", selectedPlan: movedPlan };
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
  const option = replacement.locator("option", { hasText: "ECO 260" });
  const value = await option.getAttribute("value");
  const response = validationResponse(page);
  await replacement.selectOption(value);
  const replacementResponse = await response;
  expect(replacementResponse.status()).toBe(200);
  const updatedPlan = (await replacementResponse.json()).plan;
  await expect(may).toContainText("ECO 260");
  await expect(may.locator(".plan-course-summary > strong")).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "Move ECO 260 to another term", exact: true })).toBeVisible();
  const mayTerm = updatedPlan.terms.find(term => term.slotId === "spring-2027");
  const elective = mayTerm.courses.find(course => course.course === "ECO 260");
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
  await openPlan(page, "freshman", { early: true });
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
  const second = page.getByRole("combobox", { name: "Move ECO 113 to another term", exact: true });
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
  const control = page.getByRole("combobox", { name: "Move ECO 113 to another term", exact: true });
  await control.focus();
  const response = validationResponse(page);
  await control.selectOption("fall-2027");
  expect((await response).status()).toBe(422);
  const feedback = card(page, "ECO 113").getByRole("alert");
  await expect(feedback).toBeVisible();
  await expect(feedback).toContainText("ECO 213 is missing prerequisites: ECO 113");
  await expect(control).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const accessibility = await new AxeBuilder({ page }).include(".plan-course-edit-feedback")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(accessibility.violations).toEqual([]);
});

for (const scenario of [
  { code: "ECO 461", options: { graduationYear: "2031" }, from: "winter-2030", to: "winter-2031" },
  { code: "ECO 222", options: { early: true }, from: "spring-2028", to: "winter-2028" }
]) test(`ordinary freshman can move ${scenario.code} from ${scenario.from} to ${scenario.to}`, async ({ page }) => {
  const { selected, student } = await openPlan(page, "freshman", scenario.options);
  const control = page.getByRole("combobox", { name: `Move ${scenario.code} to another term`, exact: true });
  await expect(control).toHaveValue(scenario.from);
  await expect(control.locator(`option[value="${scenario.to}"]`)).toHaveCount(1);
  if (scenario.code === "ECO 461") {
    const rejected = validationResponse(page);
    await control.selectOption("winter-2029");
    expect((await rejected).status()).toBe(422);
    await expect(control).toHaveValue(scenario.from);
    await expect(card(page, scenario.code).getByRole("alert")).toContainText(/senior Winter/);
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
  const { selected } = await openPlan(page, "freshman");
  const control = page.getByRole("combobox", { name: "Move ECO 461 to another term", exact: true });
  await expect(control).toHaveValue("winter-2030");
  const originalCards = await page.locator(".term-card").evaluateAll(cards => cards.map(item => ({
    year: item.dataset.academicYear, term: item.dataset.termKey,
    courses: [...item.querySelectorAll(".plan-course-summary > strong")].map(course => course.textContent)
  })));
  const response = validationResponse(page);
  await control.selectOption("winter-2029");
  const rejected = await response;
  expect(rejected.status()).toBe(422);
  expect((await rejected.json()).error).toContain("not in a valid senior Winter slot");
  await expect(control).toHaveValue("winter-2030");
  await expect(card(page, "ECO 461").getByRole("alert")).toContainText("senior Winter");
  await expect(page.getByRole("button", { name: "Undo last plan edit" })).toHaveCount(0);
  await page.reload();
  await expect(control).toHaveValue("winter-2030");
  expect(await page.locator(".term-card").evaluateAll(cards => cards.map(item => ({
    year: item.dataset.academicYear, term: item.dataset.termKey,
    courses: [...item.querySelectorAll(".plan-course-summary > strong")].map(course => course.textContent)
  })))).toEqual(originalCards);
  expect(selected.id).toBe("balanced");
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
    await expect(control.locator(`option[value="${other.slotId}"]`)).toHaveCount(0);
    expect(await control.locator("option").evaluateAll(options => options.map(option => option.value)))
      .toEqual(own.courses.find(course => course.course === code).moveDestinationIds);
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
      expect(response.status()).toBe(outcome === "accepted" ? 200 : 422);
      received();
      await held;
      await route.fulfill({ response });
    });
    if (outcome === "accepted") await statistics.selectOption("spring-2027");
    else await page.getByRole("combobox", { name: "Move ECO 113 to another term", exact: true }).selectOption("fall-2027");
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
