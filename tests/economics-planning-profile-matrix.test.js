import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import { buildEconomicsTermPlans, semanticPlanSignature } from "../lib/planning/economics.js";
import { auditExternalEconomicsPlanComplete } from "./oracle/audit-external-plan.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/economics-planning-profile-matrix.json", import.meta.url), "utf8"));
const schedule = JSON.parse(await readFile(new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url), "utf8"));
const prerequisites = JSON.parse(await readFile(new URL("../data/normalized/economics/prerequisites.json", import.meta.url), "utf8"));
const requirements = JSON.parse(await readFile(new URL("../data/normalized/economics/requirements.json", import.meta.url), "utf8"));
const oraclePolicy = JSON.parse(await readFile(new URL("./oracle/economics-policy.v1.json", import.meta.url), "utf8"));
const oracleSchedule = JSON.parse(await readFile(new URL("./oracle/verified-schedule-2026-2027.json", import.meta.url), "utf8"));

const APPROVAL_TYPES = Object.freeze({
  "CONCURRENT-INTERMEDIATE-ECO-461": "DEPARTMENT_APPROVAL",
  "CONCURRENT-MATH-ECO-213": "INSTRUCTOR_APPROVAL",
  "CONCURRENT-MATH-ECO-214": "INSTRUCTOR_APPROVAL"
});
const CLASSIFIED_CONFIRMED_DEFECT_CODES = new Set([
  "ELECTIVE-NO-DOUBLE-COUNT",
  "REQ-MAJOR-COURSE-COUNT",
  "SCHEDULE_PROJECTED_SOURCE_IN_VERIFIED_YEAR",
  "SCHEDULE_FUTURE_SOURCE_NOT_EXPLICIT"
]);
const CLASSIFIED_POLICY_REVIEW_CODES = new Set([
  "REVIEW-ADVANCED-COURSE-PREREQUISITE-CLOSURE"
]);

function generate(standing, profile) {
  const student = {
    academicStanding: standing,
    planCreationDate: fixture.planCreationDate,
    courses: profile.courses.map(code => ({ code, status: "completed" }))
  };
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

      const limit = standing === "junior" ? 2 : 4;
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
  assert.ok(outcomes.find(item => item.id === "FW5").result.plans.some(plan => plan.id === "plan-c2"));
  assert.ok(outcomes.find(item => item.id === "SW5").result.plans.some(plan => plan.id === "plan-c2"));

  const juniorP3 = outcomes.find(item => item.id === "JP3");
  const juniorP3Early = juniorP3.result.candidateOutcomes.find(item => item.id === "plan-c2");
  assert.equal(juniorP3Early.status, "PRELIMINARY_ONLY");
  assert.equal(juniorP3Early.displayed, true);
  assert.equal(juniorP3Early.suppressionReason, null);

  const freshmanP8 = outcomes.find(item => item.id === "FP8");
  const freshmanP8PlanB = freshmanP8.result.candidateOutcomes.find(item => item.id === "plan-2");
  assert.equal(freshmanP8PlanB.displayed, true);
  assert.equal(freshmanP8PlanB.substitutionReason, "NEXT_DISTINCT_RESERVE");
  assert.equal(freshmanP8PlanB.selectedCandidateRank, 2);
  assert.ok(freshmanP8PlanB.candidatePool.retainedDistinctSchedules > 1);
});
