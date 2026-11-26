import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { POST } from "../app/api/majors/map/route.js";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";
import { runtimePolicyBundle } from "../lib/policy/compat-normalized.js";
import { buildEconomicsPlanNotes } from "../lib/planning/plan-notes.js";
import { buildTbcTemporalWitness } from "../lib/decision-engine/tbc-temporal.js";
import { evaluateOffering, evaluateTermElectives, evaluateTermLoad } from "../lib/decision-engine/placement.js";
import { loadCanonicalPolicy, oracleEvaluateElectiveTerm, oracleEvaluateOffering } from "./oracle/load-canonical-policy.js";

const bundle = runtimePolicyBundle();
const oracle = await loadCanonicalPolicy();
const template = await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8");
const economicsCourses = JSON.parse(await readFile(new URL("../policy/courses/economics.json", import.meta.url), "utf8")).courses;
const completed = codes => codes.map(code => ({ code, status: "completed", units: 1 }));
const sample = { displayName: "Fictional PDF sample", academicStanding: "sophomore", entryCatalogYear: "2025-2026",
  planCreationDate: "2026-09-28", planningPace: "one_year_early", courses: [] };
async function post(payload) {
  const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }));
  return { status: response.status, data: await response.json() };
}
const economics = data => data.programs.find(item => item.economicsPlans);
const generic = id => ({ course: "ECO elective", requirementId: `eco-elective-${id}`, minimumLevel: 200,
  source: "projected-offering", publicationStatus: "PLANNING_PROJECTION", units: 1, meeting: null, availability: null });

test("a projected ECO 257 placement tells the student its offering is unconfirmed", () => {
  const plan = { terms: [{ term: "Fall 2028", publicationStatus: "PLANNING_PROJECTION",
    courses: [{ course: "ECO 257", requirementId: "statistics", source: "projected-offering" }] }] };
  const notes = buildEconomicsPlanNotes({ plan, student: sample, mapping: { requirements: [], assignments: [] },
    policyBundle: bundle, courseCatalog: economicsCourses });
  assert.ok(notes.find(note => note.id === "future")?.items.some(item =>
    item.text === "ECO 257 was last offered in Winter 2023. Its future offering is not confirmed."));
});

for (const termKey of ["Fall", "Winter", "May"]) for (const named of [false, true]) {
  test(`${termKey}: named and generic assignments share the unpublished elective limit (${named})`, () => {
    const first = named ? { ...generic(1), course: "ECO 333" } : generic(1);
    const term = { academicYear: "2027-2028", termKey, courses: [first] };
    assert.equal(evaluateTermElectives(term, bundle).status, "ALLOW");
    assert.equal(oracleEvaluateElectiveTerm(oracle, term).status, "ALLOW");
    term.courses.push(generic(2));
    assert.equal(evaluateTermElectives(term, bundle).status, "BLOCK");
    assert.equal(oracleEvaluateElectiveTerm(oracle, term).status, "BLOCK");
    // Another published term in the same academic year cannot establish an exception.
    const partial = structuredClone(bundle);
    partial.indexes.offeringByTerm["2027-FALL"] = { sections: [], coverage: "PARTIAL" };
    assert.equal(evaluateTermElectives(term, partial).status, "BLOCK");
  });
}

test("individually verified sections can exceed the planning limit, while May/load checks remain independent", () => {
  const term = { academicYear: "2026-2027", termKey: "Winter", courses: ["ECO 161", "ECO 221"].map((course, index) =>
    ({ course, requirementId: `eco-elective-${index + 1}`, source: "verified-offering", section: "J", units: 1 })) };
  assert.equal(evaluateTermElectives(term, bundle).status, "ALLOW");
  assert.equal(oracleEvaluateElectiveTerm(oracle, term).status, "ALLOW");
  term.courses[1].section = "MISSING";
  assert.equal(evaluateTermElectives(term, bundle).status, "BLOCK");
  const may = { academicYear: "2026-2027", termKey: "May", courses: ["ECO 222", "ECO 224"].map((course, index) =>
    ({ course, requirementId: `eco-elective-${index + 1}`, source: "verified-offering", section: "S", units: 1 })) };
  assert.equal(evaluateTermElectives(may, bundle).status, "ALLOW");
  assert.equal(evaluateTermLoad(may, {}, bundle).status, "BLOCK");
});

test("future named electives and ECO 321 finance cannot borrow seasonal or prior-year evidence", () => {
  for (const [course, requirementId, termKey] of [["ECO 222", "eco-elective-1", "May"], ["ECO 321", "finance", "Winter"]]) {
    const row = { course, requirementId, source: course === "ECO 222" ? "catalog-statement" : "projected-offering" };
    const term = { academicYear: "2027-2028", termKey };
    assert.equal(evaluateOffering(row, term, bundle.indexes.offeringByTerm, bundle).status, "BLOCK");
    assert.equal(oracleEvaluateOffering(oracle, row, term).status, "BLOCK");
  }
});

test("fictional PDF sample: all plans preserve requirements, generic future electives, notes, labels and report parity", async () => {
  const generated = await post({ student: sample });
  assert.equal(generated.status, 200);
  const result = economics(generated.data);
  assert.ok(result.economicsPlans.some(plan => plan.id === "balanced"));
  assert.ok(result.economicsPlans.some(plan => plan.id === "explore-first"));
  assert.ok(result.economicsPlans.some(plan => plan.id === "one-year-early"));
  for (const plan of result.economicsPlans) {
    assert.equal(plan.validation.valid, true);
    assert.ok(!plan.advisorNotifications.some(notice => notice.message.includes("Course-level planning options")));
    for (const term of plan.terms.filter(term => term.publicationStatus === "PLANNING_PROJECTION")) {
      const electives = term.courses.filter(course => course.requirementId.startsWith("eco-elective"));
      assert.ok(electives.length <= 1);
      assert.ok(electives.every(course => course.course === "ECO elective" && course.minimumLevel === 200 && !course.meeting && !course.availability));
      assert.ok(!term.courses.some(course => course.course === "ECO 321"));
    }
    assert.ok(plan.terms.some(term => term.courses.some(course => course.course === "BUSN 323")));
    assert.deepEqual(plan.planNotes.map(note => note.id), ["ccr-ace", "history", "upcoming", "future"]);
    const history = plan.planNotes.find(note => note.id === "history");
    assert.equal(history.items.length, 3);
    assert.equal(history.items[1].text, "Past Fall schedules included: ECO 333, ECO 357. Past Winter schedules included: ECO 221, ECO 337, ECO 357.");
    assert.deepEqual(history.items[1].lines, ["Past Fall schedules included: ECO 333, ECO 357.", "Past Winter schedules included: ECO 221, ECO 337, ECO 357."]);
    assert.equal(history.items[2].text, "Past May schedules included: ECO 160, ECO 161, ECO 222, ECO 224, ECO 234, ECO 331.");
    const upcoming = plan.planNotes.find(note => note.id === "upcoming");
    assert.equal(upcoming.title, "Published schedules as of the plan date (September 28, 2026)");
    assert.deepEqual(upcoming.items.map(item => item.label), ["Winter 2027", "May 2027"]);
    assert.ok(upcoming.items[0].lines.some(line => line === "ECO 113 · Principles of Microeconomics — Section J: Tue/Thu, 10:00–11:45 a.m.; Section K: Mon/Wed/Fri, 8:00–9:10 a.m."));
    const report = await buildEconomicsReportFromStudent(sample, sample.planCreationDate, plan, result.economicsPlans);
    assert.deepEqual(report.planNotes, plan.planNotes);
    const html = renderEconomicsHtml(report, template);
    assert.ok(!html.includes("Course-level planning options") && !html.includes("Conditional move choices"));
    assert.ok(html.includes("Economics elective (200 level or higher)"));
    assert.ok(!html.includes("depends on successful completion"));
    assert.ok(html.includes("<strong>Section J:</strong>"));
    assert.ok(html.includes("<strong>Section K:</strong>"));
    assert.ok(!html.includes("<strong>S:</strong>"));
    assert.ok(plan.planningDetailMessages.length);
    assert.ok(plan.displayWarnings.includes(bundle.planningAdvice.display.prerequisiteCompletion));
    for (const message of plan.warnings.filter(message => /approval is required/i.test(message))) assert.ok(plan.displayWarnings.includes(message));
    assert.ok(html.includes("<strong>ECO 113</strong>"));
    assert.ok(html.indexOf('data-plan-note="ccr-ace"') < html.indexOf('data-plan-note="history"'));
    assert.ok(html.indexOf('data-plan-note="history"') < html.indexOf('data-plan-note="upcoming"'));
    assert.ok(html.indexOf('data-plan-note="upcoming"') < html.indexOf('data-plan-note="future"'));
  }
});

test("completed filtering removes course-pattern advice and finance advice without activating history", async () => {
  const student = { ...sample, courses: completed(["ECO 113", "ECO 114", "ECO 213", "MAT 113", "BUSN 323", "ECO 161", "ECO 234"]) };
  const result = economics((await post({ student })).data);
  for (const plan of result.economicsPlans) {
    const history = plan.planNotes.find(note => note.id === "history");
    assert.ok(!history.items.some(item => item.text.includes("ECO 213")));
    assert.ok(!history.items.some(item => item.text.includes("ECO 161") || item.text.includes("ECO 234")));
    assert.ok(!plan.planNotes.find(note => note.id === "future")?.items.some(item => item.text.includes("BUSN 323")));
  }
  assert.equal(bundle.provenance.historicalOfferingContract.activationStatus, "INACTIVE_NO_APPROVED_DATA");
  assert.equal(bundle.planningAdvice.planningImpact, "NONE");
  assert.ok(bundle.planningAdvice.observations.every(row => row.academicYear && row.term && row.sourceRange && row.identity));
});

test("upcoming notes include every exact ECO section and never borrow a missing meeting time", () => {
  const withMissingTime = structuredClone(bundle);
  const winter = withMissingTime.indexes.offeringByTerm["2027-WINTER"];
  const section = winter.sections.find(row => row.course === "ECO 113" && row.sectionId.endsWith("-J"));
  delete section.meeting.startTime;
  delete section.meeting.endTime;
  const notes = buildEconomicsPlanNotes({ plan: { terms: [] }, student: sample, courseCatalog: economicsCourses,
    mapping: { requirements: [], optimistic: { unresolved: [] } }, policyBundle: withMissingTime });
  const upcoming = notes.find(note => note.id === "upcoming");
  const lines = upcoming.items.find(item => item.label === "Winter 2027").lines;
  assert.equal(lines.find(line => line.startsWith("ECO 113 ·")),
    "ECO 113 · Principles of Microeconomics — Section J: Tue/Thu, meeting time unavailable; Section K: Mon/Wed/Fri, 8:00–9:10 a.m.");
  assert.ok(upcoming.items.find(item => item.label === "May 2027").lines.includes(
    "ECO 222 · Economics of the European Union — Mon/Tue/Wed/Thu/Fri, 10:15 a.m.–12:30 p.m."));
  for (const item of upcoming.items) {
    const termId = `${item.label.split(" ")[1]}-${item.label.split(" ")[0].toUpperCase()}`;
    const eco = withMissingTime.indexes.offeringByTerm[termId].sections.filter(row => row.course.startsWith("ECO "));
    assert.equal(item.lines.length, new Set(eco.map(row => row.course)).size);
    for (const row of eco) {
      const line = item.lines.find(text => text.startsWith(`${row.course} ·`));
      const sameCourseSections = eco.filter(candidate => candidate.course === row.course);
      if (sameCourseSections.length > 1) assert.ok(line.includes(`Section ${row.sectionId.split("-").at(-1)}:`));
      else assert.ok(!line.includes(`Section ${row.sectionId.split("-").at(-1)}:`));
    }
    assert.ok(item.lines.every(line => !/seats|available now|closed|waitlist/i.test(line)));
  }
});

test("published schedule notes identify the plan-date snapshot used to include Fall 2026", () => {
  const notes = buildEconomicsPlanNotes({ plan: { terms: [] }, student: { planCreationDate: "2026-07-30" },
    courseCatalog: economicsCourses, mapping: { requirements: [] }, policyBundle: bundle });
  const upcoming = notes.find(note => note.id === "upcoming");
  assert.equal(upcoming.title, "Published schedules as of the plan date (July 30, 2026)");
  assert.ok(upcoming.items.some(item => item.label === "Fall 2026"));
});

test("projected Finance notes identify the actual plan choice without claiming Finance is unmet", () => {
  for (const [code, expected] of [
    ["BUSN 323", "This plan places BUSN 323 in Fall 2029. Its future offering is not confirmed."],
    ["ECO 321", "This plan places ECO 321 in Fall 2029. Future adjunct staffing is not confirmed."]
  ]) {
    const notes = buildEconomicsPlanNotes({
      plan: {
        terms: [{ term: "Fall 2029", publicationStatus: "PLANNING_PROJECTION", courses: [{ course: code, requirementId: "finance" }] }],
        validation: { valid: true, requirementAllocation: { assignments: [{ slotId: "finance", code }] } },
        unscheduled: []
      },
      student: { planCreationDate: "2026-09-28" },
      mapping: {
        requirements: [{ id: "finance", label: "Finance" }], assignments: [],
        optimistic: { unresolved: [{ requirementId: "finance" }] }
      },
      policyBundle: bundle
    });
    const financeLines = notes.find(note => note.id === "future").items.map(item => item.text);
    assert.ok(financeLines.includes(expected));
    assert.ok(!financeLines.some(text => /BUSN 323 is preferred|Finance remains unmet/.test(text)));
  }
});

test("direct API and saved-plan edits cannot add two future electives or a named ECO 222 assumption", async () => {
  const result = economics((await post({ student: sample })).data);
  for (const plan of result.economicsPlans) {
    const future = plan.terms.filter(term => term.publicationStatus === "PLANNING_PROJECTION");
    const sources = future.filter(term => term.courses.some(course => course.requirementId.startsWith("eco-elective")));
    assert.ok(sources.length >= 2);
    const row = sources[0].courses.find(course => course.requirementId.startsWith("eco-elective"));
    const blocked = await post({ action: "validate-plan", student: sample, plan, plans: result.economicsPlans,
      edit: { type: "move", fromTermId: sources[0].slotId, toTermId: sources[1].slotId, courseId: row.requirementId } });
    assert.equal(blocked.status, 422);
    const forged = structuredClone(plan);
    const elective = forged.terms.flatMap(term => term.courses).find(course => course.course === "ECO elective");
    elective.course = "ECO 222"; elective.source = "catalog-statement";
    assert.equal((await post({ action: "validate-plan", student: sample, plan: forged, plans: [forged] })).status, 422);
  }
});

test("late entrants retain an explicit extra-elective need and unconfirmed adjunct dependency", async () => {
  const student = { academicStanding: "senior", customGraduationEnabled: true, customExpectedGraduationYear: "2028",
    planCreationDate: "2027-08-24", courses: completed(["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "BUSN 323"]) };
  const result = economics((await post({ student })).data);
  assert.equal(result.economicsPlans.length, 0);
  assert.equal(result.economicsPlanResult.conclusion, "UNKNOWN");
  assert.equal(result.economicsPlanResult.reason, "EXTRA_ELECTIVE_OFFERING_REVIEW_REQUIRED");
  const gap = result.economicsPlanResult.evidence.blockingReasons.find(item => item.unmetElectives);
  assert.equal(gap.unmetElectives, 1);
  assert.equal(gap.message, "You need 1 more Economics elective than the usual schedule offers to finish by May 2028. An extra elective in Fall or Winter may be possible but isn’t confirmed, so ask your advisor.");
});


test("early graduation exposes the extra elective need while keeping standard plans within the limit", async () => {
  const student = { academicStanding: "junior", planningPace: "one_year_early", planCreationDate: "2027-07-30",
    courses: completed(["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "BUSN 323"]) };
  const result = economics((await post({ student })).data);
  assert.ok(result.economicsPlans.length);
  assert.ok(!result.economicsPlans.some(plan => plan.id === "one-year-early"));
  assert.equal(result.economicsAcceleratedResult.status, "MORE_INFORMATION_NEEDED");
  assert.equal(result.economicsAcceleratedResult.evidence.extraElectiveNeeds[0].unmetElectives, 1);
  assert.match(result.economicsAcceleratedResult.message, /more Economics elective than the usual schedule offers.*isn’t confirmed/);
  for (const plan of result.economicsPlans) for (const term of plan.terms) assert.equal(evaluateTermElectives(term, bundle).status, "ALLOW");
});

test("verified ECO 321 takes precedence when finance is still open and future gaps remain visible", async () => {
  const codes = ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "ECO 161", "ECO 221", "ECO 234"];
  const student = { academicStanding: "senior", planCreationDate: "2026-07-30", courses: completed(codes) };
  for (const reservedCourseUnits of [{}, {"fall-2026": 4}]) {
    const result = economics((await post({ student: { ...student, reservedCourseUnits } })).data);
    assert.ok(result.economicsPlans.length);
    for (const plan of result.economicsPlans) {
      const finance = plan.terms.flatMap(term => term.courses).find(course => course.requirementId === "finance");
      assert.equal(finance.course, "ECO 321");
      assert.equal(finance.source, "verified-offering");
    }
  }
  const gapStudent = { ...student, planCreationDate: "2027-07-30", courses: completed([...codes, "ECO 333", "ECO 461"]),
    reservedCourseUnits: {"fall-2027": 4, "winter-2028": 4} };
  const gap = economics((await post({ student: gapStudent })).data);
  assert.equal(gap.economicsPlans.length, 0);
  assert.equal(gap.economicsPlanResult.reason, "RESERVED_ROOM_BLOCKS_PLAN");
  assert.match(gap.economicsPlanResult.evidence.message, /You saved room for 8 other courses across 2 terms/);
});

test("a year-only placeholder needs a legal one-elective-per-term witness", () => {
  const make = count => ({ terms: [{ academicYear: "2027-2028", termKey: "TBC", courses: Array.from({length: count}, (_, i) => generic(i + 1)) }] });
  const facts = { courses: completed(["ECO 113", "ECO 114"]).map(course => ({course:course.code,status:"COMPLETED"})), approvals: [] };
  const three = buildTbcTemporalWitness(make(3), facts, {}, bundle);
  assert.equal(three.topologicalWitness.legal, true);
  assert.equal(new Set(three.placements.map(row => row.assignedTermKey)).size, 3);
  assert.equal(buildTbcTemporalWitness(make(4), facts, {}, bundle).topologicalWitness.legal, false);
  assert.equal(oracleEvaluateElectiveTerm(oracle, make(3).terms[0]).status, "ALLOW");
  assert.equal(oracleEvaluateElectiveTerm(oracle, make(4).terms[0]).status, "BLOCK");
});
