import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import {
  validateGeneratedPlan
} from "../lib/planning/economics.js";
import { normalizeEconomicsSchedule } from "../lib/planning/scheduleProvider.js";
import {
  auditExternalEconomicsPlanComplete as auditExternalEconomicsPlan
} from "./oracle/audit-external-plan.js";
import {
  ECONOMICS_PLAN_MUTATION_IDS,
  mutateEconomicsPlanCase
} from "./helpers/economics-plan-mutators.js";

const registry = JSON.parse(await readFile(
  new URL("./fixtures/economics-validator-disagreements.v1.json", import.meta.url),
  "utf8"
));
const productionRequirements = JSON.parse(await readFile(
  new URL("../data/normalized/economics/requirements.json", import.meta.url),
  "utf8"
));
const productionPrerequisites = JSON.parse(await readFile(
  new URL("../data/normalized/economics/prerequisites.json", import.meta.url),
  "utf8"
));
const rawProductionSchedule = JSON.parse(await readFile(
  new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url),
  "utf8"
));
const oraclePolicy = JSON.parse(await readFile(
  new URL("./oracle/economics-policy.v1.json", import.meta.url),
  "utf8"
));
const oracleSchedule = JSON.parse(await readFile(
  new URL("./oracle/verified-schedule-2026-2027.json", import.meta.url),
  "utf8"
));

const productionSchedule = normalizeEconomicsSchedule(rawProductionSchedule);
const PROGRAM = Object.freeze({ id: "economics", name: "Economics" });
const APPROVAL_TYPES = Object.freeze({
  CONCURRENT_INTERMEDIATE_DEPARTMENT_APPROVAL: "DEPARTMENT_APPROVAL",
  CONCURRENT_MATH_INSTRUCTOR_APPROVAL: "INSTRUCTOR_APPROVAL"
});
const STANDING_INDEX = Object.freeze({
  freshman: 0,
  sophomore: 1,
  junior: 2,
  senior: 3
});
const COMPLETE_WITHOUT_CAPSTONE = Object.freeze([
  "ECO 113",
  "ECO 114",
  "ECO 213",
  "ECO 214",
  "MAT 217",
  "BUSN 323",
  "MAT 113",
  "ECO 161",
  "ECO 234",
  "ECO 260",
  "ECO 333"
]);

function clone(value) {
  return structuredClone(value);
}

function completedCourses(codes) {
  return codes.map(code => ({
    code,
    status: "completed",
    units: 1,
    source: "student_record"
  }));
}

function planningContext({ startYear, remainingYears, standing }) {
  const expectedGraduationYear = startYear + remainingYears;
  return {
    startYear,
    entryAcademicYearStart: startYear - STANDING_INDEX[standing],
    planningPace: "standard",
    projectedSeniorStandingBasis: "college_year_progression",
    remainingYears,
    expectedGraduationYear,
    expectedGraduationTerm: `Spring/May ${expectedGraduationYear}`,
    standing,
    effectiveStanding: standing,
    planCreationDate: `${startYear}-07-30`,
    isTransferStudent: false,
    requiresSummerClarification: false
  };
}

function planTerm({ startYear, yearIndex, termKey, courses, standing }) {
  const academicStart = startYear + yearIndex;
  const isFall = termKey === "Fall";
  const isWinter = termKey === "Winter";
  const calendarYear = isFall ? academicStart : academicStart + 1;
  const displayTerm = isFall ? "Fall" : isWinter ? "Winter" : "Spring/May";
  return {
    slotId: `${isFall ? "fall" : isWinter ? "winter" : "spring"}-${calendarYear}`,
    term: `${displayTerm} ${calendarYear}`,
    displayTerm,
    academicYear: `${academicStart}/${academicStart + 1}`,
    termKey,
    scheduleTerm: termKey === "Spring" ? "May" : termKey,
    yearIndex,
    absoluteStandingIndex: STANDING_INDEX[standing] + yearIndex,
    isSummer: false,
    courses
  };
}

function projectedCourse(course, requirementId, extra = {}) {
  return {
    course,
    requirementId,
    title: course,
    units: 1,
    source: "projected-offering",
    offeringStatus: "projected",
    verificationStatus: "unverified",
    crossListedAs: [],
    availability: { status: "unknown" },
    meeting: {
      days: [],
      startTime: null,
      endTime: null,
      startDate: null,
      endDate: null
    },
    ...extra
  };
}

function verifiedCourse(termKey, course, section, requirementId, extra = {}) {
  const row = (productionSchedule.terms?.[termKey] || []).find(item => (
    item.course === course && item.section === section
  ));
  assert.ok(row, `missing production schedule row ${termKey}/${course}/${section}`);
  return {
    ...clone(row),
    academicYear: productionSchedule.academicYear,
    term: termKey,
    crossListedAs: [...(row.crossListedAs || [])],
    requirementId,
    source: "verified-offering",
    offeringStatus: "verified",
    ...extra
  };
}

function makePlan(id, context, terms) {
  return {
    id,
    label: id,
    planningMode: "graduation_priority",
    planningContext: context,
    terms
  };
}

function makeStudent(standing, planCreationDate, codes = []) {
  return {
    academicStanding: standing,
    planCreationDate,
    courses: completedCourses(codes)
  };
}

function takeCourse(plan, courseCode) {
  const located = plan.terms.flatMap(term => (
    term.courses.filter(course => course.course === courseCode).map(course => ({ term, course }))
  ));
  assert.equal(located.length, 1, `baseline expected one ${courseCode}`);
  located[0].term.courses = located[0].term.courses.filter(course => course !== located[0].course);
  return located[0].course;
}

function findTerm(plan, slotId) {
  const term = plan.terms.find(item => item.slotId === slotId);
  assert.ok(term, `baseline missing ${slotId}`);
  return term;
}

function findPlannedCourse(plan, code) {
  const matches = plan.terms.flatMap(term => term.courses.filter(course => course.course === code));
  assert.equal(matches.length, 1, `baseline expected one planned ${code}`);
  return matches[0];
}

function fullSequenceBaseline() {
  const context = planningContext({ startYear: 2026, remainingYears: 3, standing: "sophomore" });
  const terms = [
    planTerm({
      startYear: 2026,
      yearIndex: 0,
      termKey: "Fall",
      standing: "sophomore",
      courses: [
        verifiedCourse("Fall", "ECO 114", "A", "eco-114"),
        verifiedCourse("Fall", "ECO 234", "A", "eco-elective-1")
      ]
    }),
    planTerm({
      startYear: 2026,
      yearIndex: 0,
      termKey: "Winter",
      standing: "sophomore",
      courses: [
        verifiedCourse("Winter", "ECO 113", "J", "eco-113"),
        verifiedCourse("Winter", "ECO 161", "J", "eco-elective-2")
      ]
    }),
    planTerm({
      startYear: 2026,
      yearIndex: 0,
      termKey: "Spring",
      standing: "sophomore",
      courses: [verifiedCourse("May", "ECO 224", "S", "eco-elective-3")]
    }),
    planTerm({
      startYear: 2026,
      yearIndex: 1,
      termKey: "Fall",
      standing: "sophomore",
      courses: [projectedCourse("MAT 113", "cognate")]
    }),
    planTerm({
      startYear: 2026,
      yearIndex: 1,
      termKey: "Winter",
      standing: "sophomore",
      courses: [
        projectedCourse("ECO 214", "eco-214"),
        projectedCourse("ECO 257", "statistics")
      ]
    }),
    planTerm({
      startYear: 2026,
      yearIndex: 1,
      termKey: "Spring",
      standing: "sophomore",
      courses: [projectedCourse("ECO elective", "eco-elective-4", { minimumLevel: 200 })]
    }),
    planTerm({
      startYear: 2026,
      yearIndex: 2,
      termKey: "Fall",
      standing: "sophomore",
      courses: [
        projectedCourse("ECO 213", "eco-213"),
        projectedCourse("BUSN 323", "finance")
      ]
    }),
    planTerm({
      startYear: 2026,
      yearIndex: 2,
      termKey: "Winter",
      standing: "sophomore",
      courses: [projectedCourse("ECO 461", "eco-461", { residency: "hanover" })]
    })
  ];
  return {
    id: "full-sequence",
    context,
    student: makeStudent("sophomore", context.planCreationDate),
    plan: makePlan("baseline-full-sequence", context, terms),
    verifiedCourseTemplates: {
      "ECO 114:A": verifiedCourse("Fall", "ECO 114", "A", "eco-114"),
      "ECO 114:B": verifiedCourse("Fall", "ECO 114", "B", "eco-114"),
      "ECO 114:C": verifiedCourse("Fall", "ECO 114", "C", "eco-114")
    }
  };
}

function fullFallBaseline() {
  const result = fullSequenceBaseline();
  result.id = "full-fall";
  result.plan.id = "baseline-full-fall";
  const fall = findTerm(result.plan, "fall-2028");
  fall.courses.push(takeCourse(result.plan, "ECO 257"));
  fall.courses.push(takeCourse(result.plan, "ECO elective"));
  findTerm(result.plan, "winter-2029").courses.push(takeCourse(result.plan, "ECO 214"));
  findPlannedCourse(result.plan, "ECO 461").approvalRequired = [{
    code: "CONCURRENT_INTERMEDIATE_DEPARTMENT_APPROVAL", type: "department", authority: "Economics Department",
    course: "ECO 461", prerequisite: "ECO 214", term: "Winter 2029", reason: "concurrent_intermediate_with_capstone",
    policySource: "department-confirmed-local-policy", sourceRef: "data/raw/economics/Department_Confirmed_Planning_Policies.md#policy-4",
    message: "ECO 214 is planned concurrently with ECO 461. Economics Department approval is required."
  }];
  assert.equal(fall.courses.length, 4);
  return result;
}

function fullMayBaseline() {
  const result = fullSequenceBaseline();
  result.id = "full-may";
  result.plan.id = "baseline-full-may";
  const statistics = findPlannedCourse(result.plan, "ECO 257");
  statistics.course = "MAT 217"; statistics.title = "Applied Statistics";
  assert.equal(findTerm(result.plan, "spring-2028").courses.length, 1);
  return result;
}

function completedElectiveBaseline() {
  const result = fullSequenceBaseline();
  result.id = "completed-elective";
  result.plan.id = "baseline-completed-elective";
  takeCourse(result.plan, "ECO 224");
  result.student.courses = completedCourses(["ECO 224"]);
  findPlannedCourse(result.plan, "ECO 234").requirementId = "eco-elective-2";
  findPlannedCourse(result.plan, "ECO 161").requirementId = "eco-elective-3";
  findPlannedCourse(result.plan, "ECO elective").requirementId = "eco-elective-4";
  return result;
}

function futureCapstoneBaseline() {
  const context = planningContext({ startYear: 2027, remainingYears: 1, standing: "senior" });
  const terms = [planTerm({
    startYear: 2027,
    yearIndex: 0,
    termKey: "Winter",
    standing: "senior",
    courses: [projectedCourse("ECO 461", "eco-461", { residency: "hanover" })]
  })];
  return {
    id: "future-capstone",
    context,
    student: makeStudent("senior", context.planCreationDate, COMPLETE_WITHOUT_CAPSTONE),
    plan: makePlan("baseline-future-capstone", context, terms)
  };
}

function juniorCapstoneBaseline() {
  const context = planningContext({ startYear: 2027, remainingYears: 2, standing: "junior" });
  const terms = [planTerm({
    startYear: 2027,
    yearIndex: 1,
    termKey: "Winter",
    standing: "junior",
    courses: [projectedCourse("ECO 461", "eco-461", { residency: "hanover" })]
  })];
  return {
    id: "junior-capstone",
    context,
    student: makeStudent("junior", context.planCreationDate, COMPLETE_WITHOUT_CAPSTONE),
    plan: makePlan("baseline-junior-capstone", context, terms)
  };
}

function statisticsBeforeCapstoneBaseline() {
  const context = planningContext({ startYear: 2027, remainingYears: 2, standing: "junior" });
  const completed = COMPLETE_WITHOUT_CAPSTONE.filter(code => code !== "MAT 217");
  const terms = [
    planTerm({
      startYear: 2027,
      yearIndex: 0,
      termKey: "Fall",
      standing: "junior",
      courses: [projectedCourse("MAT 217", "statistics")]
    }),
    planTerm({
      startYear: 2027,
      yearIndex: 1,
      termKey: "Winter",
      standing: "junior",
      courses: [projectedCourse("ECO 461", "eco-461", { residency: "hanover" })]
    })
  ];
  return {
    id: "statistics-before-capstone",
    context,
    student: makeStudent("junior", context.planCreationDate, completed),
    plan: makePlan("baseline-statistics-before-capstone", context, terms)
  };
}

function concurrentCapstoneBaseline() {
  const context = planningContext({ startYear: 2026, remainingYears: 1, standing: "senior" });
  const completed = COMPLETE_WITHOUT_CAPSTONE.filter(code => code !== "ECO 214");
  const approval = {
    code: "CONCURRENT_INTERMEDIATE_DEPARTMENT_APPROVAL",
    type: "department",
    authority: "Economics Department",
    course: "ECO 461",
    prerequisite: "ECO 214",
    term: "Winter 2027",
    reason: "concurrent_intermediate_with_capstone",
    policySource: "department-confirmed-local-policy",
    sourceRef: "data/raw/economics/Department_Confirmed_Planning_Policies.md#policy-4",
    message: "ECO 214 is planned concurrently with ECO 461. Economics Department approval is required."
  };
  const terms = [planTerm({
    startYear: 2026,
    yearIndex: 0,
    termKey: "Winter",
    standing: "senior",
    courses: [
      verifiedCourse("Winter", "ECO 214", "J", "eco-214"),
      verifiedCourse("Winter", "ECO 461", "J", "eco-461", {
        residency: "hanover",
        approvalRequired: [approval]
      })
    ]
  })];
  return {
    id: "concurrent-capstone",
    context,
    student: makeStudent("senior", context.planCreationDate, completed),
    plan: makePlan("baseline-concurrent-capstone", context, terms)
  };
}

const BASELINE_FACTORIES = Object.freeze({
  "full-sequence": fullSequenceBaseline,
  "full-fall": fullFallBaseline,
  "full-may": fullMayBaseline,
  "completed-elective": completedElectiveBaseline,
  "future-capstone": futureCapstoneBaseline,
  "junior-capstone": juniorCapstoneBaseline,
  "statistics-before-capstone": statisticsBeforeCapstoneBaseline,
  "concurrent-capstone": concurrentCapstoneBaseline
});

function oracleApproval(approval) {
  const ruleId = approval.code === "CONCURRENT_INTERMEDIATE_DEPARTMENT_APPROVAL"
    ? "CONCURRENT-INTERMEDIATE-ECO-461"
    : approval.course === "ECO 213"
      ? "CONCURRENT-MATH-ECO-213"
      : "CONCURRENT-MATH-ECO-214";
  const manifestRule = [
    ...(oraclePolicy.concurrencyRules || []),
    ...(oraclePolicy.permissionRules || [])
  ].find(rule => rule.ruleId === ruleId);
  return {
    ruleId,
    type: APPROVAL_TYPES[approval.code],
    authority: approval.authority,
    course: approval.course,
    prerequisite: approval.prerequisite ?? null,
    term: approval.term,
    reason: approval.reason,
    sourceRef: manifestRule?.sourceRefs?.[0] || null
  };
}

function oracleCourse(course) {
  const value = {
    ...clone(course),
    canonicalCrossListIdentity: [course.course, ...(course.crossListedAs || [])],
    availability: { ...course.availability },
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

function oracleInput(caseData) {
  const completed = caseData.student.courses.filter(course => (
    course.status === "completed" || course.status === "transfer" || course.status === "in_progress"
  ));
  return {
    student: {
      academicStanding: caseData.student.academicStanding,
      completedCourses: completed.map(course => ({ course: course.code, units: course.units || 1 })),
      inProgressCourses: caseData.student.courses
        .filter(course => course.status === "in_progress")
        .map(course => ({
          course: course.code,
          academicYear: course.academicYear,
          termKey: course.termKey
        }))
    },
    expectedContext: caseData.context,
    plan: {
      id: caseData.plan.id,
      requirementClaims: [],
      terms: caseData.plan.terms.map(term => ({
        ...clone(term),
        courses: term.courses.map(oracleCourse)
      }))
    },
    policy: oraclePolicy,
    verifiedSchedule: oracleSchedule
  };
}

function evaluateCase(caseData) {
  const mapping = mapStudentToProgram(PROGRAM, productionRequirements, caseData.student);
  const productionPlan = structuredClone(caseData.plan);
  const production = validateGeneratedPlan(productionPlan, {
    student: caseData.student,
    mapping,
    schedule: rawProductionSchedule,
    prerequisites: productionPrerequisites,
    context: caseData.context,
    enforcePlanIntegrity: true
  });
  const oracle = auditExternalEconomicsPlan(oracleInput(caseData));
  return { production, oracle };
}

function resultLabel(valid) {
  return valid ? "ACCEPT" : "REJECT";
}

function substantiveReviews(audit) {
  return audit.reviewItems.filter(item => item.code !== "RULE_FAMILY_NOT_CHECKED");
}

function classifiedStatus(production, oracle, expectedStatus = null) {
  if (substantiveReviews(oracle).length && !oracle.violations.length) return "POLICY_REVIEW";
  if (expectedStatus === "EXPECTED_TBC_MODEL_DIVERGENCE" && !oracle.valid && production.valid) {
    return "EXPECTED_TBC_MODEL_DIVERGENCE";
  }
  if (!oracle.valid && production.valid) return "CONFIRMED_DEFECT";
  if (!oracle.valid && !production.valid) return "AGREEMENT";
  return "FEATURE_GATED";
}

function diagnostic(entry, evaluation) {
  return JSON.stringify({
    id: entry.id,
    mutationId: entry.mutationId,
    productionValid: evaluation.production.valid,
    productionErrors: evaluation.production.errors,
    productionBlocks: evaluation.production.policyDecision?.decisions
      ?.filter(decision => decision.status === "BLOCK")
      .map(decision => ({ reasonCode: decision.reasonCode, subject: decision.subject, path: decision.objectPath })) || [],
    oracleValid: evaluation.oracle.valid,
    oracleStatus: evaluation.oracle.status,
    oracleViolations: evaluation.oracle.violations.map(item => ({
      code: item.code,
      ruleId: item.ruleId,
      path: item.objectPath
    })),
    oracleReviews: substantiveReviews(evaluation.oracle).map(item => item.code)
  });
}

test("Task 10 registry is complete, stable, and contains no hidden mutation skips", () => {
  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.registryVersion, 3);
  assert.equal(registry.policyVersion, oraclePolicy.policy.version);
  assert.equal(registry.authorship, "handwritten-curated-mutations");
  assert.equal(registry.reviewedOn, "2026-08-06");
  assert.ok(registry.reviewer);
  assert.equal(registry.mutations.length, 24);

  const ids = registry.mutations.map(item => item.id);
  const mutationIds = registry.mutations.map(item => item.mutationId);
  assert.equal(new Set(ids).size, ids.length, "registry IDs must be unique");
  assert.equal(new Set(mutationIds).size, mutationIds.length, "each mutator must have one registry row");
  assert.deepEqual([...mutationIds].sort(), [...ECONOMICS_PLAN_MUTATION_IDS].sort());

  for (const entry of registry.mutations) {
    assert.ok(BASELINE_FACTORIES[entry.baselineId], `${entry.id}: unknown baseline`);
    assert.ok(entry.ruleId, `${entry.id}: missing ruleId`);
    assert.ok(registry.resultValues.includes(entry.expectedProductionResult), `${entry.id}: production result`);
    assert.ok(registry.resultValues.includes(entry.expectedOracleResult), `${entry.id}: oracle result`);
    assert.ok(registry.statusValues.includes(entry.status), `${entry.id}: status`);
    assert.ok(entry.followUp, `${entry.id}: missing follow-up`);
  }
});

test("every curated baseline is accepted before its one-defect mutation", () => {
  for (const [baselineId, factory] of Object.entries(BASELINE_FACTORIES)) {
    const baseline = factory();
    const evaluation = evaluateCase(baseline);
    assert.equal(
      evaluation.production.valid,
      true,
      `${baselineId}: production baseline failed: ${JSON.stringify({
        errors: evaluation.production.errors,
        blocks: evaluation.production.policyDecision?.decisions?.filter(decision => decision.status === "BLOCK")
          .map(decision => ({ reasonCode: decision.reasonCode, subject: decision.subject, path: decision.objectPath })) || []
      })}`
    );
    assert.equal(
      evaluation.oracle.valid,
      true,
      `${baselineId}: oracle baseline failed: ${JSON.stringify({
        violations: evaluation.oracle.violations,
        reviews: substantiveReviews(evaluation.oracle)
      })}`
    );
  }
});

test("production-validator disagreements exactly match the reviewed registry", () => {
  for (const entry of registry.mutations) {
    const baseline = BASELINE_FACTORIES[entry.baselineId]();
    const mutated = mutateEconomicsPlanCase(baseline, entry.mutationId);
    const evaluation = evaluateCase(mutated);
    const detail = diagnostic(entry, evaluation);

    const oracleFindings = [...evaluation.oracle.violations, ...substantiveReviews(evaluation.oracle)];
    assert.ok(oracleFindings.length > 0, `${entry.id}: oracle did not detect the mutation; ${detail}`);
    assert.ok(
      oracleFindings.some(item => item.ruleId === entry.ruleId || item.code === entry.ruleId),
      `${entry.id}: oracle did not report ${entry.ruleId}; ${detail}`
    );
    assert.equal(resultLabel(evaluation.oracle.valid), entry.expectedOracleResult, `${entry.id}: oracle drift; ${detail}`);

    const productionResult = resultLabel(evaluation.production.valid);
    if (entry.status === "CONFIRMED_DEFECT" && productionResult === "REJECT") {
      assert.fail(`${entry.id}: production now rejects this defect; promote the registry row to AGREEMENT. ${detail}`);
    }
    assert.equal(productionResult, entry.expectedProductionResult, `${entry.id}: production drift; ${detail}`);
    assert.equal(classifiedStatus(evaluation.production, evaluation.oracle, entry.status), entry.status, `${entry.id}: classification drift; ${detail}`);
  }
});

test("ECO 257 elective mutations are agreements only when both validators reject", () => {
  const eco257Rows = registry.mutations.filter(entry => (
    entry.mutationId === "ECO_257_ASSIGNED_TO_ELECTIVE"
    || entry.mutationId === "ECO_257_ELECTIVE_AFTER_OTHER_STATISTICS"
  ));
  assert.equal(eco257Rows.length, 2);
  for (const entry of eco257Rows) {
    const mutated = mutateEconomicsPlanCase(
      BASELINE_FACTORIES[entry.baselineId](),
      entry.mutationId
    );
    const evaluation = evaluateCase(mutated);
    const detail = diagnostic(entry, evaluation);
    assert.equal(entry.status, "AGREEMENT", detail);
    assert.equal(evaluation.production.valid, false, detail);
    assert.equal(evaluation.oracle.valid, false, detail);
    assert.ok(
      evaluation.oracle.violations.some(item => item.ruleId === "ELECTIVE-ECO-257-STATISTICS-ONLY"),
      detail
    );
  }
});
