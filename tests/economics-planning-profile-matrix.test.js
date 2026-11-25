import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import { buildEconomicsTermPlans, semanticPlanSignature } from "../lib/planning/economics.js";
import { resolvePlanningContext } from "../lib/planning/horizon.js";
import { auditExternalEconomicsPlanComplete } from "./oracle/audit-external-plan.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/economics-planning-profile-matrix.json", import.meta.url), "utf8"));
const schedule = JSON.parse(await readFile(new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url), "utf8"));
const prerequisites = JSON.parse(await readFile(new URL("../data/normalized/economics/prerequisites.json", import.meta.url), "utf8"));
const requirements = JSON.parse(await readFile(new URL("../data/normalized/economics/requirements.json", import.meta.url), "utf8"));
const oraclePolicy = JSON.parse(await readFile(new URL("./oracle/economics-policy.v1.json", import.meta.url), "utf8"));
const oracleSchedule = JSON.parse(await readFile(new URL("./oracle/verified-schedule-2026-2027.json", import.meta.url), "utf8"));

const APPROVAL_TYPES = Object.freeze({
  "CONCURRENT-INTERMEDIATE-ECO-461": "INSTRUCTOR_APPROVAL",
  "CONCURRENT-MATH-ECO-213": "INSTRUCTOR_APPROVAL",
  "CONCURRENT-MATH-ECO-214": "INSTRUCTOR_APPROVAL"
});
const CLASSIFIED_CONFIRMED_DEFECT_CODES = new Set([
  "SCHEDULE_FUTURE_SOURCE_NOT_EXPLICIT"
]);
const CLASSIFIED_POLICY_REVIEW_CODES = new Set([
  "REVIEW-ADVANCED-COURSE-PREREQUISITE-CLOSURE",
  "SCHEDULE_SECTION_FULL_REVIEW"
]);

function generate(standing, profile, { early = false } = {}) {
  let student = {
    academicStanding: standing,
    planCreationDate: fixture.planCreationDate,
    courses: profile.courses.map(code => ({ code, status: "completed" }))
  };
  if (early) {
    const earlyGraduationYear = resolvePlanningContext(student).expectedGraduationYear - 1;
    student = {
      ...student,
      planningPace: "one_year_early",
      projectedSeniorStandingConfirmation: {
        status: "STUDENT_REPORTED_REGISTRAR_OR_ADVISOR_CONFIRMATION",
        academicYear: `${earlyGraduationYear - 1}/${earlyGraduationYear}`
      }
    };
  }
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  return {
    student,
    mapping,
    result: buildEconomicsTermPlans({ student, mapping, schedule, prerequisites })
  };
}

function approvalRuleId(approval) {
  if (approval.code === "CONCURRENT_INTERMEDIATE_DEPARTMENT_APPROVAL") {
    return "CONCURRENT-INTERMEDIATE-ECO-461";
  }
  if (approval.code === "CONCURRENT_MATH_INSTRUCTOR_APPROVAL") {
    return approval.course === "ECO 213"
      ? "CONCURRENT-MATH-ECO-213"
      : "CONCURRENT-MATH-ECO-214";
  }
  return approval.ruleId || null;
}

function approvalRule(ruleId) {
  return [...oraclePolicy.concurrencyRules, ...oraclePolicy.permissionRules]
    .find(rule => rule.ruleId === ruleId);
}

function oracleApproval(approval) {
  const ruleId = approvalRuleId(approval);
  return {
    ruleId,
    type: APPROVAL_TYPES[ruleId],
    authority: approval.authority,
    course: approval.course,
    prerequisite: approval.prerequisite ?? null,
    term: approval.term,
    reason: approval.reason,
    sourceRef: approvalRule(ruleId)?.sourceRefs?.[0] || null
  };
}

function oracleCourse(course, term, plan) {
  const stale = (plan.feasibility?.enrollmentConditions || []).some(condition => (
    condition.type === "stale_availability"
    && condition.course === course.course
    && condition.term === term.term
  ));
  const value = {
    ...course,
    canonicalCrossListIdentity: [course.course, ...(course.crossListedAs || [])],
    availability: { ...course.availability, ...(stale ? { freshness: "stale" } : {}) },
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
  if (!value.institution) delete value.institution;
  return value;
}

function auditDisplayedPlan(student, plan) {
  return auditExternalEconomicsPlanComplete({
    student: {
      academicStanding: student.academicStanding,
      completedCourses: student.courses.map(course => ({ course: course.code })),
      inProgressCourses: []
    },
    expectedContext: plan.planningContext,
    plan: {
      id: plan.id,
      terms: plan.terms.map(term => ({
        ...term,
        courses: term.courses.map(course => oracleCourse(course, term, plan))
      }))
    },
    policy: oraclePolicy,
    verifiedSchedule: oracleSchedule
  });
}

function oracleClassification(audit) {
  const reviews = audit.reviewItems.filter(item => item.code !== "RULE_FAMILY_NOT_CHECKED");
  if (audit.violations.length) return "CONFIRMED_DEFECT";
  if (reviews.length) return "POLICY_REVIEW";
  return "CURRENT_CONTRACT";
}

function auditDiagnostic(id, plan, audit) {
  return JSON.stringify({
    profileId: id,
    planId: plan.id,
    productionStatus: plan.feasibilityStatus,
    oracleStatus: audit.status,
    classification: oracleClassification(audit),
    violations: audit.violations.map(item => ({ code: item.code, path: item.objectPath })),
    reviews: audit.reviewItems
      .filter(item => item.code !== "RULE_FAMILY_NOT_CHECKED")
      .map(item => item.code),
    unchecked: audit.uncheckedRuleFamilies.map(item => item.family)
  });
}

test("the 51-profile audit matrix returns only complete, distinct, bounded-search plans", () => {
  const outcomes = [];
  for (const standing of fixture.standings) {
    for (const profile of fixture.profiles) {
      const { student, mapping, result } = generate(standing, profile);
      const id = `${standing[0].toUpperCase()}${profile.id}`;
      const planAudits = result.plans.map(plan => ({
        plan,
        audit: auditDisplayedPlan(student, plan)
      }));
      const diagnostics = planAudits.map(({ plan, audit }) => auditDiagnostic(id, plan, audit)).join("\n");
      outcomes.push({ id, standing, profile, mapping, result, planAudits });

      const limit = standing === "junior" ? 2 : 3;
      assert.ok(result.plans.length <= limit, `${id} exceeds the standing-specific display limit\n${diagnostics}`);
      assert.equal(new Set(result.plans.map(semanticPlanSignature)).size, result.plans.length, `${id} has a semantic duplicate\n${diagnostics}`);
      assert.ok(result.plans.every(plan => plan.validation.valid), `${id} displayed an invalid production plan\n${diagnostics}`);
      assert.ok(result.plans.every(plan => plan.feasibility.search.nodesVisited <= 250000), `${id} exceeded the deterministic search limit\n${diagnostics}`);
      assert.ok(result.candidateOutcomes.filter(item => !item.displayed).every(item => item.suppressionReason), `${id} omitted a suppression reason\n${diagnostics}`);
      assert.equal(planAudits.length, result.plans.length, `${id} did not audit every displayed plan`);
      assert.ok(planAudits.every(({ audit }) => (
        audit.valid
        || audit.violations.length > 0
        || audit.reviewItems.some(item => item.code !== "RULE_FAMILY_NOT_CHECKED")
      )), `${id} produced an unclassified independent-oracle result\n${diagnostics}`);
      assert.ok(planAudits.every(({ audit }) => (
        [...audit.violations, ...audit.reviewItems.filter(item => item.code !== "RULE_FAMILY_NOT_CHECKED")]
          .every(item => item.code && item.sourceReference)
      )), `${id} produced an unsourced independent-oracle finding\n${diagnostics}`);
      assert.ok(planAudits.every(({ audit }) => audit.violations.every(
        item => CLASSIFIED_CONFIRMED_DEFECT_CODES.has(item.code)
      )), `${id} produced a new unclassified confirmed defect\n${diagnostics}`);
      assert.ok(planAudits.every(({ audit }) => audit.reviewItems
        .filter(item => item.code !== "RULE_FAMILY_NOT_CHECKED")
        .every(item => CLASSIFIED_POLICY_REVIEW_CODES.has(item.code))),
      `${id} produced a new unclassified policy review\n${diagnostics}`);
    }
  }

  assert.equal(outcomes.length, 51);
  assert.ok(outcomes.every(item => item.result.candidateOutcomes.every(outcome => outcome.id !== "one-year-early")));

  const juniorP3 = generate("junior", fixture.profiles.find(profile => profile.id === "P3"), { early: true });
  assert.equal(juniorP3.result.context.planningPace, "standard");
  assert.equal(juniorP3.result.context.earlyComparisonRequested, true);
  assert.equal(juniorP3.result.context.planningPaceNormalization, null);
  assert.ok(juniorP3.result.candidateOutcomes.some(item => item.id === "one-year-early"));

  for (const [standing, profileId] of [["freshman", "W5"], ["sophomore", "W5"]]) {
    const early = generate(standing, fixture.profiles.find(profile => profile.id === profileId), { early: true });
    assert.ok(early.result.candidateOutcomes.some(outcome => outcome.id === "one-year-early"));
    assert.ok(early.result.candidateOutcomes.some(outcome => outcome.id === "balanced"));
    assert.equal(early.result.context.planningPace, "standard");
  }

  const freshmanP8 = outcomes.find(item => item.id === "FP8");
  const freshmanP8Explore = freshmanP8.result.candidateOutcomes.find(item => item.id === "explore-first");
  assert.equal(freshmanP8Explore.displayed, true);
  assert.ok(freshmanP8Explore.candidatePool.retainedDistinctSchedules > 0);
  assert.ok([1, 2].includes(freshmanP8Explore.selectedCandidateRank));
});
