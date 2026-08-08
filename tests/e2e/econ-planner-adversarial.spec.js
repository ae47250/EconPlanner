import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./nightly-observability.js";

const UI_STORAGE_KEY = "econ-planner-ui-state";
const GENERATED_SESSION_KEY = "econ-planner-generated-session";
const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// @pr tests are the small, timing-sensitive pull-request gate. @nightly tests
// cover the broader failure, navigation, accessibility, and extreme-content set.
// Timing-sensitive tests use explicit request gates or browser events, never sleeps.

const PROJECTED_MOVE_PROFILE = Object.freeze({
  academicStanding: "freshman",
  planCreationDate: "2026-07-30",
  courses: [
    "ECO 113", "ECO 114", "MAT 113", "MAT 217", "BUSN 323",
    "ECO 161", "ECO 221", "ECO 234", "ECO 260"
  ]
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function resetPlanner(page, { viewport = { width: 1440, height: 900 } } = {}) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?layout=apple");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Build your economics course plan" })).toBeVisible();
}

async function seedStudent(page, profile = PROJECTED_MOVE_PROFILE, displayName = "Task 20 Student") {
  await page.evaluate(({ storageKey, student, name }) => {
    const courses = student.courses.map(code => ({
      id: code,
      code,
      status: "completed",
      units: "1",
      source: "manual_code",
      grade: "",
      notes: ""
    }));
    window.localStorage.setItem(storageKey, JSON.stringify({
      schemaVersion: 5,
      formData: {
        displayName: name,
        academicStanding: student.academicStanding,
        planningPace: "standard",
        projectedSeniorStandingConfirmation: null,
        planCreationDate: student.planCreationDate,
        planCreationDateEdited: true,
        isTransferStudent: false,
        transferExpectedGraduationYear: "",
        transferEntryAcademicYear: "",
        expectedGraduationTerm: "",
        reservedCourseUnits: {},
        courses,
        advisorApprovals: ""
      },
      courseSearch: ""
    }));
  }, { storageKey: UI_STORAGE_KEY, student: profile, name: displayName });
  await page.reload();
  await expect(page.getByLabel("Plan creation date", { exact: true })).toHaveValue(profile.planCreationDate);
  await expect(page.getByRole("textbox", { name: "Student name (optional)" })).toHaveValue(displayName);
}

function requestBody(request) {
  try {
    return request.postDataJSON();
  } catch {
    return null;
  }
}

function isMapRequest(request, action) {
  if (!request.url().endsWith("/api/majors/map") || request.method() !== "POST") return false;
  const body = requestBody(request);
  return action === "validate-plan" ? body?.action === action : body?.action !== "validate-plan";
}

async function generatePlans(page) {
  const responsePromise = page.waitForResponse(response => isMapRequest(response.request(), "generate"));
  await page.getByRole("button", { name: /Generate my plans/ }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  await expect(page.getByRole("heading", { name: /Compare your plans|Your feasible plan/ })).toBeVisible({ timeout: 20_000 });
  return response;
}

async function choosePlan(page, label = "Plan A") {
  await page.getByRole("button", { name: new RegExp(`(?:Choose|Review selected) ${label}$`) }).click();
  await expect(page.getByRole("heading", { name: `Review ${label}` })).toBeVisible();
  await expect(page.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
}

async function savedSession(page) {
  return page.evaluate(storageKey => {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return { malformed: true, raw };
    }
  }, GENERATED_SESSION_KEY);
}

function economicsProgram(session) {
  return session?.report?.programs?.find(program => program.program?.id === "economics-base");
}

function planSignatures(session) {
  return Object.fromEntries((economicsProgram(session)?.economicsPlans || []).map(plan => [
    plan.id,
    JSON.stringify(plan.terms.map(term => ({
      slotId: term.slotId,
      courses: term.courses.map(course => ({
        requirementId: course.requirementId,
        course: course.course,
        section: course.section || "",
        selectedOptionId: course.selectedOptionId || ""
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    })))
  ]));
}

async function scanWcagAa(page, state) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
  await test.info().attach(`axe-${state.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`, {
    body: JSON.stringify(results, null, 2),
    contentType: "application/json"
  });
  const findings = results.violations.map(violation => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.flatMap(node => node.target)
  }));
  expect.soft(findings, `${state} has automated WCAG AA violations`).toEqual([]);
}

async function assertVisibleFocus(page, label) {
  const focus = await page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return { focusVisible: false, indicator: false };
    const style = window.getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      indicator: (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0)
        || style.boxShadow !== "none"
    };
  });
  expect.soft(focus.focusVisible, `${label} should match :focus-visible`).toBe(true);
  expect.soft(focus.indicator, `${label} should have a visible focus indicator`).toBe(true);
}

async function assertTabsReferencePanels(page) {
  const tabs = page.getByRole("tablist", { name: "Generated plans" }).getByRole("tab");
  expect(await tabs.count()).toBeGreaterThan(0);
  for (const tab of await tabs.all()) {
    const controls = await tab.getAttribute("aria-controls");
    const tabId = await tab.getAttribute("id");
    expect.soft(controls, `${await tab.innerText()} needs aria-controls`).toBeTruthy();
    expect.soft(tabId, `${await tab.innerText()} needs an id`).toBeTruthy();
    if (!controls) continue;
    const panel = page.locator(`[role="tabpanel"]#${controls}`);
    expect.soft(await panel.count(), `${await tab.innerText()} must reference one panel`).toBe(1);
    if (await panel.count()) expect.soft(await panel.getAttribute("aria-labelledby")).toBe(tabId);
  }
}

async function assertNoHorizontalOverflow(page, label) {
  const measurement = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const overflowing = [...document.body.querySelectorAll("*")]
      .map(element => ({
        element: element.tagName.toLowerCase(),
        className: typeof element.className === "string" ? element.className : "",
        right: Math.round(element.getBoundingClientRect().right)
      }))
      .filter(item => item.right > viewportWidth + 1)
      .slice(0, 10);
    return {
      overflow: document.documentElement.scrollWidth - viewportWidth,
      viewportWidth,
      overflowing
    };
  });
  expect.soft(measurement.overflow, `${label}: ${JSON.stringify(measurement)}`).toBeLessThanOrEqual(1);
}

function mainGenerationStatus(page) {
  return page.locator(".generate-card p.status[role='status']");
}

function planEditStatus(page) {
  return page.locator(".plan-edit-status[role='status']");
}

test.beforeEach(async ({ page }) => {
  await resetPlanner(page);
});

test("@pr timing-sensitive generation is single-flight, rejects stale answers, and recovers", async ({ page }) => {
  await seedStudent(page);
  const started = deferred();
  const release = deferred();
  let generationRequests = 0;

  await page.route("**/api/majors/map", async route => {
    if (isMapRequest(route.request(), "generate")) {
      generationRequests += 1;
      started.resolve();
      await release.promise;
    }
    await route.continue();
  });

  const generate = page.locator("button.generate-button");
  await generate.evaluate(button => {
    button.click();
    button.click();
  });
  await started.promise;
  await expect(generate).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("Building your economics plan");
  expect(generationRequests).toBe(1);

  const changedDate = "2026-08-24";
  await page.getByLabel("Plan creation date", { exact: true }).fill(changedDate);
  await expect(page.getByLabel("Plan creation date", { exact: true })).toHaveValue(changedDate);
  release.resolve();

  await expect(generate).toBeEnabled({ timeout: 20_000 });
  expect(generationRequests).toBe(1);
  await expect(mainGenerationStatus(page)).toContainText(
    "Your answers changed while plans were being generated. Generate again with the current answers."
  );
  await expect(page.getByRole("heading", { name: "Build your economics course plan" })).toBeVisible();
  expect(await savedSession(page)).toBeNull();
  await scanWcagAa(page, "stale-generation-response");

  await page.unroute("**/api/majors/map");
  await generatePlans(page);
  await expect(page.getByRole("heading", { name: /Compare your plans|Your feasible plan/ })).toBeVisible();
});

test("@pr HTTP generation failure preserves inputs, accessible feedback, focus, and recovery", async ({ page }) => {
  await seedStudent(page);
  await page.route("**/api/majors/map", route => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "The planner is temporarily unavailable. Try again." })
  }));

  const generate = page.locator("button.generate-button");
  await generate.focus();
  await page.keyboard.press("Enter");
  await expect(generate).toBeEnabled();
  await expect(mainGenerationStatus(page)).toContainText("The planner is temporarily unavailable. Try again.");
  await expect(page.getByRole("textbox", { name: "Student name (optional)" })).toHaveValue("Task 20 Student");
  await expect(page.getByLabel("Plan creation date", { exact: true })).toHaveValue(PROJECTED_MOVE_PROFILE.planCreationDate);
  await expect.soft(generate, "Focus should return to Generate after an HTTP failure").toBeFocused();
  await assertVisibleFocus(page, "Generate button after HTTP failure");
  await scanWcagAa(page, "http-generation-failure");

  await page.unroute("**/api/majors/map");
  await generatePlans(page);
});

test("@pr timing-sensitive in-memory edit lock blocks duplicate clicks and releases after success, failure, and abort", async ({ page }) => {
  await seedStudent(page);
  await generatePlans(page);
  await choosePlan(page, "Plan C");

  const initialSession = await savedSession(page);
  const initialSignatures = planSignatures(initialSession);
  const remove = page.getByRole("button", { name: "Remove ECO 214" });
  const started = deferred();
  const release = deferred();
  let simultaneousRequests = 0;

  await page.route("**/api/majors/map", async route => {
    if (!isMapRequest(route.request(), "validate-plan")) {
      await route.continue();
      return;
    }
    simultaneousRequests += 1;
    started.resolve();
    await release.promise;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "The repeated edit was stopped safely." })
    });
  });

  await remove.evaluate(button => {
    button.click();
    button.click();
  });
  await started.promise;
  await expect(page.getByRole("button", { name: "Checking..." })).toBeDisabled();
  expect(simultaneousRequests).toBe(1);
  release.resolve();
  await expect(planEditStatus(page)).toContainText("The repeated edit was stopped safely.");
  expect(planSignatures(await savedSession(page))).toEqual(initialSignatures);
  await page.unroute("**/api/majors/map");

  const successfulMove = page.waitForResponse(response => isMapRequest(response.request(), "validate-plan"));
  await page.getByRole("combobox", { name: "Move ECO 214 to another term" }).selectOption("winter-2028");
  expect((await successfulMove).status()).toBe(200);
  await expect(planEditStatus(page)).toContainText("Plan C was updated and remains valid.");
  const afterSuccess = planSignatures(await savedSession(page));
  expect(afterSuccess["plan-3"]).not.toBe(initialSignatures["plan-3"]);
  for (const planId of ["plan-1", "plan-2"]) {
    expect(afterSuccess[planId]).toBe(initialSignatures[planId]);
  }
  await expect(page.getByRole("button", { name: "Undo last plan edit" })).toHaveCount(1);

  const failureResponse = page.waitForResponse(response => isMapRequest(response.request(), "validate-plan"));
  await page.getByRole("button", { name: "Remove ECO 214" }).focus();
  await page.keyboard.press("Enter");
  expect((await failureResponse).status()).toBe(422);
  await expect(planEditStatus(page)).toContainText("That plan change cannot be saved");
  expect(planSignatures(await savedSession(page))).toEqual(afterSuccess);

  await page.route("**/api/majors/map", async route => {
    if (isMapRequest(route.request(), "validate-plan")) {
      await route.abort("aborted");
      return;
    }
    await route.continue();
  });
  const abortedRequest = page.waitForEvent("requestfailed", request => isMapRequest(request, "validate-plan"));
  await page.getByRole("button", { name: "Remove ECO 214" }).click();
  await abortedRequest;
  await expect(planEditStatus(page)).not.toBeEmpty();
  expect(planSignatures(await savedSession(page))).toEqual(afterSuccess);
  await page.unroute("**/api/majors/map");

  const afterAbortResponse = page.waitForResponse(response => isMapRequest(response.request(), "validate-plan"));
  await page.getByRole("button", { name: "Remove ECO 214" }).click();
  expect((await afterAbortResponse).status()).toBe(422);
  expect(planSignatures(await savedSession(page))).toEqual(afterSuccess);
  expect(simultaneousRequests).toBe(1);
});

test("@pr timing-sensitive PDF download is single-flight and preserves the selected plan", async ({ page }) => {
  await seedStudent(page);
  await generatePlans(page);
  await choosePlan(page, "Plan A");
  const before = await savedSession(page);
  const selectedPlanId = before.selectedPlanId;
  const started = deferred();
  const release = deferred();
  let reportRequests = 0;
  let downloadEvents = 0;
  page.on("download", () => { downloadEvents += 1; });

  await page.route("**/api/reports/economics", async route => {
    reportRequests += 1;
    started.resolve();
    await release.promise;
    await route.fulfill({
      status: 200,
      contentType: "application/pdf",
      headers: { "Content-Disposition": "attachment; filename=Task-20-EconPlanner.pdf" },
      body: Buffer.from("%PDF-1.4\n% Task 20 fictional PDF\n%%EOF\n")
    });
  });

  const download = page.getByRole("button", { name: "Download PDF" });
  await download.evaluate(button => {
    button.click();
    button.click();
  });
  await started.promise;
  await expect(page.getByRole("button", { name: "Creating PDF..." })).toBeDisabled();
  expect.soft(reportRequests, "Two immediate DOM clicks must start only one PDF request").toBe(1);
  release.resolve();
  await expect(page.locator(".pdf-download-status[role='status']")).toContainText("PDF downloaded.");
  await expect.poll(() => downloadEvents).toBeGreaterThanOrEqual(1);
  expect.soft(downloadEvents, "One PDF request must create only one browser download").toBe(1);
  expect.soft(reportRequests, "Repeated Download clicks must not duplicate the request").toBe(1);
  expect((await savedSession(page)).selectedPlanId).toBe(selectedPlanId);
  await assertTabsReferencePanels(page);
});

test("@nightly aborted and timed-out generation failures remain understandable and recoverable", async ({ page }) => {
  for (const failure of [
    { name: "aborted", code: "aborted" },
    { name: "timed-out", code: "timedout" }
  ]) {
    await resetPlanner(page);
    await seedStudent(page);
    await page.route("**/api/majors/map", async route => {
      if (isMapRequest(route.request(), "generate")) {
        await route.abort(failure.code);
        return;
      }
      await route.continue();
    });

    const generate = page.locator("button.generate-button");
    const failedRequest = page.waitForEvent("requestfailed", request => isMapRequest(request, "generate"));
    await generate.focus();
    await page.keyboard.press("Enter");
    await failedRequest;
    await expect(generate).toBeEnabled();
    const message = (await mainGenerationStatus(page).textContent())?.trim() || "";
    expect.soft(message, `${failure.name} generation needs an announced error`).not.toBe("");
    expect.soft(message, `${failure.name} generation should use student-friendly language`).not.toMatch(/failed to fetch|networkerror|undefined|null/i);
    await expect.soft(generate, `Focus should return to Generate after ${failure.name} generation`).toBeFocused();
    await assertVisibleFocus(page, `Generate button after ${failure.name} request`);
    await expect(page.getByRole("textbox", { name: "Student name (optional)" })).toHaveValue("Task 20 Student");
    expect(await savedSession(page)).toBeNull();
    await scanWcagAa(page, `${failure.name}-generation`);
    await page.unroute("**/api/majors/map");
  }

  await generatePlans(page);
});

test("@nightly malformed generation JSON is rejected without storing a false plan and can recover", async ({ page }) => {
  await seedStudent(page);
  await page.route("**/api/majors/map", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "{ this is not valid JSON"
  }));

  const generate = page.locator("button.generate-button");
  const responsePromise = page.waitForResponse(response => isMapRequest(response.request(), "generate"));
  await generate.focus();
  await page.keyboard.press("Enter");
  await responsePromise;
  await expect(generate).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Build your economics course plan" })).toBeVisible();
  await expect(page.locator("main.comparison-page")).toHaveCount(0);
  await expect(mainGenerationStatus(page)).toHaveText("The planner returned an invalid response. Please try again.");
  await expect(mainGenerationStatus(page)).not.toContainText("Failed to fetch");
  expect(await savedSession(page), "Malformed JSON must not create a stored generated session").toBeNull();
  await expect(page.getByRole("textbox", { name: "Student name (optional)" })).toHaveValue("Task 20 Student");
  await expect(page.getByLabel("Plan creation date", { exact: true })).toHaveValue(PROJECTED_MOVE_PROFILE.planCreationDate);
  await expect(page.getByRole("group", { name: "Status for ECO 113" })
    .getByRole("button", { name: "Completed", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(generate).toBeFocused();
  await assertVisibleFocus(page, "Generate button after malformed response");
  await scanWcagAa(page, "malformed-generation-response");
  await page.unroute("**/api/majors/map");
  await generatePlans(page);
});

test("@nightly navigation, reload, recoverable PDF failure, and obsolete sessions preserve safe state", async ({ page }) => {
  test.setTimeout(90_000);
  await seedStudent(page);
  await generatePlans(page);
  await choosePlan(page, "Plan B");
  const before = await savedSession(page);
  expect(before.selectedPlanId).toBe("plan-2");

  const remove = page.getByRole("button", { name: "Remove ECO 214" });
  const editFailure = page.waitForResponse(response => isMapRequest(response.request(), "validate-plan"));
  await remove.focus();
  await page.keyboard.press("Enter");
  expect((await editFailure).status()).toBe(422);
  await expect(planEditStatus(page)).toContainText("That plan change cannot be saved");
  await expect.soft(remove, "Focus should return to the edited control after validation fails").toBeFocused();
  await assertVisibleFocus(page, "plan-edit control after validation failure");
  expect((await savedSession(page)).selectedPlanId).toBe("plan-2");

  await page.route("**/api/reports/economics", route => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "PDF creation is temporarily unavailable. Your selected plan is still saved." })
  }));
  const download = page.getByRole("button", { name: "Download PDF" });
  await download.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".pdf-download-status[role='status']")).toContainText("Your selected plan is still saved.");
  await expect.soft(download, "Focus should return to Download PDF after a recoverable failure").toBeFocused();
  await assertVisibleFocus(page, "Download button after recoverable failure");
  expect((await savedSession(page)).selectedPlanId).toBe("plan-2");
  await assertTabsReferencePanels(page);
  await scanWcagAa(page, "selected-plan-pdf-failure");

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Compare your plans" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Review Plan B" })).toBeVisible();
  await assertTabsReferencePanels(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Review Plan B" })).toBeVisible();
  expect((await savedSession(page)).selectedPlanId).toBe("plan-2");

  await page.evaluate(storageKey => {
    const saved = JSON.parse(window.sessionStorage.getItem(storageKey));
    saved.schemaVersion = 5;
    window.sessionStorage.setItem(storageKey, JSON.stringify(saved));
  }, GENERATED_SESSION_KEY);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Build your economics course plan" })).toBeVisible();
  await expect(mainGenerationStatus(page)).toContainText("no longer available");
  expect(await savedSession(page)).toBeNull();

  await page.evaluate(storageKey => {
    window.sessionStorage.setItem(storageKey, "{ obsolete malformed session");
    window.history.replaceState({}, "", "/?layout=apple&view=plan&plan=plan-2");
  }, GENERATED_SESSION_KEY);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Build your economics course plan" })).toBeVisible();
  await expect(mainGenerationStatus(page)).toContainText("no longer available");
  expect(await savedSession(page)).toBeNull();
  await expect(page.getByRole("textbox", { name: "Student name (optional)" })).toHaveValue("Task 20 Student");
});

test("@nightly transfer validation and prerequisite dialog semantics survive narrow failure states", async ({ page }) => {
  await resetPlanner(page, { viewport: { width: 320, height: 700 } });
  const transferTrigger = page.getByRole("button", { name: "Transfer students: Change graduation year" });
  await transferTrigger.focus();
  await page.keyboard.press("Enter");
  const transferRegion = page.getByRole("region", { name: "Transfer student planning" });
  const alert = transferRegion.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert.getByRole("list")).toHaveCount(1);
  await expect(alert.getByRole("listitem")).toHaveCount(2);
  await expect(alert).toContainText("Choose an expected graduation year");
  await expect(alert).toContainText("Choose when you first enrolled at Hanover");
  await scanWcagAa(page, "narrow-transfer-validation");
  await assertNoHorizontalOverflow(page, "narrow transfer validation");

  await page.getByRole("button", { name: "Use regular class-year choices" }).click();
  const inProgress213 = page
    .getByRole("group", { name: "Status for ECO 213" })
    .getByRole("button", { name: "In progress", exact: true });
  await inProgress213.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Confirm prerequisites for ECO 213" });
  await expect(dialog).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(inProgress213).toBeFocused();
  await assertVisibleFocus(page, "ECO 213 after prerequisite dialog closes");
  await assertNoHorizontalOverflow(page, "narrow dialog recovery");
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
  { name: "narrow", width: 320, height: 700 }
]) {
  test(`@nightly ${viewport.name} extreme fictional content remains accessible without avoidable overflow`, async ({ page }) => {
    const longName = "Alexandria Montgomery-Worthington the Fictional Transfer Economics Student ".repeat(5).trim();
    await resetPlanner(page, { viewport });
    await seedStudent(page, PROJECTED_MOVE_PROFILE, longName);
    await page.route("**/api/majors/map", async route => {
      if (!isMapRequest(route.request(), "generate")) {
        await route.continue();
        return;
      }
      const upstream = await route.fetch();
      const data = await upstream.json();
      const economics = data.programs?.find(program => program.program?.id === "economics-base");
      economics.catalog = economics.catalog || {};
      economics.catalog.advisorAttention = Array.from({ length: 12 }, (_, index) => ({
        code: `TASK20-ADVISOR-${index + 1}`,
        severity: index % 2 ? "warning" : "info",
        title: `Fictional advisor notice ${index + 1}`,
        message: `Confirm this intentionally long fictional advising condition ${index + 1} before registration because several independent details may require review.`,
        findings: [{
          code: `TASK20-FINDING-${index + 1}`,
          message: `Fictional finding ${index + 1} includes enough words to verify wrapping without changing academic planning behavior.`
        }]
      }));
      for (const plan of economics.economicsPlans || []) {
        plan.description = `${plan.description} This deliberately long fictional strategy description verifies that plan summaries wrap on narrow screens without hiding information.`;
        plan.studentMessages = Array.from({ length: 12 }, (_, index) => (
          `Fictional warning ${index + 1}: confirm a deliberately detailed condition with an advisor before registration.`
        ));
        plan.validation = {
          ...plan.validation,
          warnings: Array.from({ length: 12 }, (_, index) => `Fictional validation warning ${index + 1}`)
        };
        plan.feasibility = {
          ...plan.feasibility,
          requiredApprovals: Array.from({ length: 12 }, (_, index) => ({
            course: `ECO ${700 + index}`,
            prerequisite: `TEST ${100 + index}`,
            term: `Fictional term ${index + 1}`,
            authority: "Fictional approval authority",
            message: `Fictional approval ${index + 1} has a long explanation that must remain readable and must not force horizontal scrolling.`
          }))
        };
        for (const term of plan.terms || []) {
          for (const course of term.courses || []) {
            course.title = `Fictional ${course.course} title with extended interdisciplinary economic analysis, quantitative reasoning, public policy, and historical context`;
          }
        }
      }
      await route.fulfill({ response: upstream, json: data });
    });

    await generatePlans(page);
    await expect(page.getByText(longName, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Advisor Attention" })).toBeVisible();
    await assertNoHorizontalOverflow(page, `${viewport.name} extreme comparison`);
    await scanWcagAa(page, `${viewport.name}-extreme-comparison`);

    await page.getByRole("button", { name: /Review selected Plan/ }).click();
    await expect(page.getByText("Plan conditions and warnings", { exact: true })).toBeVisible();
    await expect(page.getByText(/Fictional approval 12/)).toBeVisible();
    await expect(page.getByText(/Fictional warning 12/)).toBeVisible();
    await expect(page.getByText(/extended interdisciplinary economic analysis/).first()).toBeVisible();
    await assertTabsReferencePanels(page);
    await assertNoHorizontalOverflow(page, `${viewport.name} extreme selected plan`);
    await scanWcagAa(page, `${viewport.name}-extreme-selected-plan`);
  });
}
