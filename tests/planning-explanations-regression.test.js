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

  const text = result.economicsPlanningGaps.map(item => item.reason || item.message).join(" ");
  const generic = "No complete assignment satisfies the term-level prerequisites, verified offerings, and recorded term-load capacity.";
  assert.equal(text.split(generic).length - 1, 1);
  assert.doesNotMatch(text, /Requirement (?:eco-elective-\d+|cognate|statistics|finance) remains unscheduled/);
  assert.match(text, /MAT 113 \/ MAT 121/);
  assert.match(text, /ECO 257 \/ MAT 217 \/ PSY 217/);
});

test("AP or exam credit produces a visible advisor-attention reason", async () => {
  const result = await economics({
    academicStanding: "freshman",
    courses: ["ECO 113", "ECO 114"].map(code => ({ code, status: "completed", source: "ap_credit" }))
  });
  assert.equal(result.economicsPlans[0].readinessStatus, "ADVISOR_ACTION_REQUIRED");
  const review = result.economicsPlans[0].planConditions.find(item => item.kind === "review" && item.shortMessage);
  assert.equal(review.shortMessage, "ECO 113 and ECO 114 are recorded as AP or exam credit. Confirm with your advisor that they count.");
});
