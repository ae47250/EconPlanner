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
