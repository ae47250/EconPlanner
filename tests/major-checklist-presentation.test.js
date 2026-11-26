import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { POST } from "../app/api/majors/map/route.js";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";
import { buildEconomicsReport } from "../lib/reports/economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";
import { buildMajorRequirementsChecklist, buildPlanConditions } from "../lib/planning/plan-presentation.js";
import { availabilityIsStale, seatStatusPresentation } from "../lib/planning/seat-status.js";

const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");
const sample = { displayName: "Fictional checklist student", academicStanding: "sophomore", entryCatalogYear: "2025-2026",
  planningPace: "one_year_early", planCreationDate: "2026-09-28", courses: [] };
const order = ["ECO 113", "ECO 114", "Mathematics", "ECO 213", "ECO 214", "Statistics", "Finance", "ECO 461 / Senior Seminar",
  "Economics elective 1", "Economics elective 2", "Economics elective 3", "Economics elective 4"];
async function post(body) {
  const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: response.status, data: await response.json() };
}
const economics = data => data.programs.find(item => item.economicsPlans);
const completed = codes => codes.map(code => ({ code, status: "completed" }));

test("completed math choice is stable across course entry order and report generation", async () => {
  const courses = completed(["ECO 113", "ECO 114", "MAT 113", "MAT 121", "MAT 217", "ECO 257"]);
  const student = { ...sample, planningPace: "standard", planCreationDate: "2026-11-22", courses };
  for (const enteredCourses of [courses, [...courses].reverse()]) {
    const input = { ...student, courses: enteredCourses };
    const plan = economics((await post({ student: input })).data).economicsPlans[0];
    const screenMath = plan.majorRequirementsChecklist.rows.find(row => row.id === "cognate").course;
    const report = await buildEconomicsReportFromStudent(input, input.planCreationDate, plan);
    const pdfMath = report.majorRequirementsChecklist.rows.find(row => row.id === "cognate").course;
    assert.equal(screenMath, "MAT 113");
    assert.equal(pdfMath, screenMath);
  }
});

test("zero-course input: all three checklists use validated future assignments, full terms, order and identical report content", async () => {
  const result = economics((await post({ student: sample })).data);
  assert.equal(result.economicsPlans.length, 3);
  for (const plan of result.economicsPlans) {
    const checklist = plan.majorRequirementsChecklist;
    assert.equal(checklist.complete, true);
    assert.deepEqual(checklist.legend.map(state => state.label), ["Planned"]);
    assert.deepEqual(checklist.unmetRequirements, []);
    assert.equal(checklist.title, "Major requirements checklist");
    assert.deepEqual(checklist.rows.map(row => row.label), order);
    assert.ok(checklist.rows.every(row => row.status === "planned" && row.symbol === "○" && /202[7-9]/.test(row.term)));
    assert.ok(checklist.rows.filter(row => row.course.startsWith("ECO elective")).every(row => row.course === "ECO elective (200+)"));
    const report = await buildEconomicsReportFromStudent(sample, sample.planCreationDate, plan);
    assert.deepEqual(report.majorRequirementsChecklist, checklist);
    assert.deepEqual(report.planConditions, plan.planConditions);
    const html = renderEconomicsHtml(report, template);
    assert.ok(html.includes(checklist.note));
    assert.ok(html.includes("Math choices:") && html.includes("MAT 113") && html.includes("MAT 121"));
    assert.ok(html.includes("Statistics choices:") && html.includes("ECO 257") && html.includes("PSY 217"));
    assert.ok(html.includes("Finance choices:") && html.includes("BUSN 323"));
    assert.ok(!/Requirement assignments|<th>Strict|<th>Optimistic|<td>Advisor check<\/td>|CONDITIONALLY FEASIBLE|planning_projection|stale availability/.test(html));
    assert.equal((html.match(/data-requirement-checklist-id=/g) || []).length, 12);
    for (const item of report.planConditions) assert.equal(html.split(item.message).length - 1, 1);
    assert.ok(html.indexOf("Your plan by term") < html.indexOf("Your Economics major checklist"));
    assert.ok(!/availability-open">|availability-full">/.test(html));
    assert.ok(html.includes("We don’t know if there are open seats in "));
    const capstone = checklist.rows.find(row => row.id === "eco-461");
    if (plan.id === "one-year-early") {
      assert.deepEqual(capstone.markers, ["Approval needed", "Ask your advisor and the Registrar to confirm senior standing."]);
      assert.ok(checklist.rows.find(row => row.id === "eco-213").markers.includes("Approval needed"));
      assert.ok(plan.planConditions.some(item => item.message === "Taking ECO 213 and ECO 461 together in Winter 2028 needs approval from the ECO 461 instructor before you register."));
      assert.ok(plan.planConditions.some(item => /This plan assumes you will have senior standing in 2027–2028\./.test(item.message)));
      assert.ok(!html.includes("This plan assumes you will have senior standing in your final year."));
    } else assert.deepEqual(capstone.markers, []);
  }
});

test("incomplete candidates retain unmet eligibility separately without asserting impossibility", () => {
  const checklist = buildMajorRequirementsChecklist({ plan: {}, mapping: { requirements: [
    { id: "finance", label: "Finance", options: ["ECO 321", "BUSN 323"] }
  ] } });
  assert.equal(checklist.complete, false);
  assert.equal(checklist.unmetRequirements[0].id, "finance");
  assert.deepEqual(checklist.legend.map(state => state.label), []);
  const html = renderEconomicsHtml({ student: { displayName: "Fictional <student>", academicStanding: "senior" }, terms: [], unresolved: [], requirements: [], majorRequirementsChecklist: checklist, planConditions: [], planNotes: [] }, template);
  assert.ok(html.includes("Requirements still needing a class"));
  assert.match(html, /<h3>Requirements still needing a class<\/h3><ul><li>Finance<\/li><\/ul>/);
  assert.doesNotMatch(html, /search is not finished/);
  assert.ok(html.includes("Still needed"));
  assert.ok(html.includes("Fictional &lt;student&gt;"));
  assert.ok(html.includes("is-still_needed") && html.includes("Still needed"));
});

test("senior elective history uses each completed and current course once in API checklist and PDF", async () => {
  const student = { ...sample, academicStanding: "senior", planCreationDate: "2026-11-21", courses: [
    ...completed(["ECO 113", "ECO 114", "ECO 213", "MAT 217", "MAT 121", "BUSN 323", "ECO 315", "ECO 337"]),
    { code: "ECO 333", status: "in_progress" }
  ] };
  const result = economics((await post({ student })).data);
  const plan = result.economicsPlans[0];
  const rows = plan.majorRequirementsChecklist.rows;
  assert.equal(rows.find(row => row.id === "eco-elective-2").course, "ECO 333");
  const current = rows.find(row => row.id === "eco-elective-2");
  assert.equal(current.course, "ECO 333");
  assert.equal(current.status, "in_progress");
  assert.equal(rows.filter(row => row.course === "ECO 337").length, 1);
  const report = await buildEconomicsReportFromStudent(student, student.planCreationDate, plan);
  const html = renderEconomicsHtml(report, template);
  assert.match(html, /data-requirement-checklist-id="eco-elective-2"[\s\S]*?ECO 333[\s\S]*?Taking now/);
});

test("AP and transfer checklist credit and grouped advisor text agree in API and PDF", async () => {
  for (const [courses, label, message] of [
    [[{ code: "ECO 113", status: "completed", source: "ap_credit" }, { code: "ECO 114", status: "completed", source: "ap_credit" }],
      "AP credit", "Confirm with your advisor that your AP credit for ECO 113 and ECO 114 counts."],
    [[{ code: "ECO 113", status: "transfer", source: "transfer_equivalency_unapproved" }, { code: "MAT 121", status: "transfer", source: "transfer_equivalency_unapproved" }],
      "Transfer credit", "Confirm with your advisor that your transfer credit for ECO 113 and MAT 121 counts."]
  ]) {
    const student = { ...sample, academicStanding: "freshman", planCreationDate: "2026-11-21", courses };
    const plan = economics((await post({ student })).data).economicsPlans[0];
    for (const course of courses) {
      const row = plan.majorRequirementsChecklist.rows.find(item => item.course === course.code);
      assert.equal(row.statusLabel, label);
      // The row's status label names the credit; the note does not repeat it.
      assert.ok(row.markers.includes("Confirm with your advisor that it counts."));
      assert.ok(!row.markers.some(marker => marker.startsWith(label)));
    }
    assert.equal(plan.planConditions.filter(item => item.message === message).length, 1);
    const report = await buildEconomicsReportFromStudent(student, student.planCreationDate, plan);
    const html = renderEconomicsHtml(report, template);
    assert.equal(html.split(`<li data-plan-warning>${message}</li>`).length - 1, 1);
    assert.match(html, new RegExp(label));
  }
});

test("shared prerequisite note orders target terms chronologically", () => {
  const conditions = buildPlanConditions({ plan: { prerequisiteNotices: [
    { dependentCourse: "ECO 214", dependentTerm: "Fall 2028", prerequisite: "MAT 113" },
    { dependentCourse: "ECO 213", dependentTerm: "Winter 2028", prerequisite: "MAT 113" }
  ] } });
  assert.ok(conditions.some(item => item.message === "Before taking ECO 213 in Winter 2028 and ECO 214 in Fall 2028, finish MAT 113."));
});

test("escaped student placeholder-like text cannot replace report markup", () => {
  const html = renderEconomicsHtml({ student: { displayName: "{{YEAR_BLOCKS_HTML}} <script>fictional</script>", academicStanding: "senior" }, terms: [], unresolved: [], planConditions: [], planNotes: [] }, template);
  assert.ok(html.includes("{{YEAR_BLOCKS_HTML}} &lt;script&gt;fictional&lt;/script&gt;"));
  assert.equal((html.match(/data-term-grid/g) || []).length, 1);
});

test("an incomplete late-entry report never presents published offerings as student assignments", async () => {
  const student = { ...sample, academicStanding: "senior", customGraduationEnabled: true,
    customExpectedGraduationYear: "2028", planCreationDate: "2027-08-24",
    courses: completed(["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "BUSN 323"]) };
  const report = await buildEconomicsReportFromStudent(student, student.planCreationDate);
  assert.equal(report.selectedPlan, null);
  assert.ok(report.terms.length);
  assert.ok(report.terms.every(term => term.courses.length === 0));
  assert.equal(report.planningHorizon, "Fall 2027 through Spring/May 2028");
  assert.ok(report.verifiedOfferings.Winter.length > 0);
  assert.equal(report.majorRequirementsChecklist.unmetRequirements.length, 5);
  assert.ok(report.planNotes.some(note => note.id === "future"));
  const html = renderEconomicsHtml(report, template);
  assert.match(html, /Incomplete candidate/);
  assert.doesNotMatch(html, /class="course"/);
});

test("qualified completed credit and current enrollment are separate from future plans across alternatives", async () => {
  for (const statistics of ["MAT 217", "PSY 217", "ECO 257"]) {
    const student = { ...sample, courses: [
      ...completed(["ECO 113", "MAT 113", "BUSN 323", "ECO 161"]),
      { code: "ECO 114", status: "in_progress" }, { code: statistics, status: "completed" }
    ] };
    const result = economics((await post({ student })).data);
    assert.ok(result.economicsPlans.length);
    for (const plan of result.economicsPlans) {
      const rows = plan.majorRequirementsChecklist.rows;
      assert.equal(rows.find(row => row.id === "eco-113").status, "completed");
      assert.equal(rows.find(row => row.id === "eco-113").symbol, "✓");
      assert.equal(rows.find(row => row.id === "eco-114").status, "in_progress");
      assert.equal(rows.find(row => row.id === "eco-114").symbol, "◐");
      assert.equal(rows.find(row => row.id === "statistics").course, statistics);
      assert.equal(rows.find(row => row.id === "statistics").status, "completed");
      assert.equal(rows.find(row => row.id === "finance").status, "completed");
      assert.equal(rows.filter(row => row.id.startsWith("eco-elective") && row.status === "completed").length, 1);
      assert.ok(rows.filter(row => row.id.startsWith("eco-elective") && row.status === "planned").every(row => row.course === "ECO elective (200+)" || /ECO [2-9]\d\d/.test(row.course)));
      const report = await buildEconomicsReportFromStudent(student, student.planCreationDate, plan, result.economicsPlans);
      const html = renderEconomicsHtml(report, template);
      assert.ok(html.includes("Taking now"));
      // Hosted Open Sans lacks these glyphs. Every row and legend must draw its
      // symbol independently of fonts and keep its accessible text label.
      for (const row of rows) {
        const label = row.status === "in_progress" ? "Taking now" : row.statusLabel;
        assert.ok(html.includes(`status-icon-${row.status}\" aria-hidden=\"true\"></span> ${label}`));
      }
      assert.equal((html.match(/class="status-icon status-icon-/g) || []).length, 15);
      assert.doesNotMatch(html, /aria-hidden="true">[✓◐○]</);
      assert.match(html, /status-icon-completed\{[^}]+border:/);
      assert.match(html, /status-icon-in_progress:before\{[^}]+background:currentColor/);
    }
  }
});

test("completed ECO 461 keeps qualifying credit without a future senior-standing condition", async () => {
  // Owner decision Nov 25, 2026: only a senior can record ECO 461 as completed.
  const student = { ...sample, academicStanding: "senior", planningPace: "standard",
    courses: completed(["ECO 113", "ECO 114", "MAT 113", "MAT 217", "BUSN 323", "ECO 213", "ECO 214", "ECO 461", "ECO 333", "ECO 221", "ECO 222"]) };
  const result = economics((await post({ student })).data);
  assert.ok(result.economicsPlans.length);
  for (const plan of result.economicsPlans) {
    const row = plan.majorRequirementsChecklist.rows.find(item => item.id === "eco-461");
    assert.equal(row.status, "completed");
    assert.ok(!row.markers.includes("Ask an advisor to confirm senior standing"));
    assert.ok(!plan.planConditions.some(item => item.kind === "standing"));
    const report = await buildEconomicsReportFromStudent(student, student.planCreationDate, plan, result.economicsPlans);
    assert.ok(!renderEconomicsHtml(report, template).includes("This plan assumes you will have senior standing in your final year."));
  }
});

test("provisional transfer credit, missing work and an invalid double allocation never acquire a completed checkmark", () => {
  const requirement = { id: "eco-113", label: "ECO 113", options: ["ECO 113"] };
  const provisional = { slotId: "eco-113", code: "ECO 113", status: "transfer", evidenceStatus: "PROVISIONAL" };
  const mapping = { requirements: [requirement], assignments: [provisional], strict: { assignments: [] } };
  let row = buildMajorRequirementsChecklist({ mapping }).rows[0];
  assert.equal(row.status, "still_needed");
  assert.deepEqual(row.markers, ["Ask your advisor whether this course counts toward the major."]);
  row = buildMajorRequirementsChecklist({ mapping: { requirements: [requirement], assignments: [] } }).rows[0];
  assert.equal(row.status, "still_needed");
  assert.equal(row.courseTerm, "No class matched yet");
  const duplicate = { validation: { valid: false, requirementAllocation: { assignments: [
    { slotId: "eco-113", code: "ECO 113", source: "planned" }, { slotId: "eco-elective-1", code: "ECO 113", source: "planned" }
  ] } }, terms: [{ term: "Winter 2028", courses: [{ course: "ECO 113", requirementId: "eco-113" }, { course: "ECO 113", requirementId: "eco-elective-1" }] }] };
  const rows = buildMajorRequirementsChecklist({ plan: duplicate, mapping: { requirements: [requirement, { id: "eco-elective-1", label: "Elective", kind: "elective" }] } }).rows;
  assert.ok(rows.every(item => item.status === "still_needed" && item.markers.includes("Listed more than once. It counts once.")));
});

test("verified transfer credit remains completed in the checklist", () => {
  const assignment = { slotId: "eco-113", code: "ECO 113", status: "transfer", evidenceStatus: "VERIFIED" };
  const checklist = buildMajorRequirementsChecklist({ mapping: {
    requirements: [{ id: "eco-113", label: "ECO 113", options: ["ECO 113"] }],
    assignments: [assignment], strict: { assignments: [assignment] }
  } });
  assert.equal(checklist.rows[0].status, "completed");
});

test("saved/direct API data cannot forge checklist credit or remove real approval and standing conditions", async () => {
  const result = economics((await post({ student: sample })).data);
  for (const plan of result.economicsPlans) {
    const submitted = structuredClone(plan);
    submitted.majorRequirementsChecklist.rows.forEach(row => { row.status = "completed"; row.statusLabel = "Completed"; row.symbol = "✓"; row.markers = []; });
    submitted.planConditions = [];
    for (const term of submitted.terms) for (const course of term.courses) course.planningMarkers = [];
    const response = await post({ action: "validate-plan", student: sample, plan: submitted, plans: [submitted] });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data.plan.majorRequirementsChecklist, plan.majorRequirementsChecklist);
    assert.deepEqual(response.data.plan.planConditions, plan.planConditions);
    const report = await buildEconomicsReportFromStudent(sample, sample.planCreationDate, submitted);
    assert.deepEqual(report.majorRequirementsChecklist, plan.majorRequirementsChecklist);
    assert.deepEqual(report.planConditions, plan.planConditions);
    if (plan.id === "one-year-early") {
      const withoutApprovalRequirement = structuredClone(submitted);
      for (const term of withoutApprovalRequirement.terms) for (const course of term.courses) course.approvalRequired = [];
      const rejected = await post({ action: "validate-plan", student: sample, plan: withoutApprovalRequirement, plans: [withoutApprovalRequirement] });
      assert.equal(rejected.status, 422);
      await assert.rejects(buildEconomicsReportFromStudent(sample, sample.planCreationDate, withoutApprovalRequirement));
    }
  }
});

test("2024–25 catalog receives the confirmed Hanover Core HS and W2 notes", async () => {
  const student = { ...sample, generalDegreeCatalogYear: "2024-2025", courses: completed(["ECO 113", "ECO 114"]) };
  const result = economics((await post({ student })).data);
  for (const plan of result.economicsPlans) {
    const note = plan.planNotes.find(item => item.id === "ccr-ace");
    assert.equal(plan.degreeRequirementInformation.evidenceStatus, "SUPPORTED");
    assert.ok(note.items.some(item => /Historical and Social Perspectives \(HS\)/.test(item.text)));
    assert.ok(!note.items.some(item => /We have not confirmed/.test(item.text)));
    const report = await buildEconomicsReportFromStudent(student, sample.planCreationDate, plan);
    assert.deepEqual(report.planNotes, plan.planNotes);
  }
});

for (const state of ["open", "full", "closed", "waitlisted", "unknown"]) {
  for (const [freshness, asOf] of [["current", "2026-09-28"], ["stale", "2026-09-20"], ["undated", null], ["invalid", "unknown"], ["future", "2027-01-01"]]) {
    test(`seat display: ${state}, ${freshness}; offering and recorded seat evidence remain separate`, () => {
      const availability = { status: state, asOf };
      const display = seatStatusPresentation(availability, { verified: true, referenceDate: sample.planCreationDate });
      const unverified = freshness !== "current" || state === "unknown";
      assert.equal(display.label, unverified ? "Seat availability not confirmed" : { open: "OPEN", full: "FULL", closed: "CLOSED", waitlisted: "Waitlist" }[state]);
      assert.equal(seatStatusPresentation(availability, { verified: false, referenceDate: sample.planCreationDate }).label, "Seat availability not confirmed");
      assert.equal(availabilityIsStale(availability, sample.planCreationDate), freshness !== "current");
      const schedule = { academicYear: "2026-2027", terms: { Winter: [{ course: "ECO 113", section: "J", availability }] } };
      const plan = { id: "seat-fixture", validation: { valid: true }, terms: [{ term: "Winter 2027", termKey: "Winter", academicYear: "2026-2027", courses: [{ course: "ECO 113", section: "J", title: "Principles of Microeconomics" }] }] };
      const report = buildEconomicsReport({ student: sample, mapping: { requirements: [], optimistic: { unresolved: [] } }, schedule, economicsPlan: plan, preparedDate: sample.planCreationDate });
      assert.deepEqual(report.terms[0].courses[0].availability, availability);
      assert.deepEqual(report.terms[0].courses[0].seatStatusDisplay, display);
      const html = renderEconomicsHtml(report, template);
      assert.ok(html.includes(display.label));
      if (unverified) assert.ok(!/availability-(open|full)"/.test(html));
    });
  }
}

test("an old plan creation date cannot make historical seats current in a newly prepared report", () => {
  const availability = { status: "open", asOf: "2026-07-30" };
  const schedule = { academicYear: "2026-2027", terms: { Winter: [{ course: "ECO 113", section: "J", availability }] } };
  const plan = { id: "old-seat-fixture", validation: { valid: true }, terms: [{ term: "Winter 2027", termKey: "Winter", academicYear: "2026-2027", courses: [{ course: "ECO 113", section: "J" }] }] };
  const report = buildEconomicsReport({ student: { ...sample, planCreationDate: "2026-07-30" }, mapping: { requirements: [], optimistic: { unresolved: [] } }, schedule, economicsPlan: plan, preparedDate: "2026-09-28" });
  assert.equal(report.terms[0].courses[0].seatStatusDisplay.label, "Seat availability not confirmed");
  assert.deepEqual(report.terms[0].courses[0].availability, availability);
});

test("owner request 2026-11-26: the schedule warning appears once, in the status line or the checklist", async () => {
  const { buildMajorRequirementsChecklist } = await import("../lib/planning/plan-presentation.js");
  const note = feasibilityStatus => buildMajorRequirementsChecklist({ plan: { terms: [], feasibilityStatus }, mapping: { assignments: [], requirements: [] }, student: { courses: [] } }).note;
  // These statuses already show a schedule warning in the plan's status line.
  for (const status of ["CONDITIONALLY_FEASIBLE", "PRELIMINARY_ONLY"]) assert.doesNotMatch(note(status), /Future schedules can change/);
  // Every other plan keeps the warning in the checklist so it is never lost.
  for (const status of ["VERIFIED_FEASIBLE", "NOT_FEASIBLE", "SEARCH_INCOMPLETE", undefined]) assert.match(note(status), /Future schedules can change/);
});
