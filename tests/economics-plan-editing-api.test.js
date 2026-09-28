import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { POST } from "../app/api/majors/map/route.js";
import { resolvePlanningContext } from "../lib/planning/horizon.js";
import { auditExternalEconomicsPlanComplete } from "./oracle/audit-external-plan.js";
import { loadCanonicalPolicy, oracleEvaluateCanonicalPlan } from "./oracle/load-canonical-policy.js";

const oraclePolicy = JSON.parse(await readFile(
  new URL("./oracle/economics-policy.v1.json", import.meta.url),
  "utf8"
));
const oracleSchedule = JSON.parse(await readFile(
  new URL("./oracle/verified-schedule-2026-2027.json", import.meta.url),
  "utf8"
));

test("ordinary freshman plans agree with the independent policy Oracle and early edits rebuild evidence", async () => {
  const student = { academicStanding: "freshman", planningPace: "one_year_early", planCreationDate: "2026-09-23", courses: [] };
  const generated = await postMap({student});
  const plans = generated.data.programs.find(item => item.program.id === "economics-base").economicsPlans;
  assert.equal(plans.length, 3);
  const policy = await loadCanonicalPolicy();
  for (const plan of plans) assert.equal(oracleEvaluateCanonicalPlan(policy, student, plan).valid, true, plan.id);
  const early = plans.find(plan => plan.id === "one-year-early");
  const original = structuredClone(early);
  const move = async (course, toTermId) => {
    const from = early.terms.find(term => term.courses.some(item => item.course === course));
    return validateEdit(student, early, {plans, extraBody: {edit: {
      type: "move", fromTermId: from.slotId, courseId: from.courses.find(item => item.course === course).requirementId, toTermId
    }}});
  };
  const valid = await move("MAT 217", "winter-2027");
  assert.equal(valid.response.status, 200, JSON.stringify(valid.data));
  assert.equal(valid.data.plan.planningContext.expectedGraduationTerm, "Spring/May 2029");
  const statistics = valid.data.plan.terms.find(term => term.slotId === "winter-2027").courses.find(course => course.course === "MAT 217");
  assert.ok(["J", "K", "L", "M"].includes(statistics.section));
  assert.notEqual(statistics.section, "S");
  assert.equal(statistics.source, "verified-offering");
  assert.equal(statistics.slotId, "winter-2027");
  assert.ok(early.warnings.some(message => message.includes("MAT 217-S")), "The source plan must carry the May section warning.");
  assert.ok(!valid.data.plan.warnings.some(message => message.includes("MAT 217-S")), "The moved plan must drop the old section warning.");
  assert.ok(!valid.data.plan.studentMessages.some(message => message.includes("MAT 217-S")));
  const invalid = await move("MAT 217", "winter-2029");
  assert.equal(invalid.response.status, 422);
  assert.match(invalid.data.error, /prerequisite|statistics/i);
  assert.doesNotMatch(invalid.data.error, /Fall 2028|projected standing/);
  const capstone = early.terms.flatMap(term => term.courses.map(course => ({ term, course })))
    .find(item => item.course.course === "ECO 461");
  const earlierWinter = early.terms.find(term => term.termKey === "Winter" && term.yearIndex < capstone.term.yearIndex);
  assert.ok(earlierWinter, "The accelerated horizon must contain an earlier Winter to assess.");
  assert.ok(!capstone.course.moveDestinationIds.includes(earlierWinter.slotId),
    "An accelerated plan must omit Winters before its final-year senior-standing assumption.");
  const directEarlyWinter = await validateEdit(student, early, { plans, extraBody: { edit: {
    type: "move", fromTermId: capstone.term.slotId, courseId: capstone.course.requirementId,
    toTermId: earlierWinter.slotId
  } } });
  assert.equal(directEarlyWinter.response.status, 422);
  assert.match(directEarlyWinter.data.error, /valid senior Winter slot/);
  const projected = await move("ECO 222", "winter-2028");
  assert.equal(projected.response.status, 422, JSON.stringify(projected.data));
  assert.match(projected.data.error, /May|term|offering/i);
  assert.deepEqual(early, original, "failed and successful requests must not mutate the original plan");
});

test("moving ECO 214 before ECO 461 removes a no-longer-required concurrent approval", async () => {
  const student = {
    academicStanding: "junior", planCreationDate: "2026-07-30",
    courses: completed(["MAT 113", "ECO 161", "ECO 221"])
  };
  const generated = await postMap({ student });
  const plans = generated.data.programs.find(item => item.program.id === "economics-base").economicsPlans;
  const plan = plans.find(item => item.id === "balanced");
  const original = structuredClone(plan);
  const source = plan.terms.find(term => term.slotId === "winter-2028");
  const course = source.courses.find(item => item.course === "ECO 214");
  assert.ok(source.courses.find(item => item.course === "ECO 461").approvalRequired?.length);
  const edited = await validateEdit(student, plan, { plans, extraBody: { edit: {
    type: "move", fromTermId: source.slotId, toTermId: "winter-2027", courseId: course.requirementId
  } } });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.data));
  const capstone = edited.data.plan.terms.flatMap(term => term.courses).find(item => item.course === "ECO 461");
  assert.equal(capstone.approvalRequired?.length || 0, 0);
  assert.equal(edited.data.plan.feasibility.requiredApprovals.some(item => item.course === "ECO 461"), false);
  assert.deepEqual(plan, original);
});

test("senior statistics explanation follows the actual horizon and disappears when statistics are satisfied", async () => {
  const student = {academicStanding: "senior", planCreationDate: "2026-09-23", courses: completed([
    "ECO 113", "ECO 114", "MAT 113", "MAT 217", "ECO 213", "ECO 214", "BUSN 323", "ECO 161", "ECO 221", "ECO 222", "ECO 234"
  ])};
  const result = async () => (await postMap({student})).data.programs.find(item => item.program.id === "economics-base");
  const ready = await result();
  assert.ok(ready.economicsPlans.length);
  assert.equal(ready.planningContext.remainingYears, 1);
  assert.equal(ready.planningContext.expectedGraduationYear, 2027);
  assert.ok(ready.economicsPlans.every(plan => plan.validation.valid));
  student.courses = student.courses.filter(course => course.code !== "MAT 217");
  const blocked = await result();
  assert.equal(blocked.economicsPlanResult.category, "INFEASIBLE_PROVEN");
  assert.equal(blocked.economicsPlanResult.evidence.blockingReasons.length, 1);
  assert.match(blocked.economicsPlanResult.evidence.blockingReasons[0].message, /Winter 2027.*ECO 461.*statistics.*before/);
  student.planCreationDate = "2026-07-30";
  assert.deepEqual((await result()).economicsPlanResult.evidence.blockingReasons, []);
});

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
    courses: completed(["ECO 113", "ECO 114", "MAT 113", "ECO 213"])
  },
  flexibleFourYearPlan: {
    academicStanding: "freshman",
    planCreationDate: "2026-08-02",
    courses: []
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
    classification: "CONFIRMED_PRODUCTION_ORACLE_AGREEMENT",
    production: "REJECTED_CAPACITY_EXCEEDED",
    oracle: "REJECTED_CAPACITY_EXCEEDED",
    reason: "Production and the independent oracle both enforce authoritative student reservations when a submitted plan is validated."
  },
  duplicateRequirementAssignment: {
    classification: "CONFIRMED_PRODUCTION_ORACLE_AGREEMENT",
    production: "REJECTED_DUPLICATE_REQUIREMENT",
    oracle: "REJECTED_DUPLICATE_ELECTIVE_SLOT_ASSIGNMENT",
    reason: "Verified against the owner-adopted September 26 submitted-slot contract: both reject duplicate declared assignments and accept swaps between distinct elective slots."
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
      verificationDate: course.provenance?.verifiedOn ?? null,
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

function projectedReservedUnits(student, term) {
  const year = Number(String(term.academicYear || "").match(/\d{4}/)?.[0]);
  if (!Number.isFinite(year)) return {};
  return {
    Fall: Number(student.reservedCourseUnits?.[`fall-${year}`] || 0),
    Winter: Number(student.reservedCourseUnits?.[`winter-${year + 1}`] || 0),
    "Spring/May": Number(student.reservedCourseUnits?.[`spring-${year + 1}`]
      ?? student.reservedCourseUnits?.[`may-${year + 1}`]
      ?? 0)
  };
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
        reservedOutsideCourseUnitsByProjectedTerm: projectedReservedUnits(student, term),
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

async function assertProductionAccepted(student, plan, options = {}) {
  const result = await validateEdit(student, plan, options);
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.plan?.validation?.valid, true);
  assert.equal(result.data.planSetValidation?.valid, true);
  return result.data.plan;
}

async function assertAccepted(student, plan, options = {}) {
  const acceptedPlan = await assertProductionAccepted(student, plan, options);
  assertOracleAccepted(student, acceptedPlan);
  return acceptedPlan;
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

async function _futureFourCourseFallPlan() {
  const { student, economics } = await generated("flexibleFourYearPlan");
  const plan = structuredClone(economics.economicsPlans.find(item => item.label === "Balanced"));
  assert.ok(plan, "Balanced is required for the future four-course Fall capacity fixture.");
  const fall = plan.terms.find(term => term.academicYear === "2029/2030" && term.termKey === "Fall");
  assert.ok(fall);
  const winterCourse = moveCourse(plan, (course, term) => (
    term.academicYear === "2029/2030"
      && term.termKey === "Winter"
      && course.course !== "ECO 461"
  ), term => term === fall);
  const springElective = moveCourse(plan, (course, term) => (
    term.academicYear === "2029/2030"
      && ["Spring", "May", "Spring/May"].includes(term.termKey)
      && String(course.requirementId).startsWith("eco-elective")
  ), term => term === fall);
  Object.assign(winterCourse, { projectedTerm: "Fall", planningSequence: 2 });
  Object.assign(springElective, { projectedTerm: "Fall", planningSequence: 3 });
  useExplicitProjectedCapstoneSource(plan);
  return { student, plan };
}

async function _futureTwoCourseFallPlan() {
  const { student, economics } = await generated("flexibleFourYearPlan");
  const plan = structuredClone(economics.economicsPlans.find(item => item.label === "Balanced"));
  assert.ok(plan, "Balanced is required for the future total-capacity fixture.");
  useExplicitProjectedCapstoneSource(plan);
  return { student, plan };
}

test("edit API rejects an individually valid plan that duplicates another comparison schedule", async () => {
  const { student, economics } = await generated("flexibleFourYearPlan");
  const [first, second] = economics.economicsPlans;
  assert.ok(first && second, "This regression requires two generated plans.");
  const duplicate = {
    ...structuredClone(first),
    id: second.id,
    label: second.label
  };
  const plans = economics.economicsPlans.map(plan => plan.id === second.id ? duplicate : plan);

  const { response, data } = await validateEdit(student, duplicate, { plans });
  assert.equal(response.status, 422, JSON.stringify(data));
  assert.equal(data.code, "INVALID_PLAN_SET");
  assert.equal(data.planSetValidation?.valid, false);
  assert.match(data.error, /same material schedule/);
});

test("Task 15 API accepts a valid published-course move and independently revalidates it", async () => {
  const { student, economics } = await generated("concurrentCapstone");
  const edited = structuredClone(economics.economicsPlans.find(plan => plan.id === "balanced"));
  const moved = findCourse(edited, course => course.course === "ECO 214").course;
  Object.assign(moved, { projectedTerm: "Winter", planningSequence: 100 });
  assert.equal(moved.source, "verified-offering");
  useExplicitProjectedCapstoneSource(edited);
  const accepted = await assertAccepted(student, edited);
  assert.ok(courseEntries(accepted).some(({ course }) => course.course === "ECO 214" && course.projectedTerm === "Winter"));
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

test("Task 15 API rejects a prerequisite-breaking move", async () => {
  const { student, economics } = await generated("concurrentCapstone");
  const edited = structuredClone(economics.economicsPlans[0]);
  const original = findCourse(edited, course => course.course === "ECO 114");
  original.term.courses = original.term.courses.filter(course => course !== original.course);
  const winter = edited.terms.find(term => term.termKey === "Winter");
  winter.courses.push(verifiedOffering(economics, "Winter", "ECO 114", "J", original.course.requirementId));
  await assertRejected(student, edited, /ECO 214 is missing prerequisites: ECO 114/);
});

test("Task 15 API rejects an elective replacement that breaks course prerequisites", async () => {
  const { student, economics } = await generated("flexibleFourYearPlan");
  const plan = structuredClone(economics.economicsPlans[0]);
  const exactScheduleSlots = new Set(["fall-2026", "winter-2027", "spring-2027"]);
  const elective = findCourse(plan, (course, term) => (
    String(course.requirementId || "").startsWith("eco-elective") && !exactScheduleSlots.has(term.slotId)
  ));
  const candidate = {
    id: `${elective.course.requirementId}@forged-ECO-471`,
    course: "ECO 471",
    title: "Senior Thesis",
    section: "",
    source: "projected-offering",
    availability: null,
    meeting: null,
    verificationStatus: "unverified"
  };
  elective.course.alternativeOptions = [...(elective.course.alternativeOptions || []), candidate];
  const result = await validateEdit(student, plan, {
    plans: economics.economicsPlans.map(item => item.id === plan.id ? plan : item),
    extraBody: {
      edit: {
        type: "option",
        planId: plan.id,
        fromTermId: elective.term.slotId,
        courseId: elective.course.requirementId,
        optionId: candidate.id
      }
    }
  });
  assert.equal(result.response.status, 422, JSON.stringify(result.data));
  assert.equal(result.data.code, "INVALID_PLAN_EDIT", JSON.stringify(result.data));
  assert.ok(result.data.validation.errors.some(error => /ECO 471 is missing prerequisites: ECO 321/.test(error)),
    JSON.stringify(result.data.validation.errors));
});

test("Task 15 API rejects an offering-breaking move using the authoritative schedule", async () => {
  const { student, economics } = await generated("projectedMove");
  const edited = structuredClone(economics.economicsPlans[0]);
  moveCourse(edited, course => course.course === "ECO 213", term => term.slotId === "winter-2027");
  await assertRejected(student, edited, /ECO 213.*(?:not verified|cannot use a projected offering)/);
});

test("Task 15 API preserves FULL as an explicit review state", async () => {
  const { student, economics } = await generated("concurrentCapstone");
  const edited = structuredClone(economics.economicsPlans[0]);
  replaceCourse(
    edited,
    course => course.course === "ECO 114",
    verifiedOffering(economics, "Fall", "ECO 114", "C", "eco-114")
  );
  const accepted = await assertProductionAccepted(student, edited);
  assert.equal(accepted.validation.approved, false);
  assert.ok(accepted.validation.reviewFindings.some(finding => finding.reasonCode === "ENROLLMENT_FULL"));
});

test("Task 15 API rejects creation of a canonical meeting conflict", async () => {
  const { student, economics } = await generated("largeConcurrentPlan");
  const edited = structuredClone(economics.economicsPlans[0]);
  const selected = findCourse(edited, course => course.course === "MAT 217");
  selected.term.courses = selected.term.courses.filter(course => course !== selected.course);
  const winter = edited.terms.find(term => term.termKey === "Winter");
  winter.courses.push(verifiedOffering(economics, "Winter", "MAT 217", "K", selected.course.requirementId));
  await assertRejected(student, edited, /(?:MAT 217 conflicts with ECO 461|ECO 461 conflicts with MAT 217) in Winter 2027/);
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

test("Task 15 accepts one Fall course with three reserved spaces and rejects two", async () => {
  const student = {
    ...profile("verifiedFiveRemaining"),
    reservedCourseUnits: { "fall-2026": 3 }
  };
  const generatedResult = await postMap({ student });
  assert.equal(generatedResult.response.status, 200, JSON.stringify(generatedResult.data));
  const economics = generatedResult.data.programs.find(item => item.program?.id === "economics-base");
  const exactCapacity = structuredClone(economics.economicsPlans[0]);
  const fallCourse = findCourse(exactCapacity, (_course, term) => term.slotId === "fall-2026");
  const alternative = fallCourse.course.alternativeOptions.find(option => option.course !== fallCourse.course.course);
  assert.ok(alternative);
  replaceCourse(exactCapacity, course => course === fallCourse.course, {
    ...fallCourse.course,
    ...alternative,
    requirementId: fallCourse.course.requirementId,
    selectedOptionId: alternative.id,
    alternativeOptions: fallCourse.course.alternativeOptions
  });
  const accepted = await assertProductionAccepted(student, exactCapacity);
  assert.equal(accepted.terms.find(term => term.slotId === "fall-2026").courses.length, 1);

  const unreserved = await generated("verifiedFiveRemaining");
  await assertRejected(
    student,
    structuredClone(unreserved.economics.economicsPlans[0]),
    /Fall 2026 exceeds the total course limit/
  );
});

test("Task 15 gives four reserved Fall spaces and one reserved Spring/May space zero planner capacity", async () => {
  const generatedResult = await generated("verifiedFiveRemaining");
  const fallStudent = {
    ...generatedResult.student,
    reservedCourseUnits: { "fall-2026": 4 }
  };
  await assertRejected(
    fallStudent,
    structuredClone(generatedResult.economics.economicsPlans[0]),
    /Fall 2026 exceeds the total course limit/
  );

  const springStudent = {
    ...generatedResult.student,
    reservedCourseUnits: { "spring-2027": 1 }
  };
  await assertRejected(
    springStudent,
    structuredClone(generatedResult.economics.economicsPlans[0]),
    /Spring\/May 2027 exceeds the total course limit/
  );
});

test("Task 15 ignores submitted reservation metadata and uses the authoritative student request", async t => {
  const finding = TASK15_FINDINGS.studentReservationCapacity;
  const generatedResult = await generated("verifiedFiveRemaining");
  const authoritativeReservation = {
    ...generatedResult.student,
    reservedCourseUnits: { "fall-2026": 4 }
  };
  const understated = structuredClone(generatedResult.economics.economicsPlans[0]);
  const understatedFall = understated.terms.find(term => term.slotId === "fall-2026");
  understatedFall.reservedCourseUnits = 0;
  understatedFall.reservedOutsideCourseUnits = 0;
  const { audit } = await assertRejected(
    authoritativeReservation,
    understated,
    /Fall 2026 exceeds the total course limit/
  );
  assert.ok(audit.violations.some(violation => violation.code === "CAPACITY_EXCEEDED"));

  const overstated = structuredClone(generatedResult.economics.economicsPlans[0]);
  const overstatedFall = overstated.terms.find(term => term.slotId === "fall-2026");
  overstatedFall.reservedCourseUnits = 4;
  overstatedFall.reservedOutsideCourseUnits = 4;
  await assertAccepted(generatedResult.student, overstated);

  assert.equal(finding.classification, "CONFIRMED_PRODUCTION_ORACLE_AGREEMENT");
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
  const canonicalAudit = oracleEvaluateCanonicalPlan(await loadCanonicalPolicy(), student, edited);
  assert.equal(canonicalAudit.valid, false);
  assert.ok(canonicalAudit.findings.some(item => item.reasonCode === "DUPLICATE_ELECTIVE_SLOT_ASSIGNMENT"));
  const audit = auditPlan(student, edited);
  assert.equal(audit.valid, false);
  assert.ok(audit.violations.some(item => item.code === "ELECTIVE-SLOT-UNIQUE-ASSIGNMENT"
    && /eco-elective-1.*more than once/.test(item.message)), JSON.stringify(audit.violations));
});

test("distinct elective-slot swaps preserve courses and terms and pass both validators", async () => {
  const { student, economics } = await generated("verifiedFiveRemaining");
  const original = economics.economicsPlans[0];
  const edited = structuredClone(original);
  const electives = courseEntries(edited).filter(({ course }) => String(course.requirementId).startsWith("eco-elective"));
  assert.ok(electives.length >= 2);
  const firstId = electives[0].course.requirementId;
  const secondId = electives[1].course.requirementId;
  assert.notEqual(firstId, secondId);
  electives[0].course.requirementId = secondId;
  electives[1].course.requirementId = firstId;
  const withoutAssignments = plan => plan.terms.map(term => ({ ...term,
    courses: term.courses.map(({ requirementId: _id, ...course }) => course)
  }));
  assert.deepEqual(withoutAssignments(edited), withoutAssignments(original));
  assertOracleAccepted(student, original);
  assertOracleAccepted(student, edited);
  assert.equal(oracleEvaluateCanonicalPlan(await loadCanonicalPolicy(), student, edited).valid, true);
  await assertAccepted(student, edited);
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
    const electiveCourse = courseEntries(economics.economicsPlans[0]).find(({ course }) => (
      String(course.requirementId || "").startsWith("eco-elective")
    ))?.course;
    assert.ok(electiveCourse, "The plan must expose an elective replacement choice.");
    assert.equal(Boolean(electiveCourse.alternativeOptions?.some(option => option.course === "ECO 257")), false,
      "ECO 257 cannot be offered as an elective replacement when it is assigned to statistics.");
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
  const statistics = findCourse(plan, course => course.requirementId === "statistics").course;
  Object.assign(statistics, {
    course: "ECO 257",
    title: "Quantitative Methods for Business/Economics",
    source: "projected-offering",
    offeringStatus: "future_schedule_confirmation_required",
    verificationStatus: "unverified"
  });
  const eco257 = statistics;
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
    0
  );
  assert.equal(
    Object.values(TASK15_FINDINGS).filter(item => item.classification === "CONFIRMED_PRODUCTION_ORACLE_AGREEMENT").length,
    2
  );
  t.diagnostic(JSON.stringify({ task: 15, findings: TASK15_FINDINGS }));
});
