import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import { buildEconomicsTermPlans } from "../lib/planning/economics.js";
import { auditExternalEconomicsPlanComplete } from "./oracle/audit-external-plan.js";
import { externalTermPosition } from "./oracle/plan-signature.js";

const profilesFixture = JSON.parse(await readFile(
  new URL("./fixtures/economics-student-profiles.v1.json", import.meta.url),
  "utf8"
));
const productionSchedule = JSON.parse(await readFile(
  new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url),
  "utf8"
));
const productionPrerequisites = JSON.parse(await readFile(
  new URL("../data/normalized/economics/prerequisites.json", import.meta.url),
  "utf8"
));
const productionRequirements = JSON.parse(await readFile(
  new URL("../data/normalized/economics/requirements.json", import.meta.url),
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

const ECONOMICS_PROGRAM = Object.freeze({ id: "economics", name: "Economics" });
const APPROVAL_RULES = Object.freeze({
  CONCURRENT_INTERMEDIATE_DEPARTMENT_APPROVAL: "CONCURRENT-INTERMEDIATE-ECO-461",
  CONCURRENT_MATH_INSTRUCTOR_APPROVAL: null
});
const APPROVAL_TYPES = Object.freeze({
  "CONCURRENT-INTERMEDIATE-ECO-461": "DEPARTMENT_APPROVAL",
  "CONCURRENT-MATH-ECO-213": "INSTRUCTOR_APPROVAL",
  "CONCURRENT-MATH-ECO-214": "INSTRUCTOR_APPROVAL"
});
const CLASSIFIED_CONFIRMED_DEFECT_CODES = new Set([
  "SCHEDULE_FUTURE_SOURCE_NOT_EXPLICIT"
]);
const CLASSIFIED_POLICY_REVIEW_CODES = new Set([
  "REVIEW-ADVANCED-COURSE-PREREQUISITE-CLOSURE",
  "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE",
  "SCHEDULE_SECTION_FULL_REVIEW"
]);

function canonicalCourse(code) {
  const value = String(code || "").trim().toUpperCase();
  return value === "PHI 234" ? "ECO 234" : value;
}

function combinedExpectations(profile) {
  return {
    ...profilesFixture.defaultExpectations,
    ...profile.expectations,
    requiredPrerequisiteOrder: [
      ...profilesFixture.defaultExpectations.requiredPrerequisiteOrder,
      ...(profile.expectations.requiredPrerequisiteOrder || [])
    ],
    forbiddenSameTermPlacements: [
      ...profilesFixture.defaultExpectations.forbiddenSameTermPlacements,
      ...(profile.expectations.forbiddenSameTermPlacements || [])
    ],
    requiredApprovals: profile.expectations.requiredApprovals
      || profilesFixture.defaultExpectations.requiredApprovals,
    expectedWarningsContaining: profile.expectations.expectedWarningsContaining
      || profilesFixture.defaultExpectations.expectedWarningsContaining
  };
}

function studentFor(profile) {
  return {
    ...profile.student,
    planCreationDate: profile.planCreationDate || profilesFixture.planCreationDate,
    courses: (profile.student.courses || []).map(course => ({ ...course }))
  };
}

function generateProfile(profile) {
  const student = studentFor(profile);
  const mapping = mapStudentToProgram(ECONOMICS_PROGRAM, productionRequirements, student);
  const result = buildEconomicsTermPlans({
    student,
    mapping,
    schedule: productionSchedule,
    prerequisites: productionPrerequisites
  });
  return { profile, student, mapping, result };
}

function manifestRule(ruleId) {
  return [
    ...(oraclePolicy.concurrencyRules || []),
    ...(oraclePolicy.permissionRules || [])
  ].find(rule => rule.ruleId === ruleId);
}

function approvalRuleId(approval) {
  if (APPROVAL_RULES[approval.code]) {
    return APPROVAL_RULES[approval.code];
  }
  if (approval.code === "CONCURRENT_MATH_INSTRUCTOR_APPROVAL") {
    return approval.course === "ECO 213"
      ? "CONCURRENT-MATH-ECO-213"
      : "CONCURRENT-MATH-ECO-214";
  }
  return approval.ruleId || null;
}

function oracleApproval(approval) {
  const ruleId = approvalRuleId(approval);
  const rule = manifestRule(ruleId);
  return {
    ruleId,
    type: APPROVAL_TYPES[ruleId],
    authority: approval.authority,
    course: approval.course,
    prerequisite: approval.prerequisite ?? null,
    term: approval.term,
    reason: approval.reason,
    sourceRef: rule?.sourceRefs?.[0] || null
  };
}

function currentTermCondition(plan, course, term) {
  return (plan.feasibility?.enrollmentConditions || []).some(condition => (
    condition.type === "stale_availability"
    && condition.course === course.course
    && condition.term === term.term
  ));
}

function oracleCourse(course, term, plan) {
  const value = {
    ...course,
    canonicalCrossListIdentity: [course.course, ...(course.crossListedAs || [])],
    availability: {
      ...course.availability,
      ...(currentTermCondition(plan, course, term) ? { freshness: "stale" } : {})
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
  if (!value.institution) delete value.institution;
  return value;
}

function transferRequirementRule(code) {
  const canonical = canonicalCourse(code);
  if (["ECO 257", "MAT 217", "PSY 217"].includes(canonical)) return "REQ-STATISTICS";
  if (["MAT 113", "MAT 121"].includes(canonical)) return "REQ-COGNATE";
  if (["ECO 321", "BUSN 323"].includes(canonical)) return "REQ-FINANCE";
  if (["ECO 113", "ECO 114", "ECO 213", "ECO 214", "ECO 461"].includes(canonical)) {
    return `REQ-${canonical.replace(" ", "-")}`;
  }
  return canonical.startsWith("ECO ") ? "REQ-ECO-ELECTIVES" : null;
}

function externalStudent(student) {
  const completedBeforeHorizon = student.courses.filter(course => (
    course.status === "completed" || course.status === "in_progress"
  ));
  return {
    academicStanding: student.academicStanding,
    completedCourses: completedBeforeHorizon.map(course => ({
      course: course.code,
      ...(course.status === "in_progress" ? { projectedCompletion: true } : {})
    })),
    inProgressCourses: student.courses
      .filter(course => course.status === "in_progress")
      .map(course => ({
        course: course.code,
        academicYear: course.academicYear,
        termKey: course.termKey
      }))
  };
}

function transferClaims(student) {
  return student.courses
    .filter(course => ["transfer", "uncertain"].includes(course.status))
    .map(course => ({
      kind: "equivalency",
      targetRuleId: transferRequirementRule(course.code),
      reviewRuleId: "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE",
      course: course.code
    }));
}

export function externalOracleInputForDisplayedPlan(student, plan) {
  return {
    student: externalStudent(student),
    expectedContext: plan.planningContext,
    plan: {
      id: plan.id,
      terms: plan.terms.map(term => ({
        ...term,
        courses: term.courses.map(course => oracleCourse(course, term, plan))
      })),
      requirementClaims: transferClaims(student)
    },
    policy: oraclePolicy,
    verifiedSchedule: oracleSchedule
  };
}

function substantiveReviews(audit) {
  return audit.reviewItems.filter(item => item.code !== "RULE_FAMILY_NOT_CHECKED");
}

function auditFindingClasses(audit) {
  const classes = new Set();
  if (audit.violations.length) classes.add("CONFIRMED_DEFECT");
  if (substantiveReviews(audit).length) classes.add("POLICY_REVIEW");
  if (!audit.violations.length && !substantiveReviews(audit).length) classes.add("CURRENT_CONTRACT");
  return classes;
}

function featureGateApplies(profile, result) {
  if (profile.student.isTransferStudent) {
    return !result.candidateOutcomes.some(outcome => outcome.id === "plan-c2");
  }
  if (["junior", "senior"].includes(profile.student.academicStanding)) {
    return !result.candidateOutcomes.some(outcome => outcome.id === "plan-3");
  }
  return false;
}

function diagnostic(profileId, plan, audit) {
  return JSON.stringify({
    profileId,
    planId: plan.id,
    label: plan.label,
    productionStatus: plan.feasibilityStatus,
    oracleStatus: audit.status,
    violations: audit.violations.map(item => ({ code: item.code, path: item.objectPath })),
    reviews: substantiveReviews(audit).map(item => item.code),
    unchecked: audit.uncheckedRuleFamilies.map(item => item.family)
  });
}

function placementMap(student, plan) {
  const placements = new Map();
  student.courses
    .filter(course => ["completed", "in_progress", "transfer", "uncertain"].includes(course.status))
    .forEach(course => placements.set(canonicalCourse(course.code), Number.NEGATIVE_INFINITY));
  plan.terms.forEach(term => {
    const termPosition = externalTermPosition(term.academicYear, term.termKey)
      ?? Number(String(term.academicYear).slice(0, 4)) * 4;
    term.courses.forEach(course => {
      const position = termPosition * 1000 + Number(course.planningSequence || 0);
      placements.set(canonicalCourse(course.course), position);
      if (course.source === "requirement-placeholder") {
        for (const option of course.options || []) placements.set(canonicalCourse(option), position);
      }
    });
  });
  return placements;
}

function planCourseCodes(plan) {
  return plan.terms.flatMap(term => term.courses.flatMap(course => [
    canonicalCourse(course.course),
    ...(course.source === "requirement-placeholder"
      ? (course.options || []).map(canonicalCourse)
      : [])
  ]));
}

function assertPlanConstraints(evaluation, plan, expectations) {
  const { profile, student } = evaluation;
  const prefix = `${profile.id}/${plan.id}`;
  assert.ok(
    expectations.allowedFeasibilityStatuses.includes(plan.feasibilityStatus),
    `${prefix}: unexpected feasibility ${plan.feasibilityStatus}`
  );
  if (expectations.requiredRequirementCoverage) {
    assert.equal(plan.validation?.requirementAllocation?.valid, true, `${prefix}: requirement allocation invalid`);
    assert.equal(plan.validation?.requirementAllocation?.assignments?.length, 12, `${prefix}: incomplete requirement coverage`);
  }

  const planned = new Set(planCourseCodes(plan));
  const nonrepeatable = student.courses
    .filter(course => ["completed", "in_progress"].includes(course.status))
    .map(course => canonicalCourse(course.code));
  for (const course of nonrepeatable) {
    assert.equal(planned.has(course), false, `${prefix}: repeats ${course}`);
  }
  for (const course of expectations.forbiddenPlannedCourses || []) {
    assert.equal(planned.has(canonicalCourse(course)), false, `${prefix}: planned forbidden ${course}`);
  }

  const placements = placementMap(student, plan);
  for (const rule of expectations.requiredPrerequisiteOrder) {
    const dependent = placements.get(canonicalCourse(rule.after));
    if (dependent === undefined || dependent === Number.NEGATIVE_INFINITY) continue;
    const prerequisites = rule.beforeOneOf || [rule.before];
    assert.ok(
      prerequisites.some(course => placements.get(canonicalCourse(course)) < dependent),
      `${prefix}: prerequisite order failed for ${prerequisites.join("/")} before ${rule.after}`
    );
  }
  for (const [left, right] of expectations.forbiddenSameTermPlacements) {
    for (const term of plan.terms) {
      const matching = term.courses.filter(course => [left, right].map(canonicalCourse).includes(canonicalCourse(course.course)));
      if (matching.length < 2) continue;
      const sameProjectedTerm = term.termKey !== "TBC"
        || (matching[0].projectedTerm && matching[0].projectedTerm === matching[1].projectedTerm);
      assert.equal(sameProjectedTerm, false, `${prefix}: forbidden same-term placement ${left} + ${right} in ${term.term}`);
    }
  }
}

function assertProfileConstraints(evaluation) {
  const { profile, result } = evaluation;
  const expectations = combinedExpectations(profile);
  const count = expectations.displayedPlanCount;
  assert.ok(result.plans.length >= count.min && result.plans.length <= count.max,
    `${profile.id}: displayed ${result.plans.length}; expected ${count.min}-${count.max}`);

  const displayedIds = new Set(result.plans.map(plan => plan.id));
  for (const strategyId of expectations.requiredDisplayedStrategies || []) {
    assert.ok(displayedIds.has(strategyId), `${profile.id}: missing displayed ${strategyId}`);
  }
  for (const strategyId of expectations.forbiddenDisplayedStrategies || []) {
    assert.equal(displayedIds.has(strategyId), false, `${profile.id}: unexpectedly displayed ${strategyId}`);
  }
  for (const [strategyId, statuses] of Object.entries(expectations.candidateStrategyStatuses || {})) {
    const candidate = result.candidateOutcomes.find(outcome => outcome.id === strategyId);
    assert.ok(candidate, `${profile.id}: missing candidate outcome ${strategyId}`);
    assert.ok(statuses.includes(candidate.status), `${profile.id}/${strategyId}: ${candidate.status}`);
  }
  if (expectations.expectedRemainingYears !== undefined && result.plans.length) {
    assert.ok(result.plans.every(plan => (
      plan.planningContext.remainingYears === expectations.expectedRemainingYears
    )), `${profile.id}: transfer horizon changed`);
  }

  for (const assertion of expectations.strategyAssertions || []) {
    const plan = result.plans.find(candidate => candidate.id === assertion.strategyId);
    assert.ok(plan, `${profile.id}: missing strategy assertion target ${assertion.strategyId}`);
    const courses = new Set(planCourseCodes(plan));
    for (const course of assertion.mustContain || []) {
      assert.ok(courses.has(canonicalCourse(course)), `${profile.id}/${plan.id}: missing ${course}`);
    }
    if (assertion.mustContainOneOf) {
      assert.ok(assertion.mustContainOneOf.some(course => courses.has(canonicalCourse(course))),
        `${profile.id}/${plan.id}: missing one of ${assertion.mustContainOneOf.join(", ")}`);
    }
  }

  const approvals = result.plans.flatMap(plan => plan.feasibility?.requiredApprovals || []);
  for (const ruleId of expectations.requiredApprovals) {
    assert.ok(approvals.some(approval => approvalRuleId(approval) === ruleId),
      `${profile.id}: missing required approval ${ruleId}`);
  }
  for (const [left, right] of expectations.requiredSameTermPlacements || []) {
    assert.ok(result.plans.some(plan => plan.terms.some(term => {
      const courses = new Set(term.courses.map(course => canonicalCourse(course.course)));
      return courses.has(canonicalCourse(left)) && courses.has(canonicalCourse(right));
    })), `${profile.id}: missing required same-term placement ${left} + ${right}`);
  }
  const warnings = result.plans.flatMap(plan => plan.warnings || []);
  for (const expected of expectations.expectedWarningsContaining) {
    assert.ok(warnings.some(warning => warning.includes(expected)), `${profile.id}: missing warning ${expected}`);
  }

  result.plans.forEach(plan => assertPlanConstraints(evaluation, plan, expectations));
}

test("core fixture contains the required fictional profile coverage", () => {
  assert.equal(profilesFixture.authorship, "handwritten-fictional");
  assert.equal(profilesFixture.profiles.length, 15);
  const groupCounts = profilesFixture.profiles.reduce((counts, profile) => ({
    ...counts,
    [profile.group]: (counts[profile.group] || 0) + 1
  }), {});
  assert.deepEqual(groupCounts, {
    freshman: 3,
    sophomore: 3,
    junior: 3,
    senior: 3,
    transfer: 3
  });
  const coverage = new Set(profilesFixture.profiles.flatMap(profile => profile.coverage));
  for (const required of [
    "no_completed_courses",
    "one_principle_completed",
    "one_principle_in_progress",
    "mathematics_completed",
    "mathematics_missing",
    "statistics_completed",
    "one_intermediate_completed",
    "both_intermediates_completed",
    "normal_graduation",
    "one_year_early_request",
    "impossible_one_year_early_request",
    "senior_strict_capstone_path",
    "one_intermediate_concurrent_with_eco461",
    "both_intermediates_missing",
    "provisional_transfer_equivalency",
    "one_year_transfer_horizon",
    "three_year_transfer_horizon",
    "five_year_transfer_horizon"
  ]) assert.ok(coverage.has(required), `missing fixture coverage: ${required}`);
});

test("every displayed core-profile plan is independently audited and every disagreement is classified", () => {
  const allowedClasses = new Set(profilesFixture.findingClasses);
  for (const profile of profilesFixture.profiles) {
    const evaluation = generateProfile(profile);
    assertProfileConstraints(evaluation);
    const classes = new Set();
    const audits = evaluation.result.plans.map(plan => {
      const audit = auditExternalEconomicsPlanComplete(
        externalOracleInputForDisplayedPlan(evaluation.student, plan)
      );
      const substantive = substantiveReviews(audit);
      const fullOnlyReview = !audit.violations.length
        && substantive.length > 0
        && substantive.every(item => item.code === "SCHEDULE_SECTION_FULL_REVIEW");
      if (fullOnlyReview) classes.add("CURRENT_CONTRACT");
      else for (const findingClass of auditFindingClasses(audit)) classes.add(findingClass);
      return { plan, audit };
    });
    if (!evaluation.result.plans.length) classes.add("CURRENT_CONTRACT");
    if (featureGateApplies(profile, evaluation.result)) classes.add("FEATURE_GATED");

    for (const { plan, audit } of audits) {
      assert.ok(
        audit.valid || audit.violations.length || substantiveReviews(audit).length,
        `${profile.id}/${plan.id}: oracle produced no conclusive outcome; ${diagnostic(profile.id, plan, audit)}`
      );
      for (const finding of [...audit.violations, ...substantiveReviews(audit)]) {
        assert.ok(finding.code, `${diagnostic(profile.id, plan, audit)}: finding lacks code`);
        assert.ok(finding.sourceReference, `${diagnostic(profile.id, plan, audit)}: finding lacks source`);
      }
      for (const finding of audit.violations) {
        assert.ok(CLASSIFIED_CONFIRMED_DEFECT_CODES.has(finding.code),
          `${diagnostic(profile.id, plan, audit)}: unclassified confirmed defect ${finding.code}`);
      }
      for (const finding of substantiveReviews(audit)) {
        assert.ok(CLASSIFIED_POLICY_REVIEW_CODES.has(finding.code),
          `${diagnostic(profile.id, plan, audit)}: unclassified policy review ${finding.code}`);
      }
    }

    const expectedClasses = new Set(profile.expectations.expectedFindingClasses);
    assert.deepEqual(
      [...classes].sort(),
      [...expectedClasses].sort(),
      `${profile.id}: unexpected classifications; ${audits.map(({ plan, audit }) => diagnostic(profile.id, plan, audit)).join("\n")}`
    );
    for (const findingClass of classes) assert.ok(allowedClasses.has(findingClass), profile.id);
    for (const code of profile.expectations.requiredPolicyReviewCodes || []) {
      assert.ok(audits.some(({ audit }) => substantiveReviews(audit).some(item => item.code === code)),
        `${profile.id}: missing policy review ${code}`);
    }
  }
});
