import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { POST } from "../app/api/majors/map/route.js";
import { resolvePlanningContext } from "../lib/planning/horizon.js";
import { auditExternalEconomicsPlanComplete } from "./oracle/audit-external-plan.js";

const oraclePolicy = JSON.parse(await readFile(
  new URL("./oracle/economics-policy.v1.json", import.meta.url),
  "utf8"
));
const oracleSchedule = JSON.parse(await readFile(
  new URL("./oracle/verified-schedule-2026-2027.json", import.meta.url),
  "utf8"
));

const PROFILES = Object.freeze({
  verifiedFiveRemaining: {
    academicStanding: "senior",
    planCreationDate: "2026-07-30",
    courses: completed([
      "ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "BUSN 323"
    ])
  },
  projectedMove: {
    academicStanding: "sophomore",
    planCreationDate: "2026-07-30",
    courses: completed([
      "ECO 113", "ECO 114", "MAT 113", "MAT 217", "BUSN 323",
      "ECO 161", "ECO 221", "ECO 234", "ECO 260"
    ])
  },
  concurrentCapstone: {
    academicStanding: "senior",
    planCreationDate: "2026-07-30",
    courses: completed([
      "ECO 113", "ECO 213", "MAT 113", "MAT 217", "BUSN 323",
      "ECO 161", "ECO 221", "ECO 234", "ECO 260"
    ])
  },
  largeConcurrentPlan: {
    academicStanding: "senior",
    planCreationDate: "2026-07-30",
    courses: completed(["ECO 113", "MAT 113", "ECO 213"])
  },
  existingHundredLevelElective: {
    academicStanding: "senior",
    planCreationDate: "2026-07-30",
    courses: completed([
      "ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "MAT 217", "BUSN 323",
      "ECO 161", "ECO 221", "ECO 234"
    ])
  },
  futureEco257Statistics: {
    academicStanding: "senior",
    planCreationDate: "2027-07-30",
    courses: completed([
      "ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 113", "BUSN 323",
      "ECO 161", "ECO 221", "ECO 234", "ECO 260"
    ])
  }
});

const TASK15_FINDINGS = Object.freeze({
  intentionalPartialPlan: {
    classification: "CONFIRMED_CAPABILITY_GAP",
    production: "REJECTED",
    oracle: "REJECTED_AS_INCOMPLETE",
    reason: "The validate-plan contract has no partial-plan mode, so an intentional course removal is reported as an unscheduled requirement."
  },
  studentReservationCapacity: {
    classification: "CONFIRMED_PRODUCTION_ORACLE_DISAGREEMENT",
    production: "ACCEPTED",
    oracle: "REJECTED_CAPACITY_EXCEEDED",
    reason: "The handler receives student reservations but does not reconstruct reserved units onto submitted plan terms before validation."
  },
  duplicateRequirementAssignment: {
    classification: "CONFIRMED_PRODUCTION_ORACLE_DISAGREEMENT",
    production: "REJECTED_DUPLICATE_REQUIREMENT",
    oracle: "ACCEPTED_INTERCHANGEABLE_ELECTIVE_SLOTS",
    reason: "Production preserves concrete elective requirement IDs and rejects a duplicated slot, while the independent oracle currently normalizes all elective slot identities as interchangeable."
  }
});

const generatedCache = new Map();

function completed(codes) {
  return codes.map(code => ({ code, status: "completed" }));
}

function profile(name) {
  const student = PROFILES[name];
  assert.ok(student, `Missing Task 15 profile ${name}.`);
  return structuredClone(student);
}

async function postMap(body) {
  const response = await POST(new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  }));
  return { response, data: await response.json() };
}

async function generated(name) {
  if (!generatedCache.has(name)) {
    generatedCache.set(name, (async () => {
      const student = profile(name);
      const result = await postMap({ student });
      assert.equal(result.response.status, 200, `${name} generation failed: ${JSON.stringify(result.data)}`);
      const economics = result.data.programs.find(item => item.program?.id === "economics-base");
      assert.ok(economics?.economicsPlans?.length, `${name} did not generate an Economics plan.`);
      return { student, economics };
    })());
  }
  const value = await generatedCache.get(name);
  return structuredClone(value);
}

async function validateEdit(student, plan, { plans = [plan], extraBody = {} } = {}) {
  return postMap({
    action: "validate-plan",
    student,
    plan,
    plans,
    ...extraBody
  });
}

function courseEntries(plan) {
  return (plan?.terms || []).flatMap(term => (
    (term.courses || []).map(course => ({ term, course }))
  ));
}

function findCourse(plan, predicate) {
  const found = courseEntries(plan).find(({ term, course }) => predicate(course, term));
  assert.ok(found, "The Task 15 mutation could not find its source course.");
  return found;
}

function moveCourse(plan, predicate, targetTermPredicate) {
  const source = findCourse(plan, predicate);
  const target = plan.terms.find(targetTermPredicate);
  assert.ok(target, "The Task 15 mutation could not find its target term.");
  source.term.courses = source.term.courses.filter(course => course !== source.course);
  target.courses.push(source.course);
  return source.course;
}

function verifiedOffering(economics, termKey, courseCode, section, requirementId) {
  const offering = economics.annualSchedule?.terms?.[termKey]?.find(item => (
    item.course === courseCode && item.section === section
  ));
  assert.ok(offering, `Missing canonical ${termKey} ${courseCode}-${section}.`);
  return {
    ...structuredClone(offering),
    requirementId,
    source: "verified-offering",
    offeringStatus: "verified",
    ...(courseCode === "ECO 461" ? { residency: "hanover" } : {})
  };
}

function replaceCourse(plan, predicate, replacement) {
  const found = findCourse(plan, predicate);
  found.term.courses = found.term.courses.map(course => (
    course === found.course ? replacement : course
  ));
}

function staleCondition(plan, course, term) {
  return (plan.feasibility?.enrollmentConditions || []).some(condition => (
    condition.type === "stale_availability"
    && condition.course === course.course
    && condition.term === term.term
  ));
}

function approvalRuleId(approval) {
  if (approval.code === "CONCURRENT_INTERMEDIATE_DEPARTMENT_APPROVAL") {
    return "CONCURRENT-INTERMEDIATE-ECO-461";
  }
  if (approval.code === "CONCURRENT_MATH_INSTRUCTOR_APPROVAL") {
    return approval.course === "ECO 213" ? "CONCURRENT-MATH-ECO-213" : "CONCURRENT-MATH-ECO-214";
  }
  return approval.ruleId || approval.code || null;
}

function oracleApproval(approval) {
  const ruleId = approvalRuleId(approval);
  return {
    ruleId,
    type: ruleId === "CONCURRENT-INTERMEDIATE-ECO-461" ? "DEPARTMENT_APPROVAL" : "INSTRUCTOR_APPROVAL",
    authority: approval.authority,
    course: approval.course,
    prerequisite: approval.prerequisite ?? null,
    term: approval.term,
    reason: approval.reason,
    sourceRef: approval.sourceRef || null
  };
}

function oracleCourse(plan, term, course) {
  const value = {
    ...course,
    canonicalCrossListIdentity: [course.course, ...(course.crossListedAs || [])],
    availability: {
      ...course.availability,
      ...(staleCondition(plan, course, term) ? { freshness: "stale" } : {})
    },
    provenance: {
      verificationDate: course.provenance?.humanVerifiedOn
        ?? course.provenance?.verifiedOn
        ?? course.provenance?.screenshotRetrievedOn
        ?? null,
      sourceReference: course.provenance?.sourceFiles?.[0] ?? null
    },
    ...(course.course === "ECO 461" && course.residency === "hanover"
      ? { institution: "Hanover College" }
      : {}),
    ...(Array.isArray(course.approvalRequired)
      ? { approvalRequired: course.approvalRequired.map(oracleApproval) }
      : {})
  };
  if (!value.section) delete value.section;
  return value;
}

function externalStudent(student) {
  return {
    academicStanding: student.academicStanding,
    completedCourses: (student.courses || [])
      .filter(course => ["completed", "transfer", "in_progress"].includes(course.status))
      .map(course => ({
        course: course.code,
        ...(course.status === "in_progress" ? { projectedCompletion: true } : {})
      })),
    inProgressCourses: (student.courses || [])
      .filter(course => course.status === "in_progress")
      .map(course => ({
        course: course.code,
        academicYear: course.academicYear,
        termKey: course.termKey
      }))
  };
}

function reservedUnits(student, term) {
  return Number(student.reservedCourseUnits?.[term.slotId]
    ?? student.reservedCourseUnits?.[term.term]
    ?? 0);
}

function auditPlan(student, plan) {
  return auditExternalEconomicsPlanComplete({
    student: externalStudent(student),
    expectedContext: resolvePlanningContext(student),
    plan: {
      id: plan.id,
      terms: plan.terms.map(term => ({
        ...term,
        reservedOutsideCourseUnits: reservedUnits(student, term),
        courses: term.courses.map(course => oracleCourse(plan, term, course))
      })),
      requirementClaims: []
    },
    policy: oraclePolicy,
    verifiedSchedule: oracleSchedule
  });
}

function assertEco257OnlyStatistics(plan) {
  for (const { course } of courseEntries(plan)) {
    if (course.course === "ECO 257") assert.equal(course.requirementId, "statistics");
  }
}

function assertOracleAccepted(student, plan) {
  const audit = auditPlan(student, plan);
  assert.equal(
    audit.valid,
    true,
    `Accepted API edit failed the independent oracle: ${JSON.stringify({
      violations: audit.violations,
      reviewItems: audit.reviewItems
    })}`
  );
  assertEco257OnlyStatistics(plan);
  return audit;
}

async function assertAccepted(student, plan, options = {}) {
  const result = await validateEdit(student, plan, options);
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.plan?.validation?.valid, true);
  assert.equal(result.data.planSetValidation?.valid, true);
  assertOracleAccepted(student, result.data.plan);
  return result.data.plan;
}

async function assertRejected(student, plan, reasonPattern, options = {}) {
  const result = await validateEdit(student, plan, options);
  assert.equal(result.response.status, 422, JSON.stringify(result.data));
  assert.equal(result.data.code, "INVALID_PLAN_EDIT");
  assert.equal(result.data.validation?.valid, false);
  assert.ok(
    result.data.validation.errors.some(error => reasonPattern.test(error)),
    `Expected ${reasonPattern}; received ${JSON.stringify(result.data.validation.errors)}`
  );
  const audit = auditPlan(student, plan);
  assert.equal(
    audit.valid,
    false,
    `Production rejected the edit but the independent oracle accepted it: ${JSON.stringify(result.data.validation.errors)}`
  );
  return { result, audit };
}

function eco257ElectiveMutation(plan) {
  const edited = structuredClone(plan);
  const elective = findCourse(edited, course => String(course.requirementId || "").startsWith("eco-elective"));
  elective.course.course = "ECO 257";
  elective.course.title = "Applied Statistics";
  elective.course.section = "";
  elective.course.source = "requirement-placeholder";
  elective.course.offeringStatus = "schedule_confirmation_required";
  elective.course.verificationStatus = "unverified";
  elective.course.availability = { status: "unknown", seatsOpen: null, capacity: null, asOf: null };
  elective.course.meeting = { days: [], startMinutes: null, endMinutes: null };
  elective.course.provenance = {};
  delete elective.course.alternativeOptions;
  delete elective.course.selectedOptionId;
  return edited;
}

function useExplicitProjectedCapstoneSource(plan) {
  const capstone = courseEntries(plan).find(({ course }) => (
    course.course === "ECO 461" && course.source === "recurring-rule-unconfirmed"
  ));
  if (capstone) capstone.course.source = "projected-offering";
  return plan;
}

test("Task 15 API accepts a valid projected-course move and independently revalidates it", async () => {
  const { student, economics } = await generated("projectedMove");
  const edited = structuredClone(economics.economicsPlans.find(plan => plan.id === "plan-1"));
  const moved = moveCourse(
    edited,
    course => course.course === "ECO 214",
    term => term.slotId === "winter-2028"
  );
  assert.equal(moved.source, "projected-offering");
  useExplicitProjectedCapstoneSource(edited);
  const accepted = await assertAccepted(student, edited);
  assert.ok(accepted.terms.find(term => term.slotId === "winter-2028").courses.some(course => course.course === "ECO 214"));
});

test("Task 15 API reports an intentional partial removal as the current capability gap", async t => {
  const finding = TASK15_FINDINGS.intentionalPartialPlan;
  const { student, economics } = await generated("verifiedFiveRemaining");
  const edited = structuredClone(economics.economicsPlans[0]);
  const removed = findCourse(edited, course => String(course.requirementId).startsWith("eco-elective"));
  removed.term.courses = removed.term.courses.filter(course => course !== removed.course);
  const { result, audit } = await assertRejected(student, edited, /remains unscheduled/, {
    extraBody: { allowPartial: true, partialReason: "Student intentionally removed this option for advisor follow-up." }
  });
  assert.equal(finding.classification, "CONFIRMED_CAPABILITY_GAP");
  assert.equal(audit.valid, false);
  assert.match(result.data.error, /cannot be saved/);
  t.diagnostic(JSON.stringify({ scenario: "intentional-partial-removal", ...finding }));
});

test("Task 15 API accepts a valid elective replacement and returns the exact selected option", async () => {
  const { student, economics } = await generated("verifiedFiveRemaining");
  const edited = structuredClone(economics.economicsPlans[0]);
  const selected = findCourse(edited, course => (
    course.course === "ECO 161" && Array.isArray(course.alternativeOptions)
  ));
  const option = selected.course.alternativeOptions.find(item => item.course === "ECO 221");
  assert.ok(option);
  const replacement = {
    ...selected.course,
    ...option,
    requirementId: selected.course.requirementId,
    selectedOptionId: option.id,
    alternativeOptions: selected.course.alternativeOptions
  };
  replaceCourse(edited, course => course === selected.course, replacement);
  const accepted = await assertAccepted(student, edited);
  assert.ok(courseEntries(accepted).some(({ course }) => (
    course.requirementId === replacement.requirementId
    && course.course === "ECO 221"
    && course.selectedOptionId === option.id
  )));
});

test("Task 15 API rejects a prerequisite-breaking move", async () => {
  const { student, economics } = await generated("concurrentCapstone");
  const edited = structuredClone(economics.economicsPlans[0]);
  const original = findCourse(edited, course => course.course === "ECO 114");
  original.term.courses = original.term.courses.filter(course => course !== original.course);
  const winter = edited.terms.find(term => term.termKey === "Winter");
  winter.courses.push(verifiedOffering(economics, "Winter", "ECO 114", "J", original.course.requirementId));
  await assertRejected(student, edited, /ECO 214 is missing prerequisites: ECO 114/);
});

test("Task 15 API rejects an offering-breaking move using the authoritative schedule", async () => {
  const { student, economics } = await generated("projectedMove");
  const edited = structuredClone(economics.economicsPlans[0]);
  moveCourse(edited, course => course.course === "ECO 213", term => term.slotId === "winter-2027");
  await assertRejected(student, edited, /ECO 213 is not verified in the 2026\/2027 Winter offering/);
});

test("Task 15 API rejects substitution of a canonical closed section", async () => {
  const { student, economics } = await generated("concurrentCapstone");
  const edited = structuredClone(economics.economicsPlans[0]);
  replaceCourse(
    edited,
    course => course.course === "ECO 114",
    verifiedOffering(economics, "Fall", "ECO 114", "A", "eco-114")
  );
  await assertRejected(student, edited, /ECO 114-A is closed in Fall 2026/);
});

test("Task 15 API rejects creation of a canonical meeting conflict", async () => {
  const { student, economics } = await generated("largeConcurrentPlan");
  const edited = structuredClone(economics.economicsPlans[0]);
  const selected = findCourse(edited, course => course.course === "ECO 221");
  replaceCourse(
    edited,
    course => course === selected.course,
    verifiedOffering(economics, "Winter", "ECO 161", "J", selected.course.requirementId)
  );
  await assertRejected(student, edited, /ECO 161 conflicts with ECO 321 in Winter 2027/);
});

test("Task 15 API rejects missing and wrong approval metadata", async () => {
  const { student, economics } = await generated("concurrentCapstone");
  const missing = structuredClone(economics.economicsPlans[0]);
  const missingCapstone = findCourse(missing, course => course.course === "ECO 461").course;
  delete missingCapstone.approvalRequired;
  await assertRejected(student, missing, /approval metadata|requiring approval|Economics Department/i);

  const wrong = structuredClone(economics.economicsPlans[0]);
  const wrongCapstone = findCourse(wrong, course => course.course === "ECO 461").course;
  wrongCapstone.approvalRequired[0].authority = "Registrar";
  await assertRejected(student, wrong, /approval metadata|Economics Department|authority/i);
});

test("Task 15 API rejects term-capacity violations", async () => {
  const { student, economics } = await generated("largeConcurrentPlan");
  const edited = structuredClone(economics.economicsPlans[0]);
  moveCourse(
    edited,
    course => course.course === "ECO 222",
    term => term.termKey === "Fall"
  );
  await assertRejected(student, edited, /Fall 2026 exceeds the total course limit/);
});

test("Task 15 records that edited-plan validation currently ignores student reservation capacity", async t => {
  const finding = TASK15_FINDINGS.studentReservationCapacity;
  const generatedResult = await generated("verifiedFiveRemaining");
  const student = {
    ...generatedResult.student,
    reservedCourseUnits: { "fall-2026": 4 }
  };
  const edited = structuredClone(generatedResult.economics.economicsPlans[0]);
  const result = await validateEdit(student, edited);
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.plan.validation.valid, true);
  const audit = auditPlan(student, result.data.plan);
  assert.equal(audit.valid, false);
  assert.ok(audit.violations.some(violation => violation.code === "CAPACITY_EXCEEDED"));
  assert.equal(finding.classification, "CONFIRMED_PRODUCTION_ORACLE_DISAGREEMENT");
  t.diagnostic(JSON.stringify({ scenario: "student-reservation-capacity", ...finding }));
});

test("Task 15 API rejects ECO 461 timing, standing, and residency corruption", async () => {
  const { student, economics } = await generated("concurrentCapstone");
  const original = economics.economicsPlans[0];

  const timing = structuredClone(original);
  moveCourse(timing, course => course.course === "ECO 461", term => term.termKey === "Fall");
  await assertRejected(student, timing, /ECO 461 is not in a valid senior Winter slot/);

  const standing = structuredClone(original);
  standing.terms.find(term => term.termKey === "Winter").absoluteStandingIndex = 2;
  await assertRejected(student, standing, /ECO 461 is not in a valid senior Winter slot|authoritative planning slot/);

  const residency = structuredClone(original);
  delete findCourse(residency, course => course.course === "ECO 461").course.residency;
  await assertRejected(student, residency, /ECO 461 must be identified as a Hanover-residency capstone placement/);
});

test("Task 15 API rejects altered embedded schedule metadata", async () => {
  const { student, economics } = await generated("verifiedFiveRemaining");
  const edited = structuredClone(economics.economicsPlans[0]);
  const verified = findCourse(edited, course => (
    course.source === "verified-offering" && Number.isFinite(course.availability?.seatsOpen)
  )).course;
  verified.availability.seatsOpen += 1;
  await assertRejected(student, edited, /canonical verified schedule for availability seatsOpen/);
});

test("Task 15 API rejects duplicate requirement assignment", async () => {
  const finding = TASK15_FINDINGS.duplicateRequirementAssignment;
  const { student, economics } = await generated("verifiedFiveRemaining");
  const edited = structuredClone(economics.economicsPlans[0]);
  const electives = courseEntries(edited).filter(({ course }) => (
    String(course.requirementId).startsWith("eco-elective")
  ));
  assert.ok(electives.length >= 2);
  electives[1].course.requirementId = electives[0].course.requirementId;
  const result = await validateEdit(student, edited);
  assert.equal(result.response.status, 422);
  assert.equal(result.data.code, "INVALID_PLAN_EDIT");
  assert.ok(result.data.validation.errors.some(error => (
    /Requirement eco-elective-1 is assigned more than once/.test(error)
  )));
  const audit = auditPlan(student, edited);
  assert.equal(audit.valid, true);
  assert.equal(finding.classification, "CONFIRMED_PRODUCTION_ORACLE_DISAGREEMENT");
});

test("Task 15 API rejects a second 100-level Economics elective", async () => {
  const { student, economics } = await generated("existingHundredLevelElective");
  const edited = structuredClone(economics.economicsPlans[0]);
  const plannedElective = findCourse(edited, course => String(course.requirementId).startsWith("eco-elective"));
  replaceCourse(
    edited,
    course => course === plannedElective.course,
    verifiedOffering(economics, "Fall", "ECO 114", "B", plannedElective.course.requirementId)
  );
  await assertRejected(student, edited, /exceeds the one permitted 100-level Economics elective/);
});

test("Task 15 API rejects a term after the authoritative graduation date", async () => {
  const { student, economics } = await generated("verifiedFiveRemaining");
  const edited = structuredClone(economics.economicsPlans[0]);
  const graduationYear = economics.planningContext.expectedGraduationYear;
  const finalTerm = edited.terms.at(-1);
  finalTerm.academicYear = `${graduationYear}/${graduationYear + 1}`;
  finalTerm.yearIndex = economics.planningContext.remainingYears;
  finalTerm.term = `Fall ${graduationYear}`;
  finalTerm.displayTerm = "Fall";
  finalTerm.termKey = "Fall";
  finalTerm.scheduleTerm = "Fall";
  finalTerm.slotId = `fall-${graduationYear}`;
  await assertRejected(student, edited, /graduation planning horizon|authoritative planning slot/);
});

test("Task 15 API rejects ECO 257 assigned to an elective when MAT 217 or PSY 217 fills statistics", async () => {
  for (const statisticsCourse of ["MAT 217", "PSY 217"]) {
    const base = profile("verifiedFiveRemaining");
    base.courses = base.courses.map(course => (
      course.code === "MAT 217" ? { ...course, code: statisticsCourse } : course
    ));
    const generatedResult = await postMap({ student: base });
    assert.equal(generatedResult.response.status, 200);
    const economics = generatedResult.data.programs.find(item => item.program?.id === "economics-base");
    const edited = eco257ElectiveMutation(economics.economicsPlans[0]);
    const { result, audit } = await assertRejected(
      base,
      edited,
      /ECO 257 is not a valid course for requirement eco-elective/
    );
    assert.ok(audit.violations.some(violation => violation.ruleId === "ELECTIVE-ECO-257-STATISTICS-ONLY"));
    assert.equal(result.data.code, "INVALID_PLAN_EDIT");
  }
});

test("Task 15 API accepts ECO 257 only as the statistics requirement", async () => {
  const { student, economics } = await generated("futureEco257Statistics");
  const plan = structuredClone(economics.economicsPlans[0]);
  const eco257 = findCourse(plan, course => course.course === "ECO 257").course;
  assert.equal(eco257.requirementId, "statistics");
  useExplicitProjectedCapstoneSource(plan);
  const accepted = await assertAccepted(student, plan);
  assertEco257OnlyStatistics(accepted);
});

test("Task 15 disagreement registry is explicit and contains no unclassified findings", t => {
  assert.deepEqual(Object.keys(TASK15_FINDINGS).sort(), [
    "duplicateRequirementAssignment",
    "intentionalPartialPlan",
    "studentReservationCapacity"
  ]);
  assert.equal(
    Object.values(TASK15_FINDINGS).filter(item => item.classification === "CONFIRMED_PRODUCTION_ORACLE_DISAGREEMENT").length,
    2
  );
  t.diagnostic(JSON.stringify({ task: 15, findings: TASK15_FINDINGS }));
});
