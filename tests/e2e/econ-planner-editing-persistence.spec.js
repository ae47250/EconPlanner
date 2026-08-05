import { expect, test } from "./nightly-observability.js";

const UI_STORAGE_KEY = "econ-planner-ui-state";
const GENERATED_SESSION_KEY = "econ-planner-generated-session";

const PROJECTED_MOVE_PROFILE = Object.freeze({
  academicStanding: "sophomore",
  planCreationDate: "2026-07-30",
  courses: [
    "ECO 113", "ECO 114", "MAT 113", "MAT 217", "BUSN 323",
    "ECO 161", "ECO 221", "ECO 234", "ECO 260"
  ]
});

const CONCURRENT_CAPSTONE_PROFILE = Object.freeze({
  academicStanding: "senior",
  planCreationDate: "2026-07-30",
  courses: [
    "ECO 113", "ECO 213", "MAT 113", "MAT 217", "BUSN 323",
    "ECO 161", "ECO 221", "ECO 234", "ECO 260"
  ]
});

function electiveProfile(statisticsCourse) {
  return {
    academicStanding: "senior",
    planCreationDate: "2026-07-30",
    courses: [
      "ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113",
      statisticsCourse, "BUSN 323"
    ]
  };
}

async function resetPlanner(page) {
  await page.goto("/?layout=apple");
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Build your economics course plan" })).toBeVisible();
}

async function seedStudent(page, profile) {
  await page.evaluate(({ storageKey, student }) => {
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
        displayName: "Task 16 Student",
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
  }, { storageKey: UI_STORAGE_KEY, student: profile });
  await page.reload();
  await expect(page.getByLabel("Plan creation date", { exact: true })).toHaveValue(profile.planCreationDate);
  await expect(page.getByRole("group", { name: "Class standing" })
    .getByRole("button", { name: profile.academicStanding, exact: false }))
    .toHaveAttribute("aria-pressed", "true");
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
  await expect(page.getByRole("heading", { name: /Compare your plans|Your feasible plan/ })).toBeVisible({ timeout: 15000 });
  await expect.poll(() => savedSession(page)).not.toBeNull();
}

async function choosePlan(page, label) {
  await page.getByRole("button", { name: new RegExp(`(?:Choose|Review selected) ${label}$`) }).click();
  await expect(page.getByRole("heading", { name: `Review ${label}` })).toBeVisible();
  await expect(page.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
}

async function savedSession(page) {
  return page.evaluate(storageKey => {
    const raw = window.sessionStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  }, GENERATED_SESSION_KEY);
}

function economicsProgram(session) {
  return session?.report?.programs?.find(program => program.program?.id === "economics-base");
}

function semanticPlan(plan) {
  return JSON.stringify({
    id: plan.id,
    terms: plan.terms.map(term => ({
      slotId: term.slotId,
      courses: term.courses.map(course => ({
        requirementId: course.requirementId,
        course: course.course,
        section: course.section || "",
        selectedOptionId: course.selectedOptionId || "",
        approvals: (course.approvalRequired || []).map(approval => ({
          authority: approval.authority,
          course: approval.course,
          term: approval.term
        }))
      })).sort((left, right) => (
        `${left.requirementId}:${left.course}:${left.section}`
          .localeCompare(`${right.requirementId}:${right.course}:${right.section}`)
      ))
    }))
  });
}

function savedPlanSignatures(session) {
  return Object.fromEntries((economicsProgram(session)?.economicsPlans || [])
    .map(plan => [plan.id, semanticPlan(plan)]));
}

async function waitForSavedPlanSignature(page, planId, expectedSignature) {
  await expect.poll(async () => savedPlanSignatures(await savedSession(page))[planId]).toBe(expectedSignature);
}

async function editResponse(page, action) {
  const responsePromise = page.waitForResponse(response => isMapRequest(response.request(), "validate-plan"));
  await action();
  return responsePromise;
}

function statusMessage(page, text) {
  return page.getByRole("status").filter({ hasText: text });
}

async function forgeEco257Elective(page) {
  return page.evaluate(async ({ sessionKey, uiKey }) => {
    const session = JSON.parse(window.sessionStorage.getItem(sessionKey));
    const storedInput = JSON.parse(window.localStorage.getItem(uiKey));
    const economics = session.report.programs.find(program => program.program?.id === "economics-base");
    const plan = structuredClone(economics.economicsPlans.find(item => item.id === session.selectedPlanId));
    const elective = plan.terms.flatMap(term => term.courses)
      .find(course => String(course.requirementId || "").startsWith("eco-elective"));
    elective.course = "ECO 257";
    elective.title = "Applied Statistics";
    elective.section = "";
    elective.source = "requirement-placeholder";
    elective.offeringStatus = "schedule_confirmation_required";
    elective.verificationStatus = "unverified";
    elective.availability = { status: "unknown", seatsOpen: null, capacity: null, asOf: null };
    elective.meeting = { days: [], startMinutes: null, endMinutes: null };
    elective.provenance = {};
    delete elective.alternativeOptions;
    delete elective.selectedOptionId;

    const student = {
      ...storedInput.formData,
      courses: storedInput.formData.courses.filter(course => (
        ["completed", "transfer", "in_progress"].includes(course.status)
      ))
    };
    const plans = economics.economicsPlans.map(item => item.id === plan.id ? plan : item);
    const response = await fetch("/api/majors/map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "validate-plan", student, plan, plans })
    });
    return { status: response.status, data: await response.json() };
  }, { sessionKey: GENERATED_SESSION_KEY, uiKey: UI_STORAGE_KEY });
}

async function forgeMissingDepartmentApproval(page) {
  return page.evaluate(async ({ sessionKey, uiKey }) => {
    const session = JSON.parse(window.sessionStorage.getItem(sessionKey));
    const storedInput = JSON.parse(window.localStorage.getItem(uiKey));
    const economics = session.report.programs.find(program => program.program?.id === "economics-base");
    const plan = structuredClone(economics.economicsPlans.find(item => item.id === session.selectedPlanId));
    const capstone = plan.terms.flatMap(term => term.courses).find(course => course.course === "ECO 461");
    delete capstone.approvalRequired;
    const student = {
      ...storedInput.formData,
      courses: storedInput.formData.courses.filter(course => (
        ["completed", "transfer", "in_progress"].includes(course.status)
      ))
    };
    const plans = economics.economicsPlans.map(item => item.id === plan.id ? plan : item);
    const response = await fetch("/api/majors/map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "validate-plan", student, plan, plans })
    });
    return { status: response.status, data: await response.json() };
  }, { sessionKey: GENERATED_SESSION_KEY, uiKey: UI_STORAGE_KEY });
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await resetPlanner(page);
});

test("@pr selected-plan edits validate, preserve siblings, undo exactly, and reject invalid changes", async ({ page }) => {
  await seedStudent(page, PROJECTED_MOVE_PROFILE);
  await generatePlans(page);
  await choosePlan(page, "Plan A");

  const originalSession = await savedSession(page);
  const originalSignatures = savedPlanSignatures(originalSession);
  expect(originalSession.selectedPlanId).toBe("plan-1");

  const moveResponse = await editResponse(page, () => (
    page.getByRole("combobox", { name: "Move ECO 214 to another term" }).selectOption("winter-2028")
  ));
  expect(moveResponse.status()).toBe(200);
  await expect(statusMessage(page, "Plan A was updated and remains valid")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Move ECO 214 to another term" })).toHaveValue("winter-2028");

  const editedSession = await savedSession(page);
  const editedSignatures = savedPlanSignatures(editedSession);
  expect(editedSignatures["plan-1"]).not.toBe(originalSignatures["plan-1"]);
  for (const planId of ["plan-2", "plan-3"]) {
    expect(editedSignatures[planId]).toBe(originalSignatures[planId]);
  }
  expect(editedSession.selectedPlanId).toBe("plan-1");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Review Plan A" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Plan A" })).toHaveAttribute("aria-selected", "true");
  await waitForSavedPlanSignature(page, "plan-1", editedSignatures["plan-1"]);

  await page.getByRole("button", { name: "Undo last plan edit" }).click();
  await expect(statusMessage(page, "Plan A was restored")).toBeVisible();
  await waitForSavedPlanSignature(page, "plan-1", originalSignatures["plan-1"]);
  await expect(page.getByRole("tab", { name: "Plan A" })).toHaveAttribute("aria-selected", "true");

  const signatureBeforeRemoval = savedPlanSignatures(await savedSession(page))["plan-1"];
  const removalResponse = await editResponse(page, () => (
    page.getByRole("button", { name: "Remove ECO 214" }).click()
  ));
  expect(removalResponse.status()).toBe(422);
  await expect(statusMessage(page, "That plan change cannot be saved")).toBeVisible();
  await waitForSavedPlanSignature(page, "plan-1", signatureBeforeRemoval);

  const prerequisiteResponse = await editResponse(page, () => (
    page.getByRole("combobox", { name: "Move ECO 213 to another term" }).selectOption("spring-2029")
  ));
  expect(prerequisiteResponse.status()).toBe(422);
  const prerequisiteData = await prerequisiteResponse.json();
  expect(prerequisiteData.code).toBe("INVALID_PLAN_EDIT");
  expect(prerequisiteData.validation.errors).toContain("ECO 461 is missing prerequisites: ECO 213.");
  await waitForSavedPlanSignature(page, "plan-1", signatureBeforeRemoval);

  const offeringResponse = await editResponse(page, () => (
    page.getByRole("combobox", { name: "Move ECO 213 to another term" }).selectOption("winter-2027")
  ));
  expect(offeringResponse.status()).toBe(422);
  const offeringData = await offeringResponse.json();
  expect(offeringData.validation.errors.some(error => /ECO 213 is not verified/.test(error))).toBe(true);
  await waitForSavedPlanSignature(page, "plan-1", signatureBeforeRemoval);
  await expect(page.getByRole("button", { name: "Undo last plan edit" })).toHaveCount(0);
});

test("@pr elective replacement persists and ECO 257 stays statistics-only with MAT 217 or PSY 217", async ({ page }) => {
  for (const statisticsCourse of ["MAT 217", "PSY 217"]) {
    await resetPlanner(page);
    await seedStudent(page, electiveProfile(statisticsCourse));
    await generatePlans(page);
    await page.getByRole("button", { name: /Review selected Plan/ }).click();
    await expect(page.getByRole("heading", { name: /Review Plan/ })).toBeVisible();

    const electiveSelectors = page.getByRole("combobox", { name: /Choose elective for/ });
    await expect(electiveSelectors.first()).toBeVisible();
    const optionLabels = await electiveSelectors.locator("option").allTextContents();
    expect(optionLabels.some(label => /ECO 257/.test(label))).toBe(false);

    const before = await savedSession(page);
    const beforeSignatures = savedPlanSignatures(before);
    const forged = await forgeEco257Elective(page);
    expect(forged.status).toBe(422);
    expect(forged.data.code).toBe("INVALID_PLAN_EDIT");
    expect(forged.data.validation.errors.some(error => (
      /ECO 257 is not a valid course for requirement eco-elective/.test(error)
    ))).toBe(true);
    expect(savedPlanSignatures(await savedSession(page))).toEqual(beforeSignatures);

    if (statisticsCourse === "MAT 217") {
      const elective = electiveSelectors.first();
      const initial = await elective.inputValue();
      const alternatives = await elective.locator("option").evaluateAll(options => (
        options.map(option => option.value).filter(value => value)
      ));
      const replacement = alternatives.find(value => value !== initial);
      expect(replacement).toBeTruthy();
      const replacementResponse = await editResponse(page, () => elective.selectOption(replacement));
      expect(replacementResponse.status()).toBe(200);
      await expect(statusMessage(page, "updated and remains valid")).toBeVisible();
      await expect(elective).toHaveValue(replacement);
      const replacedSignature = savedPlanSignatures(await savedSession(page))[before.selectedPlanId];
      expect(replacedSignature).not.toBe(beforeSignatures[before.selectedPlanId]);
      await page.reload();
      await expect(page.getByRole("combobox", { name: /Choose elective for/ }).first()).toHaveValue(replacement);
      await waitForSavedPlanSignature(page, before.selectedPlanId, replacedSignature);
    }
  }
});

test("@pr manipulated approval metadata is rejected and never replaces the selected plan", async ({ page }) => {
  await seedStudent(page, CONCURRENT_CAPSTONE_PROFILE);
  await generatePlans(page);
  await page.getByRole("button", { name: /Review selected Plan/ }).click();
  await expect(page.getByText("Approval required").first()).toBeVisible();

  const before = await savedSession(page);
  const beforeSignatures = savedPlanSignatures(before);
  const forged = await forgeMissingDepartmentApproval(page);
  expect(forged.status).toBe(422);
  expect(forged.data.code).toBe("INVALID_PLAN_EDIT");
  expect(forged.data.validation.errors.some(error => /Economics Department|approval metadata/.test(error))).toBe(true);
  expect(savedPlanSignatures(await savedSession(page))).toEqual(beforeSignatures);
  await page.reload();
  expect(savedPlanSignatures(await savedSession(page))).toEqual(beforeSignatures);
});

test("@nightly browser history, reload, input changes, and stale versions control session restoration", async ({ page }) => {
  await seedStudent(page, PROJECTED_MOVE_PROFILE);
  await generatePlans(page);
  await choosePlan(page, "Plan B");
  const originalSignature = savedPlanSignatures(await savedSession(page))["plan-2"];

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Compare your plans" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review selected Plan B" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Review Plan B" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Review Plan B" })).toBeVisible();
  await waitForSavedPlanSignature(page, "plan-2", originalSignature);

  await page.getByRole("button", { name: /Back to plan comparison/ }).click();
  await page.getByRole("button", { name: /Back to course selection/ }).click();
  await page.getByRole("group", { name: "Class standing" })
    .getByRole("button", { name: "Junior" }).click();
  await expect(page.getByRole("button", { name: "Return to generated plans" })).toHaveCount(0);
  await expect.poll(() => savedSession(page)).toBeNull();

  await generatePlans(page);
  await page.getByRole("button", { name: /Choose|Review selected/ }).first().click();
  await expect(page.getByRole("heading", { name: /Review Plan/ })).toBeVisible();
  await page.evaluate(sessionKey => {
    const saved = JSON.parse(window.sessionStorage.getItem(sessionKey));
    saved.schemaVersion = 5;
    window.sessionStorage.setItem(sessionKey, JSON.stringify(saved));
  }, GENERATED_SESSION_KEY);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Build your economics course plan" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("no longer available");
  await expect.poll(() => savedSession(page)).toBeNull();
});

test("@pr interrupted, failed, and simultaneous edit requests never persist an invalid plan", async ({ page }) => {
  await seedStudent(page, PROJECTED_MOVE_PROFILE);
  await generatePlans(page);
  await choosePlan(page, "Plan A");
  const originalSignature = savedPlanSignatures(await savedSession(page))["plan-1"];
  const move = page.getByRole("combobox", { name: "Move ECO 214 to another term" });

  await page.route("**/api/majors/map", async route => {
    if (requestBody(route.request())?.action === "validate-plan") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Plan editing is temporarily unavailable." })
      });
      return;
    }
    await route.continue();
  });
  const failedResponse = await editResponse(page, () => move.selectOption("winter-2028"));
  expect(failedResponse.status()).toBe(503);
  await expect(statusMessage(page, "Plan editing is temporarily unavailable")).toBeVisible();
  await waitForSavedPlanSignature(page, "plan-1", originalSignature);
  await page.unroute("**/api/majors/map");

  await page.route("**/api/majors/map", async route => {
    if (requestBody(route.request())?.action === "validate-plan") {
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  const interruptedRequest = page.waitForEvent("requestfailed", request => isMapRequest(request, "validate-plan"));
  await move.selectOption("winter-2028");
  await interruptedRequest;
  await expect(statusMessage(page, /Failed to fetch|could not be validated/i)).toBeVisible();
  await waitForSavedPlanSignature(page, "plan-1", originalSignature);
  await page.unroute("**/api/majors/map");

  let editRequests = 0;
  let releaseRequest;
  const requestGate = new Promise(resolve => { releaseRequest = resolve; });
  await page.route("**/api/majors/map", async route => {
    if (requestBody(route.request())?.action === "validate-plan") {
      editRequests += 1;
      await requestGate;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Repeated edit test completed safely." })
      });
      return;
    }
    await route.continue();
  });
  const remove = page.getByRole("button", { name: "Remove ECO 214" });
  await remove.evaluate(button => {
    button.click();
    button.click();
  });
  await expect.poll(() => editRequests).toBe(1);
  await page.waitForTimeout(100);
  expect(editRequests).toBe(1);
  await expect(page.getByRole("button", { name: "Checking..." })).toBeDisabled();
  releaseRequest();
  await expect(statusMessage(page, "Repeated edit test completed safely")).toBeVisible();
  await waitForSavedPlanSignature(page, "plan-1", originalSignature);
  await page.unroute("**/api/majors/map");

  await page.reload();
  await expect(page.getByRole("heading", { name: "Review Plan A" })).toBeVisible();
  await waitForSavedPlanSignature(page, "plan-1", originalSignature);
  await expect(page.getByRole("button", { name: "Undo last plan edit" })).toHaveCount(0);
});
