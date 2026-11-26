import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { POST } from "../app/api/majors/map/route.js";
import { noPlanPresentation } from "../lib/planning/no-plan-presentation.js";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";

const planCreationDate = "2026-11-21";
const completed = codes => codes.map(code => ({ code, status: "completed", source: "manual_code" }));

async function economics(student) {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ student: { planCreationDate, ...student } })
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.programs.find(item => item.program?.id === "economics-base");
}

const juniorCustom = {
  academicStanding: "junior", customGraduationEnabled: true, customExpectedGraduationYear: 2027,
  courses: [...completed(["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 121", "MAT 217", "BUSN 323", "ECO 315", "ECO 337"]),
    { code: "ECO 333", status: "in_progress", source: "manual_code" }]
};

test("a junior's verified Winter 2027 ECO 321 replaces BUSN 323 in the Balanced plan", async () => {
  const result = await economics({
    academicStanding: "junior", planCreationDate: "2026-11-22",
    courses: [...completed(["ECO 113", "ECO 114", "MAT 121", "ECO 213", "MAT 217"]),
      { code: "ECO 214", status: "in_progress", source: "manual_code" }]
  });
  const plan = result.economicsPlans.find(item => item.id === "balanced");
  assert.ok(plan?.validation?.valid);
  const winter = plan.terms.find(term => term.slotId === "winter-2027");
  assert.ok(winter.courses.some(course => course.course === "ECO 321"
    && course.requirementId === "finance" && course.source === "verified-offering"));
  assert.ok(plan.terms.every(term => term.courses.every(course => course.course !== "BUSN 323")));
});

test("the verified ECO 321 preference also reaches standard junior and custom senior strategies", async () => {
  for (const student of [
    { academicStanding: "junior", courses: completed(["ECO 113", "ECO 114"]) },
    { academicStanding: "senior", customGraduationEnabled: true, customExpectedGraduationYear: 2028,
      courses: completed(["ECO 113", "ECO 114", "MAT 121"]) }
  ]) {
    const result = await economics({ ...student, planCreationDate: "2026-11-22" });
    const plan = result.economicsPlans.find(item => item.id === "balanced");
    assert.ok(plan?.validation?.valid);
    assert.ok(plan.terms.find(term => term.slotId === "winter-2027").courses.some(course => (
      course.course === "ECO 321" && course.requirementId === "finance"
    )));
    assert.ok(plan.terms.every(term => term.courses.every(course => course.course !== "BUSN 323")));
  }
});

test("a senior with no history counts the math cognate among required courses left", async () => {
  const result = await economics({ academicStanding: "senior", planCreationDate: "2026-11-22", courses: [] });
  assert.equal(result.economicsPlanResult.reason, "MAJOR_COURSE_CAPACITY_EXCEEDED");
  assert.equal(result.economicsPlanResult.evidence.blockingReasons[0].remainingRequiredCourses, 12);
  assert.equal(result.economicsPlanResult.evidence.blockingReasons[0].message,
    "You have 12 required courses left and 2 terms left by May 2027. Even with a full course load each term, they cannot all fit. Choose a later graduation year or talk with your advisor.");
});

test("failed early planning shows one grouped sentence without unscheduled fragments", async () => {
  const result = await economics({
    academicStanding: "junior", planningPace: "one_year_early", planCreationDate: "2026-11-22",
    courses: completed(["ECO 113", "ECO 114"])
  });
  const reasons = result.economicsCandidateOutcomes.find(item => item.id === "one-year-early").reasons
    .filter(item => item.studentVisible !== false);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0].message, /^These requirements did not fit by May 2027:/);
  assert.doesNotMatch(reasons[0].message, /remains unscheduled|\.\s*;/);
  assert.equal(result.economicsPlanningGaps.length, 0);
});

test("a custom target exactly one year early produces a validated ECO 461 plan and report warning", async () => {
  const result = await economics(juniorCustom);
  assert.equal(result.planningContext.acceleratedPlanAssumesSeniorStanding, true);
  assert.equal(result.economicsPlanResult.category, "PLANS_READY");
  const plan = result.economicsPlans[0];
  assert.ok(plan?.validation?.valid);
  assert.equal(plan.readinessStatus, "READY_WITH_CONDITIONS");
  assert.equal(plan.planDisposition, "COMPLETE_READY_WITH_CONDITIONS");
  assert.ok(plan.terms.some(term => term.courses.some(course => course.course === "ECO 461")));
  const warning = plan.planConditions.find(item => item.kind === "standing")?.message;
  assert.match(warning, /advisor and the Registrar to confirm you can take ECO 461/);

  const report = await buildEconomicsReportFromStudent({ planCreationDate, ...juniorCustom }, planCreationDate, plan, result.economicsPlans);
  const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");
  const html = renderEconomicsHtml(report, template);
  assert.ok(html.includes(warning));
  assert.ok(report.planConditions.some(item => item.message === warning));
  assert.ok(report.planConditions.some(item => /Confirm the student will be eligible for ECO 461/.test(item.advisorPrompt || "")));
});

test("the one-year-early target also needs confirmation when ECO 461 relies on assumed senior standing", async () => {
  const result = await economics({ ...juniorCustom, customGraduationEnabled: false, customExpectedGraduationYear: undefined, planningPace: "one_year_early" });
  const plan = result.economicsPlans.find(item => item.id === "one-year-early");
  assert.ok(plan?.validation?.valid);
  assert.equal(plan.planningContext.acceleratedPlanAssumesSeniorStanding, true);
  assert.equal(plan.readinessStatus, "READY_WITH_CONDITIONS");
  assert.equal(plan.planDisposition, "COMPLETE_READY_WITH_CONDITIONS");
});

test("a custom target more than one year early reports proven senior-standing infeasibility", async () => {
  const result = await economics({
    academicStanding: "freshman", customGraduationEnabled: true, customExpectedGraduationYear: 2028,
    courses: [...completed(["ECO 114"]), { code: "ECO 113", status: "in_progress", source: "manual_code" }]
  });
  assert.equal(result.planningContext.acceleratedPlanAssumesSeniorStanding, false);
  assert.deepEqual(result.economicsPlans, []);
  assert.equal(result.economicsPlanResult.category, "INFEASIBLE_PROVEN");
  assert.equal(result.economicsPlanResult.reason, "CAPSTONE_SENIOR_STANDING_NO_ELIGIBLE_WINTER");
  const presentation = noPlanPresentation(result.economicsPlanResult.category, result.economicsPlanResult.reason, result.economicsPlanResult.evidence);
  assert.match(presentation.message, /ECO 461 requires senior standing and is offered only in Winter/);

  // The rule proves this result, so the full search is skipped and there are no search gaps. For a
  // proven result the screen explains it with the blocking reasons only (plannerSummary.js), so check those.
  const reasons = result.economicsPlanResult.evidence.blockingReasons;
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].code, "CAPSTONE_SENIOR_STANDING_NO_ELIGIBLE_WINTER");
  assert.match(reasons[0].message, /^ECO 461 requires senior standing and is offered only in Winter\./);
  assert.equal(result.economicsPlanningGaps.some(item => /remains unscheduled/.test(item.reason || item.message || "")), false);
});

test("AP or exam credit produces a visible advisor-attention reason", async () => {
  const result = await economics({
    academicStanding: "freshman",
    courses: ["ECO 113", "ECO 114"].map(code => ({ code, status: "completed", source: "ap_credit" }))
  });
  assert.equal(result.economicsPlans[0].readinessStatus, "ADVISOR_ACTION_REQUIRED");
  const review = result.economicsPlans[0].planConditions.find(item => item.kind === "review" && item.shortMessage);
  assert.equal(review.shortMessage, "Your advisor needs to confirm that your AP credit for ECO 113 and ECO 114 counts toward the major.");
});

test("sophomore early abroad plan uses consistent prerequisite and department-approval wording in the PDF", async () => {
  const student = {
    academicStanding: "sophomore", planningPace: "one_year_early", planCreationDate,
    studyAbroadTerm: "fall-2027", courses: [...completed(["ECO 113"]), { code: "ECO 114", status: "in_progress" }]
  };
  const result = await economics(student);
  const plan = result.economicsPlans.find(item => item.id === "one-year-early");
  assert.ok(plan);
  // Since the Nov 24, 2026 owner decision, approval pairings are a last resort and approvals come from the
  // instructor of the later course, so check the shared wording rather than one specific pairing.
  const approvals = plan.planConditions.filter(item => item.kind === "approval");
  assert.ok(approvals.length > 0);
  assert.ok(approvals.every(item => /^Taking .+ together in .+ needs approval from the .+ instructor before you register\.$/.test(item.message)));
  const prerequisites = plan.planConditions.filter(item => item.kind === "prerequisite");
  assert.ok(prerequisites.length > 0);
  assert.ok(prerequisites.every(item => /^Before taking .+, finish .+\.$/.test(item.message)));
  const report = await buildEconomicsReportFromStudent(student, planCreationDate, plan, result.economicsPlans);
  const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");
  const html = renderEconomicsHtml(report, template);
  for (const item of [plan.planConditions.find(item => item.kind === "approval"), ...prerequisites]) {
    assert.equal(html.split(item.message).length - 1, 1);
  }
});
