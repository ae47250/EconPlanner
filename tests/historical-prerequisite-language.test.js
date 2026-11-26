import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { historicalPrerequisiteCourseMessage, historicalPrerequisiteGaps, scheduledAfterCompletedMarker } from "../lib/planning/historical-prerequisites.js";
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

const say = (code, courses) => historicalPrerequisiteCourseMessage(code, courses, rules, policyBundle.messages);

test("one message per course names every unmet prerequisite, from policy", () => {
  assert.equal(say("ECO 461", [course("ECO 461")]),
    "ECO 461 is marked completed, but ECO 213, ECO 214 and a statistics course are not marked. Mark them, or your advisor will check.");
  assert.equal(say("ECO 214", [course("ECO 214"), course("MAT 113")]),
    "ECO 214 is marked completed, but ECO 114 is not marked. Mark it, or your advisor will check.");
  assert.equal(say("ECO 214", [course("ECO 214")]),
    "ECO 214 is marked completed, but ECO 114 and either MAT 113 or MAT 121 are not marked. Mark them, or your advisor will check.");
  assert.equal(gaps("ECO 213", [course("ECO 213"), course("ECO 113")])[0].label, "MAT 113 or MAT 121");
  assert.equal(say("ECO 214", [course("ECO 214"), course("ECO 114"), course("MAT 121")]), "");
  assert.equal(scheduledAfterCompletedMarker("ECO 114", [course("ECO 214"), course("MAT 113")], rules, policyBundle.messages), "ECO 114 comes before ECO 214, which you marked completed. Check with your advisor.");
});

test("a prerequisite's own prerequisites are not repeated in the list", () => {
  // ECO 461 needs ECO 213; ECO 213's own prerequisite (ECO 113) is not ECO 461's to list.
  const message = say("ECO 461", [course("ECO 461"), course("ECO 214"), course("MAT 217")]);
  assert.equal(message, "ECO 461 is marked completed, but ECO 213 is not marked. Mark it, or your advisor will check.");
  assert.doesNotMatch(message, /ECO 113|MAT 113|MAT 121/);
});

test("completed course with a Taking now prerequisite asks to fix one of them, without the retaking sentence", () => {
  const message = say("ECO 213", [course("ECO 213"), course("ECO 113", "in_progress"), course("MAT 121")]);
  assert.equal(message, "ECO 213 is marked completed, but ECO 113 is marked Taking now. Fix one of them, or your advisor will check.");
  assert.doesNotMatch(message, /retak/i);
});

test("Taking now course with a blank prerequisite says what it needs first", () => {
  assert.equal(say("ECO 213", [course("ECO 213", "in_progress"), course("MAT 121")]),
    "ECO 213 needs ECO 113 first. Mark it Completed, or your advisor will check.");
  assert.equal(say("ECO 461", [course("ECO 461", "in_progress"), course("ECO 213"), course("ECO 214")]),
    "ECO 461 needs a statistics course first. Mark it Completed, or your advisor will check.");
});

test("owner decision 2026-11-25: a course and its prerequisite both Taking now get a warning", () => {
  assert.equal(say("ECO 213", [course("ECO 213", "in_progress"), course("ECO 113", "in_progress"), course("MAT 121")]),
    "ECO 113 comes before ECO 213, but both are marked Taking now. Check both. If that’s right, your advisor will confirm.");
  assert.equal(say("ECO 221", [course("ECO 221", "in_progress"), course("ECO 113", "in_progress")]),
    "ECO 113 comes before ECO 221, but both are marked Taking now. Check both. If that’s right, your advisor will confirm.");
  assert.equal(say("ECO 331", [course("ECO 331", "in_progress"), course("ECO 213", "in_progress")]),
    "ECO 213 comes before ECO 331, but both are marked Taking now. Check both. If that’s right, your advisor will confirm.");
});

test("same-term pairs that policy allows with instructor approval keep their own message, not the warning", () => {
  for (const [dependent, prerequisite, earlier] of [["ECO 213", "MAT 113", "ECO 113"], ["ECO 214", "MAT 121", "ECO 114"]]) {
    assert.equal(say(dependent, [course(dependent, "in_progress"), course(prerequisite, "in_progress"), course(earlier)]), "");
  }
  assert.equal(say("ECO 461", [course("ECO 461", "in_progress"), course("ECO 213", "in_progress"), course("ECO 214"), course("MAT 217")]), "");
});

test("checklist markers name historical, AP, transfer, duplicate, enrollment, and unknown reasons", () => {
  const student = { courses: [course("ECO 214"), course("ECO 114", "in_progress"), course("ECO 113", "completed", "ap_credit"), course("MAT 113", "transfer")] };
  const marker = (reasonCode, code) => checklistMarkerForAdvisorAction({ reasonCode, affectedObject: { course: code } }, { student, policyBundle });
  assert.equal(marker("HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW", "ECO 214"), "ECO 114 is marked Taking now, but ECO 214 needs it done first. Ask your advisor to check.");
  assert.doesNotMatch(marker("HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW", "ECO 214"), /this class/);
  assert.equal(marker("COURSE_EVIDENCE_SCOPE_REVIEW", "ECO 113"), "AP credit. Confirm with your advisor that it counts.");
  assert.equal(marker("COURSE_EVIDENCE_SCOPE_REVIEW", "MAT 113"), "Transfer credit. Confirm with your advisor that it counts.");
  assert.equal(marker("COURSE_DUPLICATED", "ECO 214"), "Listed more than once. It counts once.");
  assert.equal(marker("ENROLLMENT_FULL", "ECO 214"), "Check this class’s enrollment status");
  const fallbackCodes = ["UNRECOGNIZED_REVIEW_REASON"].filter(code => marker(code, "ECO 214") === "Ask an advisor whether this class counts");
  assert.deepEqual(fallbackCodes, ["UNRECOGNIZED_REVIEW_REASON"]);
});

test("the validated plan keeps a missing major prerequisite and the PDF repeats its placement note", async () => {
  const student = { displayName: "Fictional student", academicStanding: "sophomore", entryCatalogYear: "2025-2026", planningPace: "one_year_early", planCreationDate: "2026-09-28", courses: [course("ECO 214")] };
  const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ student }) }));
  assert.equal(response.status, 200);
  const plan = (await response.json()).programs.find(item => item.economicsPlans).economicsPlans[0];
  const scheduled = plan.terms.flatMap(term => term.courses).find(item => item.course === "ECO 114");
  assert.ok(scheduled);
  const note = "ECO 114 comes before ECO 214, which you marked completed. Check with your advisor.";
  assert.ok(scheduled.planningMarkers.includes(note));
  assert.ok(plan.majorRequirementsChecklist.rows.find(row => row.id === "eco-214").markers.includes("ECO 114 isn’t marked completed, and ECO 214 needs it first. Ask your advisor to check."));
  assert.equal(plan.planConditions.find(item => item.reasonCode === "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW").shortMessage,
    "ECO 214 is marked completed, but ECO 114 and either MAT 113 or MAT 121 are not marked. Mark them, or your advisor will check.");
  const report = await buildEconomicsReportFromStudent(student, student.planCreationDate, plan);
  assert.match(renderEconomicsHtml(report, template), /ECO 114 comes before ECO 214, which you marked completed\. Check with your advisor\./);
});

test("freshman completed ECO 214 shows the same prerequisite-gap advice in the plan and PDF", async () => {
  const student = { displayName: "Fictional student", academicStanding: "freshman", planCreationDate: "2026-11-21", courses: [course("ECO 214"), course("ECO 114", "in_progress")] };
  const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ student }) }));
  assert.equal(response.status, 200);
  const plans = (await response.json()).programs.find(item => item.economicsPlans).economicsPlans;
  const plan = plans[0];
  const review = plan.planConditions.filter(item => item.reasonCode === "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW");
  const messages = [say("ECO 214", student.courses)];
  assert.deepEqual(review.map(item => item.message), messages);
  assert.deepEqual(plan.planConditions.filter(item => item.message.startsWith("ECO 214 is marked completed")).map(item => item.message), messages);
  assert.equal(review.filter(item => item.advisorPrompt).length, 1);
  for (const item of review) assert.doesNotMatch(item.message, /Your answers do not show|Ask your advisor to check your earlier course/);
  assert.match(review[0].advisorPrompt, /Check the student’s earlier course or transfer records/);
  const report = await buildEconomicsReportFromStudent(student, student.planCreationDate, plan, plans);
  const html = renderEconomicsHtml(report, template);
  for (const message of messages) assert.ok(html.includes(`<li data-plan-warning>${message}</li>`));
  // One message per course: both gaps share a single bullet.
  assert.equal(html.match(/<li data-plan-warning>ECO 214 is marked completed/g)?.length, 1);
  for (const message of messages) assert.ok(html.includes(`<li data-plan-warning>${message}</li>`));
  assert.ok(html.includes(review[0].advisorPrompt.replaceAll("'", "&#39;")));
  const catalog = report.catalog.advisorAttention.find(item => item.code === "FLEXIBLE_MAJOR_REQUIREMENTS_INCOMING_YEAR_UNKNOWN");
  assert.ok(catalog);
  assert.ok(!html.includes(catalog.message));
});

test("freshman ECO 213 taking now is retained, flagged, and shown in the plan and PDF", async () => {
  const student = { displayName: "Fictional student", academicStanding: "freshman", entryCatalogYear: "2025-2026",
    planCreationDate: "2026-11-21", courses: [course("ECO 113"), course("ECO 213", "in_progress")] };
  const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ student }) }));
  assert.equal(response.status, 200);
  const program = (await response.json()).programs.find(item => item.economicsPlans);
  assert.ok(program.economicsPlans.length > 0);
  const plan = program.economicsPlans[0];
  const expected = "ECO 213 needs MAT 113 or MAT 121 first. Mark it Completed or Taking now, or your advisor will check.";
  assert.ok(plan.planConditions.some(item => item.message === expected));
  assert.ok(plan.majorRequirementsChecklist.rows.some(row => row.course === "ECO 213" && row.markers.length));
  assert.ok(plan.terms.some(term => term.courses.some(item => item.course === "MAT 113" || item.course === "MAT 121")));
  const report = await buildEconomicsReportFromStudent(student, student.planCreationDate, plan, program.economicsPlans);
  assert.ok(renderEconomicsHtml(report, template).includes(`<li data-plan-warning>${expected}</li>`));
});

test("validated AP and transfer checklist rows show the evidence reason", async () => {
  const base = { displayName: "Fictional student", academicStanding: "sophomore", entryCatalogYear: "2025-2026", planningPace: "one_year_early", planCreationDate: "2026-09-28" };
  for (const [history, expected] of [
    [course("ECO 113", "completed", "ap_credit"), "Confirm with your advisor that it counts."],
    [course("ECO 113", "transfer", "transfer_equivalency_unapproved"), "Confirm with your advisor that it counts."]
  ]) {
    const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ student: { ...base, courses: [history] } }) }));
    assert.equal(response.status, 200);
    const plan = (await response.json()).programs.find(item => item.economicsPlans).economicsPlans[0];
    assert.deepEqual(plan.majorRequirementsChecklist.rows.find(row => row.id === "eco-113").markers, [expected]);
    const report = await buildEconomicsReportFromStudent({ ...base, courses: [history] }, base.planCreationDate, plan);
    assert.ok(renderEconomicsHtml(report, template).includes(expected));
  }
});

test("both Taking now: the warning is display only, so plans still generate and show it in the plan and PDF", async () => {
  const student = { displayName: "Fictional student", academicStanding: "sophomore", planCreationDate: "2026-11-21",
    courses: [course("ECO 113", "in_progress"), course("ECO 221", "in_progress")] };
  const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ student }) }));
  assert.equal(response.status, 200);
  const program = (await response.json()).programs.find(item => item.economicsPlans);
  assert.ok(program.economicsPlans.length > 0);
  const plan = program.economicsPlans[0];
  const expected = "ECO 113 comes before ECO 221, but both are marked Taking now. Check both. If that’s right, your advisor will confirm.";
  assert.ok(plan.planConditions.some(item => item.message === expected));
  const report = await buildEconomicsReportFromStudent(student, student.planCreationDate, plan, program.economicsPlans);
  assert.ok(renderEconomicsHtml(report, template).includes(`<li data-plan-warning>${expected}</li>`));
});

test("a Taking now note names only the course actually marked Taking now", () => {
  assert.equal(say("ECO 223", [course("ECO 223", "in_progress"), course("ECO 113", "in_progress")]),
    "ECO 113 comes before ECO 223, but both are marked Taking now. Check both. If that’s right, your advisor will confirm.");
  assert.equal(say("ECO 223", [course("ECO 223"), course("ECO 114", "in_progress")]),
    "ECO 223 is marked completed, but ECO 114 is marked Taking now. Fix one of them, or your advisor will check.");
  assert.match(say("ECO 461", [course("ECO 461"), course("ECO 213", "in_progress"), course("ECO 214", "in_progress"), course("MAT 217")]),
    /are marked Taking now\. Fix the course or its prerequisites, or your advisor will check\.$/);
});

test("the ECO 461 same-term approval only applies within its limits", () => {
  // Both ECO 213 and ECO 214 Taking now with ECO 461: over the one-course limit, so warn.
  assert.equal(say("ECO 461", [course("ECO 461", "in_progress"), course("ECO 213", "in_progress"), course("ECO 214", "in_progress"), course("MAT 217")]),
    "ECO 213 and ECO 214 come before ECO 461, but all are marked Taking now. Check them. If that’s right, your advisor will confirm.");
  // ECO 213 Taking now but ECO 214 not completed: outside the approval, so ECO 213 gets the warning too.
  assert.equal(say("ECO 461", [course("ECO 461", "in_progress"), course("ECO 213", "in_progress"), course("MAT 217")]),
    "ECO 461 needs ECO 214 first. Mark it Completed. ECO 213 comes before ECO 461, but both are marked Taking now, so check both. Your advisor will confirm.");
  // One Taking now and the other completed: within the approval, no warning.
  assert.equal(say("ECO 461", [course("ECO 461", "in_progress"), course("ECO 213", "in_progress"), course("ECO 214"), course("MAT 217")]), "");
});

test("owner decision 2026-11-26: suggest Taking now only where policy allows the same term", () => {
  // Ordinary prerequisite: Taking now would trigger the both-Taking-now warning, so suggest Completed only.
  assert.equal(say("ECO 221", [course("ECO 221", "in_progress")]),
    "ECO 221 needs ECO 113 first. Mark it Completed, or your advisor will check.");
  // Approved pair (math with ECO 213 after ECO 113): both choices stay.
  assert.equal(say("ECO 213", [course("ECO 213", "in_progress"), course("ECO 113")]),
    "ECO 213 needs MAT 113 or MAT 121 first. Mark it Completed or Taking now, or your advisor will check.");
  // Both kinds in one course.
  assert.equal(say("ECO 213", [course("ECO 213", "in_progress")]),
    "ECO 213 needs ECO 113 and either MAT 113 or MAT 121 first. Mark ECO 113 Completed and the math course Completed or Taking now, or your advisor will check.");
  // ECO 461: Taking now is allowed for ECO 213 only when ECO 214 is completed.
  assert.equal(say("ECO 461", [course("ECO 461", "in_progress"), course("ECO 214"), course("MAT 217")]),
    "ECO 461 needs ECO 213 first. Mark it Completed or Taking now, or your advisor will check.");
  assert.equal(say("ECO 461", [course("ECO 461", "in_progress"), course("MAT 217")]),
    "ECO 461 needs ECO 213 and ECO 214 first. Mark them Completed, or your advisor will check.");
});

test("owner decision 2026-11-26: both kinds of gap in one course read as one sentence", () => {
  assert.equal(say("ECO 461", [course("ECO 461"), course("ECO 257", "in_progress")]),
    "ECO 461 is marked completed, but ECO 213 and ECO 214 are not marked, and ECO 257 is marked Taking now. Fix these, or your advisor will check.");
  assert.equal(say("ECO 213", [course("ECO 213", "in_progress"), course("ECO 113", "in_progress")]),
    "ECO 213 needs MAT 113 or MAT 121 first. Mark it Completed or Taking now. ECO 113 comes before ECO 213, but both are marked Taking now, so check both. Your advisor will confirm.");
  // Singular verbs when one of each.
  assert.equal(say("ECO 214", [course("ECO 214"), course("ECO 114", "in_progress")]),
    "ECO 214 is marked completed, but MAT 113 or MAT 121 is not marked, and ECO 114 is marked Taking now. Fix these, or your advisor will check.");
  // Only one kind: unchanged.
  assert.equal(say("ECO 221", [course("ECO 221", "in_progress"), course("ECO 113", "in_progress")]),
    "ECO 113 comes before ECO 221, but both are marked Taking now. Check both. If that’s right, your advisor will confirm.");
});
