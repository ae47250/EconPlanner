import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { POST } from "../app/api/majors/map/route.js";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";
import { buildEconomicsReport } from "../lib/reports/economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";
import { buildMajorRequirementsChecklist } from "../lib/planning/plan-presentation.js";
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

test("zero-course input: all three checklists use validated future assignments, full terms, order and identical report content", async () => {
  const result = economics((await post({ student: sample })).data);
  assert.equal(result.economicsPlans.length, 3);
  for (const plan of result.economicsPlans) {
    const checklist = plan.majorRequirementsChecklist;
    assert.equal(checklist.complete, true);
    assert.deepEqual(checklist.legend.map(state => state.label), ["Completed", "In progress", "Planned"]);
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
    assert.ok(!/Requirement assignments|<th>Strict|<th>Optimistic|<td>Advisor check<\/td>|CONDITIONALLY FEASIBLE|planning_projection|stale availability/.test(html));
    assert.equal((html.match(/data-requirement-checklist-id=/g) || []).length, 12);
    for (const item of report.planConditions) assert.equal(html.split(item.message).length - 1, 1);
    assert.ok(html.indexOf("Remaining years at a glance") < html.indexOf("Things to keep in mind"));
    assert.ok(html.indexOf("Things to keep in mind") < html.indexOf("Major requirements checklist"));
    assert.ok(!/availability-open">|availability-full">/.test(html));
    assert.ok(html.includes("We don’t know if there are open seats in "));
    const capstone = checklist.rows.find(row => row.id === "eco-461");
    if (plan.id === "one-year-early") {
      assert.deepEqual(capstone.markers, ["Approval needed", "Ask an advisor to confirm senior standing"]);
      assert.ok(checklist.rows.find(row => row.id === "eco-213").markers.includes("Approval needed"));
      assert.ok(plan.planConditions.some(item => item.message.includes("ECO 213 with ECO 461 in Winter 2028. Approval has not been recorded.")));
      assert.ok(plan.planConditions.some(item => /Senior standing is assumed for 2027–2028/.test(item.message)));
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
  assert.deepEqual(checklist.legend.map(state => state.label), ["Completed", "In progress", "Planned"]);
  const html = renderEconomicsHtml({ student: { displayName: "Fictional <student>", academicStanding: "senior" }, terms: [], unresolved: [], requirements: [], majorRequirementsChecklist: checklist, planConditions: [], planNotes: [] }, template);
  assert.ok(html.includes("Requirements without a planned class"));
  assert.ok(html.includes("A complete plan may still be possible."));
  assert.ok(html.includes("Fictional &lt;student&gt;"));
  assert.ok(!html.includes("is-still_needed"));
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
      // Hosted Open Sans lacks these glyphs. Every row and legend must draw its
      // symbol independently of fonts and keep its accessible text label.
      for (const row of rows) assert.ok(html.includes(`status-icon-${row.status}\" aria-hidden=\"true\"></span> ${row.statusLabel}`));
      assert.equal((html.match(/class="status-icon status-icon-/g) || []).length, 15);
      assert.doesNotMatch(html, /aria-hidden="true">[✓◐○]</);
      assert.match(html, /status-icon-completed\{[^}]+border:/);
      assert.match(html, /status-icon-in_progress:before\{[^}]+background:currentColor/);
    }
  }
});

test("completed ECO 461 keeps qualifying credit without a future senior-standing condition", async () => {
  const student = { ...sample, courses: completed(["ECO 113", "ECO 114", "MAT 113", "MAT 217", "BUSN 323", "ECO 213", "ECO 214", "ECO 461"]) };
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
  assert.deepEqual(row.markers, ["Ask an advisor whether this class counts"]);
  row = buildMajorRequirementsChecklist({ mapping: { requirements: [requirement], assignments: [] } }).rows[0];
  assert.equal(row.status, "still_needed");
  assert.equal(row.courseTerm, "No class matched yet");
  const duplicate = { validation: { valid: false, requirementAllocation: { assignments: [
    { slotId: "eco-113", code: "ECO 113", source: "planned" }, { slotId: "eco-elective-1", code: "ECO 113", source: "planned" }
  ] } }, terms: [{ term: "Winter 2028", courses: [{ course: "ECO 113", requirementId: "eco-113" }, { course: "ECO 113", requirementId: "eco-elective-1" }] }] };
  const rows = buildMajorRequirementsChecklist({ plan: duplicate, mapping: { requirements: [requirement, { id: "eco-elective-1", label: "Elective", kind: "elective" }] } }).rows;
  assert.ok(rows.every(item => item.status === "still_needed" && item.markers.includes("Ask an advisor whether this class counts")));
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

test("unsupported cohort/catalog identifies the HS and W2 claims without granting them", async () => {
  const student = { ...sample, generalDegreeCatalogYear: "2024-2025" };
  const result = economics((await post({ student })).data);
  for (const plan of result.economicsPlans) {
    const note = plan.planNotes.find(item => item.id === "ccr-ace");
    assert.ok(note.items.some(item => /unresolved for 2024-2025.*HS.*ECO 113.*ECO 114.*different-discipline.*W2.*ECO 461/.test(item.text)));
    assert.ok(!note.items.some(item => /satisfied through|planned through/.test(item.text)));
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
