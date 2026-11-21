import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { historicalPrerequisiteGaps, historicalPrerequisiteMessage, historicalPrerequisiteSummary, scheduledAfterCompletedMarker } from "../lib/planning/historical-prerequisites.js";
import { checklistMarkerForAdvisorAction } from "../lib/planning/plan-presentation.js";
import { runtimePolicyBundle } from "../lib/policy/compat-normalized.js";
import { POST } from "../app/api/majors/map/route.js";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";

const policyBundle = runtimePolicyBundle();
const rules = policyBundle.rules;
const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");
const course = (code, status = "completed", source) => ({ code, status, ...(source ? { source } : {}) });
const gaps = (code, courses) => historicalPrerequisiteGaps(code, courses, rules);

test("completed advanced courses explain Taking now, missing, one-of, and multiple prerequisite gaps from policy", () => {
  const taking = gaps("ECO 214", [course("ECO 214"), course("ECO 114", "in_progress"), course("MAT 113")]);
  assert.equal(historicalPrerequisiteMessage(taking[0]), "You marked ECO 214 completed, but ECO 114, which comes before it, is marked Taking now. If that was a mistake, change one of them. If it is correct (for example, you are retaking ECO 114), keep both and your advisor will check it.");
  const missing = gaps("ECO 214", [course("ECO 214"), course("MAT 113")]);
  assert.equal(historicalPrerequisiteMessage(missing[0]), "You marked ECO 214 completed, but ECO 114, which comes before it, is not marked completed. If you finished ECO 114 or have transfer/AP credit for it, mark it. Otherwise your advisor will check it.");
  assert.equal(gaps("ECO 213", [course("ECO 213"), course("ECO 113")])[0].label, "MAT 113 or MAT 121");
  const multiple = gaps("ECO 461", [course("ECO 461"), course("ECO 213")]);
  assert.equal(multiple.length, 2);
  assert.match(historicalPrerequisiteSummary(multiple), /and 1 more$/);
  assert.deepEqual(gaps("ECO 214", [course("ECO 214"), course("ECO 114"), course("MAT 121")]), []);
  assert.equal(scheduledAfterCompletedMarker("ECO 114", [course("ECO 214"), course("MAT 113")], rules), "Scheduled after ECO 214, which you marked completed. Check with your advisor.");
});

test("checklist markers name historical, AP, transfer, duplicate, enrollment, and unknown reasons", () => {
  const student = { courses: [course("ECO 214"), course("ECO 114", "in_progress"), course("ECO 113", "completed", "ap_credit"), course("MAT 113", "transfer")] };
  const marker = (reasonCode, code) => checklistMarkerForAdvisorAction({ reasonCode, affectedObject: { course: code } }, { student, policyBundle });
  assert.equal(marker("HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW", "ECO 214"), "ECO 114 marked Taking now rather than done before this class. Ask your advisor to check.");
  assert.equal(marker("COURSE_EVIDENCE_SCOPE_REVIEW", "ECO 113"), "AP/exam credit. Confirm with your advisor that it counts.");
  assert.equal(marker("COURSE_EVIDENCE_SCOPE_REVIEW", "MAT 113"), "Transfer credit. Confirm with your advisor that it counts.");
  assert.equal(marker("COURSE_DUPLICATED", "ECO 214"), "Listed more than once. It counts once.");
  assert.equal(marker("ENROLLMENT_FULL", "ECO 214"), "Check this class’s enrollment status");
  const fallbackCodes = ["UNRECOGNIZED_REVIEW_REASON"].filter(code => marker(code, "ECO 214") === "Ask an advisor whether this class counts");
  assert.deepEqual(fallbackCodes, ["UNRECOGNIZED_REVIEW_REASON"]);
});

test("the validated plan keeps a missing major prerequisite and the PDF repeats its placement note", async () => {
  const student = { displayName: "Fictional student", academicStanding: "sophomore", entryCatalogYear: "2025-2026", planningPace: "one_year_early", planCreationDate: "2026-09-28", courses: [course("ECO 214"), course("MAT 113")] };
  const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ student }) }));
  assert.equal(response.status, 200);
  const plan = (await response.json()).programs.find(item => item.economicsPlans).economicsPlans[0];
  const scheduled = plan.terms.flatMap(term => term.courses).find(item => item.course === "ECO 114");
  assert.ok(scheduled);
  const note = "Scheduled after ECO 214, which you marked completed. Check with your advisor.";
  assert.ok(scheduled.planningMarkers.includes(note));
  assert.ok(plan.majorRequirementsChecklist.rows.find(row => row.id === "eco-214").markers.includes("ECO 114 not marked done before this class. Ask your advisor to check."));
  assert.match(plan.planConditions.find(item => item.reasonCode === "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW").shortMessage, /^You marked ECO 214 completed, but ECO 114/);
  const report = await buildEconomicsReportFromStudent(student, student.planCreationDate, plan);
  assert.match(renderEconomicsHtml(report, template), /Scheduled after ECO 214, which you marked completed\. Check with your advisor\./);
});

test("validated AP and transfer checklist rows show the evidence reason", async () => {
  const base = { displayName: "Fictional student", academicStanding: "sophomore", entryCatalogYear: "2025-2026", planningPace: "one_year_early", planCreationDate: "2026-09-28" };
  for (const [history, expected] of [
    [course("ECO 113", "completed", "ap_credit"), "AP/exam credit. Confirm with your advisor that it counts."],
    [course("ECO 113", "transfer", "transfer_equivalency_unapproved"), "Transfer credit. Confirm with your advisor that it counts."]
  ]) {
    const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ student: { ...base, courses: [history] } }) }));
    assert.equal(response.status, 200);
    const plan = (await response.json()).programs.find(item => item.economicsPlans).economicsPlans[0];
    assert.deepEqual(plan.majorRequirementsChecklist.rows.find(row => row.id === "eco-113").markers, [expected]);
    const report = await buildEconomicsReportFromStudent({ ...base, courses: [history] }, base.planCreationDate, plan);
    assert.ok(renderEconomicsHtml(report, template).includes(expected));
  }
});
