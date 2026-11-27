// Owner decision 2026-11-26 (policy/provenance/owner-screen-pdf-consistency-2026-11-26.md):
// the screen and the PDF say the same thing about the same plan.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { POST } from "../app/api/majors/map/route.js";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";
import { noPlanStatusLabel } from "../lib/planning/no-plan-presentation.js";

const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");
const course = (code, status = "completed") => ({ code, status });
async function plansFor(student) {
  const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ student }) }));
  assert.equal(response.status, 200);
  return (await response.json()).programs.find(item => item.program?.id === "economics-base");
}
const visibleText = html => html.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");

test("the PDF prints May, never Spring/May, while its data attributes keep the stored term", async () => {
  const student = { displayName: "Fictional student", academicStanding: "freshman", planCreationDate: "2026-11-21", courses: [course("ECO 113")] };
  const economics = await plansFor(student);
  const plan = economics.economicsPlans[0];
  const html = renderEconomicsHtml(await buildEconomicsReportFromStudent(student, student.planCreationDate, plan, economics.economicsPlans), template);
  assert.doesNotMatch(visibleText(html), /Spring\/May/);
  assert.match(visibleText(html), /May 20\d\d/);
  assert.match(html, /="Spring\/May 20\d\d"/);
});

test("a standard plan names the one-year-early target in the PDF header only when an early plan exists", async () => {
  const early = { displayName: "Fictional student", academicStanding: "freshman", planningPace: "one_year_early", planCreationDate: "2026-11-21", courses: [] };
  const withEarly = await plansFor(early);
  assert.ok(withEarly.economicsPlans.some(plan => plan.id === "one-year-early"), "this freshman has an early plan");
  const standard = withEarly.economicsPlans.find(plan => !plan.planningContext?.earlyGraduation);
  const html = renderEconomicsHtml(await buildEconomicsReportFromStudent(early, early.planCreationDate, standard, withEarly.economicsPlans), template);
  assert.match(html, /<strong>Graduation target:<\/strong> <span[^>]*>May 2030 \(one year early: May 2029\)<\/span>/);

  // A junior who asked to graduate early but cannot: the header names only the standard target, as on screen.
  const late = { displayName: "Fictional student", academicStanding: "junior", planningPace: "one_year_early", planCreationDate: "2026-11-21", courses: [course("ECO 113")] };
  const noEarly = await plansFor(late);
  assert.ok(!noEarly.economicsPlans.some(plan => plan.id === "one-year-early"), "this junior has no early plan");
  const lateHtml = renderEconomicsHtml(await buildEconomicsReportFromStudent(late, late.planCreationDate, noEarly.economicsPlans[0], noEarly.economicsPlans), template);
  assert.match(lateHtml, /<strong>Graduation target:<\/strong> <span[^>]*>May 2028<\/span>/);
});

test("an approved same-term math pairing gives one approval sentence and asks the advisor about approval", async () => {
  const student = { displayName: "Fictional student", academicStanding: "sophomore", planCreationDate: "2026-11-21",
    courses: [course("ECO 113"), course("ECO 114"), course("MAT 121", "in_progress"), course("ECO 213", "in_progress")] };
  const economics = await plansFor(student);
  const plan = economics.economicsPlans[0];
  const review = plan.planConditions.filter(item => item.course === "ECO 213" && item.kind === "review");
  const sentence = "MAT 121 comes before ECO 213. Taking both in the same term needs the ECO 213 instructor’s approval.";
  assert.deepEqual(review.map(item => item.message), [sentence]);
  assert.equal(review[0].advisorPrompt, "Confirm the ECO 213 instructor approves taking ECO 213 and MAT 121 in the same term.");
  assert.ok(plan.majorRequirementsChecklist.rows.find(row => row.course === "ECO 213").markers.includes("Approval needed"));
});

test("room saved for other courses is the student's own change, on the screen and in the PDF", async () => {
  assert.equal(noPlanStatusLabel({ category: "NEEDS_ADVISOR_ATTENTION", reason: "RESERVED_ROOM_BLOCKS_PLAN" }), "Change your answers");
  const student = { displayName: "Fictional student", academicStanding: "senior", planCreationDate: "2026-11-22",
    courses: ["BUSN 323", "ECO 113", "ECO 114", "ECO 213", "ECO 234", "ECO 333", "MAT 121", "MAT 217"].map(code => course(code)),
    reservedCourseUnits: { "Winter 2027": 2 } };
  const economics = await plansFor(student);
  assert.equal(economics.economicsPlans.length, 0);
  assert.equal(economics.economicsPlanResult.reason, "RESERVED_ROOM_BLOCKS_PLAN");
  const html = renderEconomicsHtml(await buildEconomicsReportFromStudent(student, student.planCreationDate), template);
  assert.match(html, /<h2>Change your answers<\/h2>/);
});

// Final sweep, 2026-11-26: the screen and the PDF read the same rule for each of these.
test("a plan that needs a catalog petition is 'Needs confirmation' on screen and in the PDF, not 'Ready to plan'", async () => {
  const { planReadinessLabel } = await import("../lib/planning/plan-display.js");
  const student = { displayName: "Fictional student", academicStanding: "junior", planCreationDate: "2026-11-21", courses: [course("ECO 114"), course("MAT 121")] };
  const economics = await plansFor(student);
  const plan = economics.economicsPlans[0];
  assert.equal(plan.readinessStatus, "STUDENT_READY");
  const html = renderEconomicsHtml(await buildEconomicsReportFromStudent(student, student.planCreationDate, plan, economics.economicsPlans), template);
  assert.match(html, /routine petition/);
  assert.equal(planReadinessLabel(plan), "Needs confirmation");
  assert.match(visibleText(html), /Status: Needs confirmation/);
  assert.doesNotMatch(visibleText(html), /Ready to plan/);
});

test("the PDF class standing says 'graduating one year early' only when an early plan exists", async () => {
  const student = { displayName: "Fictional student", academicStanding: "junior", planningPace: "one_year_early", planCreationDate: "2026-11-21", courses: [course("ECO 113")] };
  const economics = await plansFor(student);
  assert.ok(!economics.economicsPlans.some(plan => plan.id === "one-year-early"));
  const html = renderEconomicsHtml(await buildEconomicsReportFromStudent(student, student.planCreationDate, economics.economicsPlans[0], economics.economicsPlans), template);
  assert.match(html, /Class standing: Junior(?! \(graduating)/);
  const early = { ...student, academicStanding: "freshman", courses: [] };
  const earlyPlans = await plansFor(early);
  const earlyHtml = renderEconomicsHtml(await buildEconomicsReportFromStudent(early, early.planCreationDate, earlyPlans.economicsPlans[0], earlyPlans.economicsPlans), template);
  assert.match(earlyHtml, /Class standing: Freshman \(graduating one year early\)/);

  // Early graduation "more information needed" and no early plan offered: plain "Junior" (screen uses the same rule).
  const { oneYearEarlyPlanOffered } = await import("../lib/planning/plan-display.js");
  const unsure = { displayName: "Fictional student", academicStanding: "junior", planningPace: "one_year_early", planCreationDate: "2027-07-30",
    courses: ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "BUSN 323"].map(code => course(code)) };
  const unsurePlans = await plansFor(unsure);
  assert.equal(unsurePlans.economicsAcceleratedResult.status, "MORE_INFORMATION_NEEDED");
  assert.equal(oneYearEarlyPlanOffered(unsurePlans.economicsPlans), false);
  const unsureHtml = renderEconomicsHtml(await buildEconomicsReportFromStudent(unsure, unsure.planCreationDate, unsurePlans.economicsPlans[0], unsurePlans.economicsPlans), template);
  assert.match(unsureHtml, /Class standing: Junior(?! \(graduating)/);
});

test("ECO 213 taken now with MAT 121 is tagged 'Approval needed' in the PDF grid and the checklist alike", async () => {
  const student = { displayName: "Fictional student", academicStanding: "sophomore", planCreationDate: "2026-11-21",
    courses: [course("ECO 113"), course("ECO 114"), course("MAT 121", "in_progress"), course("ECO 213", "in_progress")] };
  const economics = await plansFor(student);
  const plan = economics.economicsPlans[0];
  const html = renderEconomicsHtml(await buildEconomicsReportFromStudent(student, student.planCreationDate, plan, economics.economicsPlans), template);
  const entry = html.match(/<div class="course-entry"><span class="course" data-course-code="ECO 213"[\s\S]*?<\/div>/)?.[0] || "";
  assert.ok(entry.includes(">Approval needed<"), "PDF grid tags ECO 213");
  assert.ok(plan.majorRequirementsChecklist.rows.find(row => row.course === "ECO 213").markers.includes("Approval needed"), "checklist tags ECO 213");
  const mat = html.match(/<div class="course-entry"><span class="course" data-course-code="MAT 121"[\s\S]*?<\/div>/)?.[0] || "";
  assert.ok(!mat.includes(">Approval needed<"), "the approval is the ECO 213 instructor's, so MAT 121 is not tagged");
});

test("the PDF grid tags a course 'Approval needed' exactly when the shared rule says so", async () => {
  const { courseNeedsApproval } = await import("../lib/planning/student-language.js");
  const student = { displayName: "Fictional student", academicStanding: "junior", planningPace: "one_year_early", planCreationDate: "2026-11-21", courses: [course("ECO 113"), course("MAT 217")] };
  const economics = await plansFor(student);
  let tagged = 0;
  for (const plan of economics.economicsPlans) {
    const html = renderEconomicsHtml(await buildEconomicsReportFromStudent(student, student.planCreationDate, plan, economics.economicsPlans), template);
    const grid = html.slice(html.indexOf('<table class="schedule'), html.indexOf("</table>", html.indexOf('<table class="schedule')));
    for (const term of plan.terms) for (const item of term.courses) {
      const entry = grid.match(new RegExp(`<div class="course-entry"><span class="course" data-course-code="${item.course}"[\\s\\S]*?</div>`))?.[0] || "";
      if (item.course === "ECO elective") continue;
      assert.ok(entry, `${plan.id} ${item.course} is in the PDF grid`);
      assert.equal(entry.includes(">Approval needed<"), courseNeedsApproval(item), `${plan.id} ${item.course}`);
      if (courseNeedsApproval(item)) tagged++;
    }
  }
  assert.ok(tagged > 0, "this student has at least one approval tag to compare");
});

test("ECO 321's finance sentence says it never counts as an elective", async () => {
  const { displayMessage } = await import("../lib/planning/student-language.js");
  const messages = JSON.parse(await readFile(new URL("../policy/messages/en-US.json", import.meta.url), "utf8")).messages;
  assert.equal(displayMessage(messages, "infeasibility.finance.forced", { financeCourse: "ECO 321" }), "ECO 321 counts only for Finance, never as an Economics elective.");
});

test("the taken-now pairing keeps its 'Approval needed' tag in the checklist even when another prerequisite is missing", async () => {
  const student = { displayName: "Fictional student", academicStanding: "sophomore", planCreationDate: "2026-11-21",
    courses: [course("ECO 113"), course("MAT 113", "in_progress"), course("ECO 214", "in_progress")] };
  const economics = await plansFor(student);
  const plan = economics.economicsPlans[0];
  const html = renderEconomicsHtml(await buildEconomicsReportFromStudent(student, student.planCreationDate, plan, economics.economicsPlans), template);
  const entry = html.match(/<div class="course-entry"><span class="course" data-course-code="ECO 214"[\s\S]*?<\/div>/)?.[0] || "";
  assert.ok(entry.includes(">Approval needed<"), "PDF grid tags ECO 214");
  const row = plan.majorRequirementsChecklist.rows.find(item => item.course === "ECO 214");
  assert.ok(row.markers.includes("Approval needed"), "checklist tags ECO 214 too");
  assert.ok(row.markers.some(marker => /ECO 114/.test(marker)), "and still names the missing ECO 114");
});

// Owner request 2026-11-27: the sentence under a plan's status comes from the status (one rule, screen and PDF).
test("the sentence under each status says what that status needs", async () => {
  const { planStatusExplanation } = await import("../lib/planning/plan-display.js");
  const messages = JSON.parse(await readFile(new URL("../policy/messages/en-US.json", import.meta.url), "utf8")).messages;
  const plan = (readinessStatus, extra = {}) => ({ readinessStatus, feasibilityStatus: "CONDITIONALLY_FEASIBLE", planConditions: [], ...extra });
  assert.equal(planStatusExplanation(plan("STUDENT_READY"), messages), "The plan meets the major rules. Check seats and future schedules before you register.");
  assert.equal(planStatusExplanation(plan("READY_WITH_CONDITIONS", { planConditions: [{ kind: "approval" }] }), messages),
    "Before you register, confirm the approval in the notes below.");
  assert.equal(planStatusExplanation(plan("READY_WITH_CONDITIONS", { planConditions: [{ kind: "approval" }, { kind: "standing" }] }), messages),
    "Before you register, confirm the approval and your senior standing in the notes below.");
  assert.equal(planStatusExplanation(plan("READY_WITH_CONDITIONS"), messages), "Before you register, check the notes below.");
  assert.equal(planStatusExplanation(plan("READY_WITH_CONDITIONS", { feasibilityStatus: "PRELIMINARY_ONLY" }), messages),
    "Before you register, confirm the preliminary schedule in the notes below.");
  // A ready plan never pairs "meets the major rules" with an unfinished-schedule sentence.
  assert.equal(planStatusExplanation(plan("STUDENT_READY", { feasibilityStatus: "NOT_FEASIBLE" }), messages),
    "The plan meets the major rules. Check seats and future schedules before you register.");
  // Ready status given only through planDisposition is still read as ready.
  assert.match(planStatusExplanation({ planDisposition: "COMPLETE_STUDENT_READY", feasibilityStatus: "CONDITIONALLY_FEASIBLE" }, messages), /^The plan meets the major rules\./);
  assert.equal(planStatusExplanation(plan("ADVISOR_ACTION_REQUIRED", { planConditions: [{ kind: "review", shortMessage: "X." }] }), messages),
    "Ask your advisor to review the notes below before relying on this plan.");
});

test("the PDF shows the status sentence once, with the petition reminder inside it", async () => {
  const student = { displayName: "Fictional student", academicStanding: "junior", planCreationDate: "2026-11-21", courses: [course("ECO 114"), course("MAT 121")] };
  const economics = await plansFor(student);
  const html = renderEconomicsHtml(await buildEconomicsReportFromStudent(student, student.planCreationDate, economics.economicsPlans[0], economics.economicsPlans), template);
  assert.match(visibleText(html), /Status: Needs confirmation\s+Your catalog needs a petition for this plan\. See the notes below for paperwork to file\./);
  assert.equal(visibleText(html).match(/paperwork to file/g).length, 1);
  assert.doesNotMatch(visibleText(html), /Check seats and future schedules/);

  const senior = { displayName: "Fictional student", academicStanding: "senior", planCreationDate: "2026-11-22",
    courses: ["ECO 113", "ECO 114", "ECO 213", "MAT 121", "MAT 217", "ECO 333", "ECO 234", "BUSN 323"].map(code => course(code)) };
  const seniorPlans = await plansFor(senior);
  const seniorHtml = renderEconomicsHtml(await buildEconomicsReportFromStudent(senior, senior.planCreationDate, seniorPlans.economicsPlans[0], seniorPlans.economicsPlans), template);
  // This senior also needs a petition (BUSN 323 on an older catalog), so the reminder joins the same sentence.
  assert.match(visibleText(seniorHtml), /Status: Needs confirmation\s+Before you register, confirm the approval in the notes below\. The notes also list paperwork to file\./);
});
