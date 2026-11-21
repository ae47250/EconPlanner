import { expect, test } from "@playwright/test";
import { encodeState } from "../../lib/planning/mcp-state.js";
import { planForEdit } from "../../lib/planning/mcp-tools.js";
import { compactEconomicsPlanForValidation } from "../../lib/planning/validation-payload.js";

const student = {
  planCreationDate: "2026-11-20",
  academicStanding: "freshman",
  planningPace: "one_year_early",
  courses: [{ code: "ECO 113", status: "in_progress" }]
};

async function editedPlanToken(request) {
  const generatedResponse = await request.post("/api/majors/map", { data: { student } });
  expect(generatedResponse.ok()).toBeTruthy();
  const generated = await generatedResponse.json();
  let plans = generated.programs.find(entry => entry.program.id === "economics-base").economicsPlans;
  let balanced = plans.find(plan => plan.id === "balanced");
  const fromTerm = balanced.terms.find(term => term.slotId === "fall-2027");
  const mat113 = fromTerm.courses.find(course => course.course === "MAT 113");
  const courseId = mat113.requirementId || `${mat113.course}-${mat113.source || "course"}`;
  for (const [fromTermId, toTermId] of [["fall-2027", "winter-2027"], ["winter-2027", "winter-2028"]]) {
    const editedResponse = await request.post("/api/majors/map", { data: {
      action: "validate-plan", student, plan: compactEconomicsPlanForValidation(balanced),
      plans: plans.map(compactEconomicsPlanForValidation),
      edit: { type: "move", planId: "balanced", courseId, fromTermId, toTermId }
    } });
    expect(editedResponse.ok()).toBeTruthy();
    const edited = await editedResponse.json();
    expect(edited.plan.validation.valid).toBe(true);
    balanced = edited.plan;
    plans = plans.map(plan => plan.id === "balanced" ? balanced : plan);
  }
  const stateToken = encodeState({
    student, plans: plans.map(planForEdit), fingerprint: generated.plannerFingerprint
  }, process.env.ECONPLANNER_MCP_STATE_KEY);
  return { stateToken, balanced };
}

function link(stateToken, planId = "balanced") {
  return `/#openPlan=${encodeURIComponent(stateToken)}&plan=${encodeURIComponent(planId)}`;
}

test("a fresh browser opens the edited Balanced plan and offers its existing PDF button", async ({ browser, request }) => {
  test.setTimeout(90000);
  const { stateToken } = await editedPlanToken(request);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(link(stateToken));
    const card = page.locator("article.comparison-plan-card.is-selected");
    await expect(card.getByRole("heading", { name: "Balanced", exact: true })).toBeVisible({ timeout: 60000 });
    await expect(card.locator('[data-term-id="winter-2028"]')).toContainText("MAT 113");
    await expect(card).toContainText(/ECO 213.*approval|approval.*ECO 213/i);
    const pdfButton = card.getByRole("button", { name: "Download PDF Report: Balanced" });
    await expect(pdfButton).toBeVisible();
    let pdfRequest;
    await page.route("**/api/reports/economics", async route => {
      pdfRequest = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4\n%%EOF\n" });
    });
    const download = page.waitForEvent("download");
    await pdfButton.click();
    await download;
    expect(pdfRequest.selectedPlan.id).toBe("balanced");
    expect(pdfRequest.selectedPlan.terms.find(term => term.slotId === "winter-2028")
      .courses.some(course => course.course === "MAT 113")).toBe(true);
    expect(pdfRequest.selectedPlan.conditions.some(item => item.affectedObject?.course === "ECO 213")).toBe(true);
    expect(new URL(page.url()).hash).toBe("");
  } finally {
    await context.close();
  }
});

test("a chat handoff keeps Winter and May study abroad context through the web PDF request", async ({ browser, request }) => {
  test.setTimeout(90000);
  const abroadStudent = {
    planCreationDate: "2026-11-21", academicStanding: "sophomore", courses: [],
    studyAbroadTerm: "winter-2028", studyAbroadMayOverlap: true,
    reservedCourseUnits: { "winter-2028": 4, "spring-2028": 1 },
    studyAbroadDestination: "Australia is one possible destination.",
    studyAbroadAdvisingNote: "Some courses taken abroad, especially Economics electives, may count toward Hanover’s Economics major. Check with your advisor once your course list is available."
  };
  const generatedResponse = await request.post("/api/majors/map", { data: { student: abroadStudent } });
  expect(generatedResponse.ok()).toBeTruthy();
  const generated = await generatedResponse.json();
  const plans = generated.programs.find(entry => entry.program.id === "economics-base").economicsPlans;
  const stateToken = encodeState({
    student: abroadStudent, plans: plans.map(planForEdit), fingerprint: generated.plannerFingerprint
  }, process.env.ECONPLANNER_MCP_STATE_KEY);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(link(stateToken));
    const card = page.locator('article.comparison-plan-card[data-plan-id="balanced"]');
    await expect(card.locator('tr[data-term-id="winter-2028"] .comparison-empty-term')).toHaveText("Study abroad", { timeout: 60000 });
    await expect(card.locator('tr[data-term-id="spring-2028"] .comparison-empty-term')).toHaveText("Study abroad");
    await expect(card.locator("[data-student-advisor-context]")).not.toContainText(abroadStudent.studyAbroadDestination);
    await expect(card.locator("[data-student-advisor-context]")).toContainText(abroadStudent.studyAbroadAdvisingNote);
    let pdfRequest;
    await page.route("**/api/reports/economics", async route => {
      pdfRequest = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4\n%%EOF\n" });
    });
    const download = page.waitForEvent("download");
    await card.getByRole("button", { name: "Download PDF Report: Balanced" }).click();
    await download;
    expect(pdfRequest.student.studyAbroadMayOverlap).toBe(true);
    expect(pdfRequest.student.reservedCourseUnits).toMatchObject(abroadStudent.reservedCourseUnits);
    expect(pdfRequest.student.studyAbroadDestination).toBe(abroadStudent.studyAbroadDestination);
    expect(pdfRequest.student.studyAbroadAdvisingNote).toBe(abroadStudent.studyAbroadAdvisingNote);
  } finally {
    await context.close();
  }
});

test("expired, altered, and wrong-plan links show an error without loading a plan", async ({ browser, request }) => {
  test.setTimeout(90000);
  const { stateToken } = await editedPlanToken(request);
  const now = Date.now();
  const originalNow = Date.now;
  Date.now = () => now - 2 * 60 * 60 * 1000;
  let expiredToken;
  try {
    expiredToken = encodeState({ student, plans: [{ id: "balanced", terms: [] }], fingerprint: "expired" },
      process.env.ECONPLANNER_MCP_STATE_KEY);
  } finally {
    Date.now = originalNow;
  }
  const alteredToken = `${stateToken.slice(0, -1)}${stateToken.endsWith("A") ? "B" : "A"}`;
  for (const [token, planId] of [[expiredToken, "balanced"], [alteredToken, "balanced"], [stateToken, "unknown-plan"]]) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(link(token, planId));
      await expect(page.getByRole("heading", { name: "Could not open this plan" })).toBeVisible();
      await expect(page.locator('main [role="alert"]')).toContainText(/invalid|expired|current/i);
      await expect(page.locator("article.comparison-plan-card")).toHaveCount(0);
      expect(new URL(page.url()).hash).toBe("");
    } finally {
      await context.close();
    }
  }
});
