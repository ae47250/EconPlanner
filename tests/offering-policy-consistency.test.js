import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runtimePolicyBundle } from "../lib/policy/compat-normalized.js";
import { courseTermEligibility, evaluateCoursePlacement } from "../lib/decision-engine/placement.js";
import { annotateEconomicsPlanChoices, validateGeneratedPlan } from "../lib/planning/economics.js";
import { applyEconomicsPlanEdit } from "../lib/planning/termSolver.js";
import { selectedPlanContext } from "../lib/planning/horizon.js";
import { loadCatalog } from "../lib/catalog/load.js";
import { buildTbcTemporalWitness } from "../lib/decision-engine/tbc-temporal.js";
import { POST } from "../app/api/majors/map/route.js";
import { buildEconomicsReportFromStudent } from "../lib/reports/build-economics.js";
import { renderEconomicsHtml } from "../lib/reports/economics-html.js";
import { loadCanonicalPolicy, oracleEvaluateOffering } from "./oracle/load-canonical-policy.js";
import { checkExternalEconomicsScheduleAndHorizon } from "./oracle/check-schedule-and-horizon.js";

const bundle = runtimePolicyBundle();
const policy = await loadCanonicalPolicy();
const specification = JSON.parse(await readFile(new URL("./oracle/economics-policy.v1.json", import.meta.url), "utf8"));
const schedule = JSON.parse(await readFile(new URL("./oracle/verified-schedule-2026-2027.json", import.meta.url), "utf8"));
const may = { academicYear: "2027/2028", termKey: "Spring", slotId: "spring-2028", courses: [] };
const expectedExcluded = ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "ECO 257", "ECO 321", "BUSN 323", "PSY 217", "MAT 113", "MAT 121", "ECO 461"];
const placement = code => ({ course: code, source: "projected-offering", residency: "hanover" });
const post = async body => {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  }));
  return { status: response.status, data: await response.json() };
};
const entries = plan => plan.terms.flatMap(term => term.courses.map(course => ({ term, course })));
const baseCompleted = ["ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "BUSN 323", "ECO 221", "ECO 222", "ECO 234", "ECO 333"];
const studentWith = codes => ({ academicStanding: "sophomore", planCreationDate: "2027-07-30", courses: codes.map(code => ({ code, status: "completed" })) });
async function generate(student) {
  const result = await post({ student });
  assert.equal(result.status, 200);
  const plans = result.data.programs.find(item => item.program.id === "economics-base").economicsPlans;
  assert.ok(plans.length);
  return plans[0];
}

test("all canonical May exclusions agree in production and both independent offering checks", () => {
  assert.deepEqual([...bundle.indexes.byRuleId["PLANNING-MAY-COURSE-EXCLUSIONS"].effect.excludedCourses].sort(), [...expectedExcluded].sort());
  for (const code of expectedExcluded.flatMap(code => [code, code.toLowerCase(), ` ${code} `])) {
    const course = placement(code), term = { ...may, courses: [course] };
    assert.equal(courseTermEligibility(course, term, bundle).allowed, false, code);
    assert.equal(oracleEvaluateOffering(policy, course, term).status, "BLOCK", code);
    const external = checkExternalEconomicsScheduleAndHorizon({ policy: specification, verifiedSchedule: schedule, plan: { terms: [term] } });
    assert.ok(external.violations.some(row => row.code === "COURSE_NOT_SUPPORTED_IN_MAY"), code);
  }
  assert.equal(courseTermEligibility(placement("MAT 217"), may, bundle).allowed, true);
  assert.equal(oracleEvaluateOffering(policy, placement("MAT 217"), may).status, "ALLOW");
});

test("intermediate separation depends on verified same-year sections, never projection source labels", () => {
  const term = { academicYear: "2027/2028", termKey: "Winter", courses: [placement("ECO 213"), placement("ECO 214")] };
  for (const source of ["projected-offering", "recurring-rule-unconfirmed", "historical-pattern", "future-placeholder"]) {
    for (const course of term.courses) {
      const submitted = { ...course, source };
      assert.equal(courseTermEligibility(submitted, term, bundle).allowed, false);
      assert.equal(oracleEvaluateOffering(policy, submitted, term).status, "BLOCK");
    }
  }
  // Synthetic release fixture: test the exception without changing any real schedule.
  const sections = term.courses.map(course => ({ course: course.course, sectionId: `2028-WINTER-${course.course.replace(" ", "-")}-A`, crossListedAs: [], enrollmentState: "OPEN" }));
  const exact = structuredClone(bundle);
  exact.indexes.offeringByTerm["2028-WINTER"] = { coverage: "COMPLETE", sections };
  const independent = structuredClone(policy);
  independent.schedule.terms.push({ termId: "2028-WINTER", coverage: "COMPLETE", sections });
  for (const course of term.courses) {
    assert.equal(courseTermEligibility(course, term, exact).allowed, true);
    assert.equal(oracleEvaluateOffering(independent, { ...course, source: "verified-offering" }, term).status, "ALLOW");
  }
  delete exact.indexes.offeringByTerm["2028-WINTER"];
  exact.indexes.offeringByTerm["2029-WINTER"] = { coverage: "COMPLETE", sections };
  assert.equal(courseTermEligibility(term.courses[0], term, exact).allowed, false);
});

test("matching exact May evidence overrides projection exclusions, not independent capstone rules", () => {
  for (const code of expectedExcluded.filter(code => code !== "ECO 461")) {
    const exact = structuredClone(bundle), independent = structuredClone(policy);
    const sections = [{ course: code, sectionId: `2028-MAY-${code.replace(" ", "-")}-S`, crossListedAs: [], enrollmentState: "OPEN" }];
    exact.indexes.offeringByTerm["2028-MAY"] = { coverage: "COMPLETE", sections };
    independent.schedule.terms.push({ termId: "2028-MAY", coverage: "COMPLETE", sections });
    assert.equal(courseTermEligibility(placement(code), may, exact).allowed, true, code);
    assert.equal(oracleEvaluateOffering(independent, { ...placement(code), source: "verified-offering" }, may).status, "ALLOW", code);
  }
  assert.equal(evaluateCoursePlacement(placement("ECO 461"), may, {}, bundle).status, "BLOCK");
});

test("ECO 222 uses its approved May projection scope and requires exact evidence for another term", () => {
  const winter = { academicYear: "2027/2028", termKey: "Winter", slotId: "winter-2028", courses: [] };
  const projected = placement("ECO 222");
  const mayProjection = { ...may, courses: [projected] };
  assert.equal(courseTermEligibility(projected, mayProjection, bundle).allowed, true);
  assert.equal(oracleEvaluateOffering(policy, projected, mayProjection).status, "ALLOW");
  const verifiedMay2027 = { academicYear: "2026-2027", termKey: "May", slotId: "spring-2027", courses: [] };
  assert.equal(courseTermEligibility(projected, verifiedMay2027, bundle).allowed, true);
  assert.equal(oracleEvaluateOffering(policy, projected, verifiedMay2027).status, "ALLOW");
  assert.equal(courseTermEligibility(projected, winter, bundle).allowed, false);
  assert.equal(oracleEvaluateOffering(policy, projected, winter).status, "BLOCK");

  const knownMayAbsence = structuredClone(bundle);
  knownMayAbsence.indexes.offeringByTerm["2028-MAY"] = { coverage: "COMPLETE", sections: [] };
  const may2028 = { academicYear: "2027/2028", termKey: "May", slotId: "spring-2028", courses: [] };
  assert.equal(courseTermEligibility(projected, may2028, knownMayAbsence).allowed, false);
  const oracleKnownMayAbsence = structuredClone(policy);
  oracleKnownMayAbsence.schedule.terms.push({ termId: "2028-MAY", coverage: "COMPLETE", sections: [] });
  assert.equal(oracleEvaluateOffering(oracleKnownMayAbsence, projected, may2028).status, "BLOCK");

  // Synthetic exact-schedule evidence exercises the exception without changing a dated release.
  const exactAlternate = structuredClone(bundle);
  exactAlternate.indexes.offeringByTerm["2028-WINTER"] = {
    coverage: "COMPLETE",
    sections: [{ course: "ECO 222", crossListedAs: [], sectionId: "2028-WINTER-ECO-222-J" }]
  };
  assert.equal(courseTermEligibility(projected, winter, exactAlternate).allowed, true);
  const oracleExactAlternate = structuredClone(policy);
  oracleExactAlternate.schedule.terms.push({
    termId: "2028-WINTER", coverage: "COMPLETE",
    sections: [{ course: "ECO 222", crossListedAs: [], sectionId: "2028-WINTER-ECO-222-J", enrollmentState: "OPEN" }]
  });
  assert.equal(oracleEvaluateOffering(oracleExactAlternate, projected, winter).status, "ALLOW");
});

test("ECO 222 exact alternate-term evidence passes complete edit validation", async () => {
  const student = { academicStanding: "freshman", planningPace: "one_year_early", planCreationDate: "2026-09-23", courses: [] };
  const generated = await post({ student });
  const economics = generated.data.programs.find(item => item.program.id === "economics-base");
  const plan = economics.economicsPlans.find(item => item.id === "one-year-early");
  const original = entries(plan).find(row => row.course.course === "ECO 222");
  const destination = plan.terms.find(term => term.slotId === "fall-2027");
  const offeredCourses = [...destination.courses.map(course => course.course), "ECO 222"];
  const sections = offeredCourses.map(code => ({
    course: code,
    sectionId: `2027-FALL-${code.replaceAll(" ", "-")}-S`,
    crossListedAs: [],
    enrollmentState: "OPEN",
    sourceRefs: []
  }));

  const exactAlternate = structuredClone(bundle);
  exactAlternate.indexes.offeringByTerm["2027-FALL"] = { coverage: "COMPLETE", sections };
  const catalog = await loadCatalog(generated.data.catalog.selectedCatalogYear);
  const exactSchedule = structuredClone(catalog.economicsSchedule);
  exactSchedule.academicYear = "";
  exactSchedule.terms.Fall.push(...offeredCourses.map(code => ({
    course: code,
    section: "S",
    academicYear: "2027-2028",
    term: "Fall",
    units: 1,
    verificationStatus: "verified",
    availability: { status: "open" },
    crossListedAs: []
  })));

  const independentExactAlternate = structuredClone(policy);
  independentExactAlternate.schedule.terms.push({
    termId: "2027-FALL", coverage: "COMPLETE",
    sections: sections.map(section => ({ ...section }))
  });
  const destinationTerm = { ...destination, courses: [...destination.courses, placement("ECO 222")] };
  assert.equal(oracleEvaluateOffering(independentExactAlternate, placement("ECO 222"), destinationTerm).status, "ALLOW");
  const externalCourse = {
    course: "ECO 222", source: "verified-offering", section: "S",
    title: "Economics of the European Union", units: 1,
    canonicalCrossListIdentity: ["ECO 222"],
    verificationStatus: "verified", academicYear: "2027-2028", term: "Fall",
    availability: { status: "open", seatsOpen: null, capacity: null },
    meeting: { days: [], startTime: null, endTime: null },
    provenance: { verificationDate: "2027-01-01", sourceReference: "SYNTHETIC-EXACT-ALTERNATE-TEST" }
  };
  const externalExactAlternate = checkExternalEconomicsScheduleAndHorizon({
    policy: specification,
    verifiedSchedule: {
      academicYear: "2027-2028",
      sections: [{
        academicYear: "2027-2028", term: "Fall", course: "ECO 222", section: "S",
        canonicalCrossListIdentity: ["ECO 222"], title: "Economics of the European Union", units: 1,
        availability: { state: "open", seatsOpen: null, capacity: null },
        meeting: { days: [], startTime: null, endTime: null },
        verificationDate: "2027-01-01", sourceReference: "SYNTHETIC-EXACT-ALTERNATE-TEST"
      }]
    },
    plan: { terms: [{ academicYear: "2027/2028", termKey: "Fall", courses: [externalCourse] }] }
  });
  assert.equal(externalExactAlternate.valid, true, JSON.stringify(externalExactAlternate.violations));

  const edited = applyEconomicsPlanEdit({
    plan,
    edit: { type: "move", fromTermId: original.term.slotId, toTermId: destination.slotId, courseId: original.course.requirementId },
    student, mapping: economics, schedule: exactSchedule,
    prerequisites: catalog.prerequisitesByProgram.get("economics"), courseCatalog: catalog.economicsCourses,
    policyBundle: exactAlternate, refreshAlternatives: false
  });
  const validation = validateGeneratedPlan(edited, {
    student, mapping: economics, schedule: exactSchedule,
    prerequisites: catalog.prerequisitesByProgram.get("economics"),
    context: selectedPlanContext(economics.planningContext, plan),
    policyBundle: exactAlternate, enforcePlanIntegrity: true
  });
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(validation.errors.length, 0);
  assert.equal(edited.terms.find(term => term.slotId === "fall-2027").courses
    .find(course => course.course === "ECO 222").source, "verified-offering");
});

test("canonical pattern changes refresh both ECO 222 choices and full edit validation", async () => {
  const student = { academicStanding: "freshman", planningPace: "one_year_early", planCreationDate: "2026-09-23", courses: [] };
  const generated = await post({ student });
  const economics = generated.data.programs.find(item => item.program.id === "economics-base");
  const plan = economics.economicsPlans.find(item => item.id === "one-year-early");
  const original = entries(plan).find(row => row.course.course === "ECO 222");
  assert.equal(original.course.moveDestinationOptions.find(option => option.id === "winter-2028").status, "BLOCKED");

  const modifiedCanonicalBundle = structuredClone(bundle);
  modifiedCanonicalBundle.indexes.offeringPatternsById["CATALOG-ECO-222-SPRING"].approvedRecurringTerms.push("WINTER");
  assert.equal(courseTermEligibility(placement("ECO 222"), {
    academicYear: "2027/2028", termKey: "Winter", slotId: "winter-2028", courses: []
  }, modifiedCanonicalBundle).allowed, true);

  const catalog = await loadCatalog(generated.data.catalog.selectedCatalogYear);
  const context = selectedPlanContext(economics.planningContext, plan);
  const changedChoices = annotateEconomicsPlanChoices({
    plans: [plan], student, mapping: economics, schedule: catalog.economicsSchedule,
    prerequisites: catalog.prerequisitesByProgram.get("economics"), courseCatalog: catalog.economicsCourses,
    context: economics.planningContext, policyBundle: modifiedCanonicalBundle
  })[0];
  assert.ok(changedChoices.terms.flatMap(term => term.courses)
    .find(course => course.course === "ECO 222").moveDestinationIds.includes("winter-2028"));

  const edited = applyEconomicsPlanEdit({
    plan,
    edit: { type: "move", fromTermId: original.term.slotId, toTermId: "winter-2028", courseId: original.course.requirementId },
    student, mapping: economics, schedule: catalog.economicsSchedule,
    prerequisites: catalog.prerequisitesByProgram.get("economics"), courseCatalog: catalog.economicsCourses,
    policyBundle: modifiedCanonicalBundle, refreshAlternatives: false
  });
  const validation = validateGeneratedPlan(edited, {
    student, mapping: economics, schedule: catalog.economicsSchedule,
    prerequisites: catalog.prerequisitesByProgram.get("economics"), context, policyBundle: modifiedCanonicalBundle,
    enforcePlanIntegrity: true
  });
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
});

test("a soft recurring-term pattern explains the usual term without excluding other terms", async () => {
  const student = { academicStanding: "freshman", planningPace: "one_year_early", planCreationDate: "2026-09-23", courses: [] };
  const generated = await post({ student });
  const economics = generated.data.programs.find(item => item.program.id === "economics-base");
  const plan = economics.economicsPlans.find(item => item.id === "one-year-early");
  const modifiedCanonicalBundle = structuredClone(bundle);
  delete modifiedCanonicalBundle.indexes.offeringPatternsById["CATALOG-ECO-222-SPRING"].projectionPolicy.unpublishedTermEligibility;
  const winter = { academicYear: "2027/2028", termKey: "Winter", slotId: "winter-2028", courses: [] };
  assert.equal(courseTermEligibility(placement("ECO 222"), winter, modifiedCanonicalBundle).allowed, true);

  const catalog = await loadCatalog(generated.data.catalog.selectedCatalogYear);
  const annotated = annotateEconomicsPlanChoices({
    plans: [plan], student, mapping: economics, schedule: catalog.economicsSchedule,
    prerequisites: catalog.prerequisitesByProgram.get("economics"), courseCatalog: catalog.economicsCourses,
    context: economics.planningContext, policyBundle: modifiedCanonicalBundle
  })[0];
  const eco222 = entries(annotated).find(row => row.course.course === "ECO 222").course;
  const winterChoice = eco222.moveDestinationOptions.find(option => option.id === "winter-2028");
  assert.equal(winterChoice.status, "CONDITIONAL", winterChoice.message);
  assert.match(winterChoice.message, /usual projection terms for ECO 222 are May.*Winter remains eligible.*no binding exclusion/);
});

test("year-only placeholders retain a distinct-term witness for the intermediates", () => {
  const plan = { terms: [{ academicYear: "2027/2028", termKey: "TBC", courses: [placement("ECO 213"), placement("ECO 214")] }] };
  const facts = { courses: ["ECO 113", "ECO 114", "MAT 113"].map(course => ({ course, status: "COMPLETED" })), approvals: [] };
  const result = buildTbcTemporalWitness(plan, facts, {}, bundle);
  assert.equal(result.topologicalWitness.legal, true);
  assert.equal(new Set(result.placements.map(row => row.assignedTermKey)).size, 2);
});

test("generation can use May MAT 217 when all pre-capstone regular terms are full", async () => {
  const student = studentWith(baseCompleted);
  student.reservedCourseUnits = { "fall-2027": 4, "winter-2028": 4, "fall-2028": 4, "winter-2029": 4, "fall-2029": 4, "winter-2030": 3 };
  const plan = await generate(student);
  const statistics = entries(plan).find(row => row.course.requirementId === "statistics");
  assert.equal(statistics.course.course, "MAT 217");
  assert.equal(statistics.term.termKey, "Spring");
  assert.equal(statistics.course.source, "projected-offering");
  assert.equal(plan.validation.valid, true);
});

test("MAT 217 May survives move, saved-plan validation and selected-plan HTML reporting", async () => {
  const student = studentWith(baseCompleted), plan = await generate(student);
  const statistics = entries(plan).find(row => row.course.requirementId === "statistics");
  statistics.course.course = "MAT 217";
  statistics.course.title = "Applied Statistics";
  const baseline = await post({ action: "validate-plan", student, plan, plans: [plan] });
  assert.equal(baseline.status, 200);
  const from = entries(baseline.data.plan).find(row => row.course.requirementId === "statistics");
  assert.ok(from.course.moveDestinationIds.includes("spring-2028"));
  const moved = await post({ action: "validate-plan", student, plan: baseline.data.plan, plans: [baseline.data.plan], edit: {
    type: "move", planId: plan.id, fromTermId: from.term.slotId, toTermId: "spring-2028", courseId: "statistics"
  } });
  assert.equal(moved.status, 200);
  assert.equal((await post({ action: "validate-plan", student, plan: moved.data.plan })).status, 200);
  const report = await buildEconomicsReportFromStudent(student, "2027-07-30", moved.data.plan);
  assert.equal(report.terms.find(term => term.courses.some(course => course.code === "MAT 217")).term, "Spring/May 2028");
  assert.ok(renderEconomicsHtml(report, await readFile(new URL("../templates/econplannertemplate.html", import.meta.url), "utf8")).includes("MAT 217"));
});

test("ECO 321 May is omitted and rejected, including forged saved plans and reports", async () => {
  const student = studentWith([...baseCompleted.filter(code => code !== "BUSN 323"), "MAT 217"]), plan = await generate(student);
  const finance = entries(plan).find(row => row.course.requirementId === "finance");
  finance.course.course = "ECO 321"; finance.course.title = "Money and Financial Markets";
  const baseline = await post({ action: "validate-plan", student, plan });
  assert.equal(baseline.status, 200);
  const from = entries(baseline.data.plan).find(row => row.course.requirementId === "finance");
  assert.ok(!from.course.moveDestinationIds.includes("spring-2028"));
  const rejected = await post({ action: "validate-plan", student, plan: baseline.data.plan, edit: {
    type: "move", planId: plan.id, fromTermId: from.term.slotId, toTermId: "spring-2028", courseId: "finance"
  } });
  assert.equal(rejected.status, 422);
  const forged = structuredClone(baseline.data.plan), source = forged.terms.find(term => term.slotId === from.term.slotId);
  const course = source.courses.splice(source.courses.findIndex(course => course.requirementId === "finance"), 1)[0];
  course.moveDestinationIds = ["spring-2028"];
  forged.terms.find(term => term.slotId === "spring-2028").courses.push(course);
  assert.equal((await post({ action: "validate-plan", student, plan: forged })).status, 422);
  await assert.rejects(buildEconomicsReportFromStudent(student, "2027-07-30", forged), /validation/);
});

test("both intermediate dropdowns omit the counterpart's projected term and direct edits reject it", async () => {
  const student = studentWith(["ECO 113", "ECO 114", "MAT 113", "MAT 217"]), plan = await generate(student);
  for (const code of ["ECO 213", "ECO 214"]) {
    const from = entries(plan).find(row => row.course.course === code), to = entries(plan).find(row => ["ECO 213", "ECO 214"].includes(row.course.course) && row.course.course !== code);
    assert.ok(!from.course.moveDestinationIds.includes(to.term.slotId));
    const result = await post({ action: "validate-plan", student, plan, edit: {
      type: "move", planId: plan.id, fromTermId: from.term.slotId, toTermId: to.term.slotId, courseId: from.course.requirementId
    } });
    assert.equal(result.status, 422);
  }
});


test("year-only intermediate placement respects the counterpart already fixed in a term", () => {
  const plan = { terms: [
    { academicYear: "2027/2028", termKey: "Fall", courses: [{ ...placement("ECO 214"), fixedInProgress: true }] },
    { academicYear: "2027/2028", termKey: "TBC", courses: [placement("ECO 213")] }
  ] };
  const facts = { courses: ["ECO 113", "ECO 114", "MAT 113"].map(course => ({ course, status: "COMPLETED" })), approvals: [] };
  const witness = buildTbcTemporalWitness(plan, facts, {}, bundle);
  assert.equal(witness.placements[0].assignedTermKey, "WINTER");
  const blocked = buildTbcTemporalWitness(plan, facts, { authoritativeSlots: [
    { academicYear: "2027/2028", termKey: "Winter", reservedCourseUnits: 4 }
  ] }, bundle);
  assert.equal(blocked.status, "BLOCK");
});

test("supporting projections reference the sole canonical May list", async () => {
  const flexibility = JSON.parse(await readFile(new URL("../policy/rules/planning-flexibility.json", import.meta.url), "utf8"));
  assert.equal(flexibility.supportingCoursePlacement.termEligibilityRuleId, "PLANNING-MAY-COURSE-EXCLUSIONS");
  assert.equal(Object.hasOwn(flexibility.supportingCoursePlacement, "planningTerms"), false);
  assert.ok(bundle.indexes.byRuleId[flexibility.supportingCoursePlacement.termEligibilityRuleId]);
  await assert.rejects(readFile(new URL("../data/raw/economics/Econ_Course_Offerings.md", import.meta.url)), { code: "ENOENT" });
});

test("equivalent course spellings cannot bypass intermediate separation in submitted plans or reports", async () => {
  const student = studentWith(["ECO 113", "ECO 114", "MAT 113", "MAT 217"]);
  const original = await generate(student);
  assert.equal((await post({ action: "validate-plan", student, plan: original })).status, 200);
  for (const spelling of [code => code.toLowerCase(), code => ` ${code} `]) {
    const plan = structuredClone(original);
    const first = entries(plan).find(row => row.course.course === "ECO 213");
    const second = entries(plan).find(row => row.course.course === "ECO 214");
    first.course.course = spelling("ECO 213");
    second.course.course = spelling("ECO 214");
    first.term.courses.splice(first.term.courses.indexOf(first.course), 1);
    second.term.courses.push(first.course);
    const submitted = await post({ action: "validate-plan", student, plan });
    assert.equal(submitted.status, 422);
    assert.ok(submitted.data.validation.policyDecision.decisions.some(decision => decision.reasonCode === "INTERMEDIATE_SAME_TERM_REQUIRES_VERIFIED_SCHEDULE"));
    await assert.rejects(buildEconomicsReportFromStudent(student, "2027-07-30", plan), /validation/);
  }
});

test("whitespace in ECO 321 cannot bypass its May exclusion in submissions or reports", async () => {
  const student = studentWith([...baseCompleted.filter(code => code !== "BUSN 323"), "MAT 217"]);
  const plan = await generate(student);
  const finance = entries(plan).find(row => row.course.requirementId === "finance");
  finance.course.course = " ECO 321 ";
  assert.equal((await post({ action: "validate-plan", student, plan })).status, 200);
  finance.term.courses.splice(finance.term.courses.indexOf(finance.course), 1);
  plan.terms.find(term => term.slotId === "spring-2028").courses.push(finance.course);
  const submitted = await post({ action: "validate-plan", student, plan });
  assert.equal(submitted.status, 422);
  assert.ok(submitted.data.validation.policyDecision.decisions.some(decision => decision.reasonCode === "COURSE_NOT_SUPPORTED_IN_MAY"));
  await assert.rejects(buildEconomicsReportFromStudent(student, "2027-07-30", plan), /validation/);
});

test("duplicate canonical term rows cannot split intermediate occupancy in submissions or reports", async () => {
  const student = studentWith(["ECO 113", "ECO 114", "MAT 113", "MAT 217"]);
  const plan = await generate(student);
  const first = entries(plan).find(row => row.course.course === "ECO 213");
  const second = entries(plan).find(row => row.course.course === "ECO 214");
  first.term.courses.splice(first.term.courses.indexOf(first.course), 1);
  plan.terms.splice(plan.terms.indexOf(second.term), 0, {
    ...structuredClone(second.term), academicYear: second.term.academicYear.replace("/", "-"), courses: [first.course]
  });
  const submitted = await post({ action: "validate-plan", student, plan });
  assert.equal(submitted.status, 422);
  assert.match(submitted.data.error, /DUPLICATE_TERM_IDENTITY/);
  await assert.rejects(buildEconomicsReportFromStudent(student, "2027-07-30", plan), /validation/);
});
