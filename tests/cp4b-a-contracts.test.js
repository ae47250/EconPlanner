import test from "node:test";
import assert from "node:assert/strict";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import { resolveCatalogApplicability } from "../lib/catalog/applicability.js";
import { buildTbcTemporalWitness } from "../lib/decision-engine/tbc-temporal.js";
import { classifyPlanReadiness } from "../lib/decision-engine/readiness.js";
import { auditStudentHistory } from "../lib/decision-engine/student-history.js";
import { normalizeStudentFacts } from "../lib/decision-engine/student-facts.js";
import { loadPolicyBundle } from "../lib/policy/load-bundle.js";
import { independentlyEnumerateMaximalAllocations } from "./oracle/enumerate-requirement-allocations.js";

const bundle = await loadPolicyBundle({ allowPending: true });
const genericProgram = { id: "fixture", name: "Fixture", catalogYear: "2025-2026", sourceStatus: "APPROVED_LOCAL_SOURCE" };
const alternativeRequirements = {
  sourceStatus: "APPROVED_LOCAL_SOURCE",
  requirementSlots: [
    { id: "role-a", label: "Role A", kind: "choice", options: ["ECO 321", "ECO 322"], preferredOptions: ["ECO 321"], units: 1 },
    { id: "role-b", label: "Role B", kind: "choice", options: ["ECO 321", "ECO 322"], preferredOptions: ["ECO 322"], units: 1 }
  ]
};
const alternativeCourses = [
  { code: "ECO 321", status: "completed", source: "official_transcript" },
  { code: "ECO 322", status: "completed", source: "official_transcript" }
];

function allocationSignatures(result) {
  return result.strict.allocationAlternatives.map(alternative => alternative.assignments
    .map(item => `${item.slotId}=${item.code}`).sort().join("|"));
}

test("allocation alternatives retain every maximal hard-valid mapping and match the independent enumerator", () => {
  const result = mapStudentToProgram(genericProgram, alternativeRequirements, { courses: alternativeCourses });
  assert.deepEqual(allocationSignatures(result), independentlyEnumerateMaximalAllocations(alternativeRequirements.requirementSlots, alternativeCourses));
  assert.equal(result.strict.allocationAlternatives.length, 2);
  assert.equal(result.strict.assignments[0].code, "ECO 321");
  assert.ok(result.strict.allocationAlternatives.every(item => item.allocationId.startsWith("allocation-")));
});

test("allocation ordering and IDs are stable under input permutation", () => {
  const forward = mapStudentToProgram(genericProgram, alternativeRequirements, { courses: alternativeCourses });
  const reversed = mapStudentToProgram(genericProgram, {
    ...alternativeRequirements,
    requirementSlots: [...alternativeRequirements.requirementSlots].reverse()
  }, { courses: [...alternativeCourses].reverse() });
  assert.deepEqual(forward.strict.allocationAlternatives, reversed.strict.allocationAlternatives);
});

test("allocation pagination resumes without duplication and never implies infeasibility", () => {
  const first = mapStudentToProgram(genericProgram, alternativeRequirements, { courses: alternativeCourses }, { allocationPageLimit: 1 });
  assert.equal(first.strict.allocationSearch.complete, false);
  assert.equal(first.strict.allocationSearch.terminationReason, "ALTERNATIVE_LIMIT");
  const second = mapStudentToProgram(genericProgram, alternativeRequirements, { courses: alternativeCourses }, {
    allocationPageLimit: 1,
    allocationContinuationAfterSignature: first.strict.allocationSearch.continuationAfterSignature
  });
  assert.equal(second.strict.allocationSearch.complete, true);
  assert.equal(second.strict.allocationSearch.terminationReason, "EXHAUSTED");
  assert.notEqual(first.strict.allocationAlternatives[0].allocationId, second.strict.allocationAlternatives[0].allocationId);
});

test("ECO 257 remains Statistics-only in allocation alternatives", () => {
  const requirements = {
    sourceStatus: "APPROVED_LOCAL_SOURCE",
    requirementSlots: [
      { id: "statistics", label: "Statistics", kind: "choice", options: ["ECO 257"], units: 1 },
      { id: "eco-elective-1", label: "Elective", kind: "elective", subject: "ECO", units: 1 }
    ]
  };
  const result = mapStudentToProgram({ id: "economics", name: "Economics", catalogYear: "2025-2026" }, requirements, {
    courses: [{ code: "ECO 257", status: "completed", source: "official_transcript" }]
  }, { policyBundle: bundle });
  assert.ok(result.strict.allocationAlternatives.every(alternative => alternative.assignments
    .filter(item => item.code === "ECO 257").every(item => item.slotId === "statistics")));
});

function tbcPlan(courses, academicYear = "2027/2028") {
  return { terms: [{ termKey: "TBC", academicYear, courses }], unscheduled: [] };
}

function facts(courses = [], approvals = []) {
  return normalizeStudentFacts({ planCreationDate: "2026-08-05", courses, approvalInstances: approvals });
}

test("TBC placement windows and strict-prior witness are deterministic", () => {
  const courses = [
    { course: "ECO 213", requirementId: "eco-213", projectedTerm: "Fall", planningSequence: 1 },
    { course: "ECO 113", requirementId: "eco-113", projectedTerm: "Winter", planningSequence: 999 }
  ];
  const first = buildTbcTemporalWitness(tbcPlan(courses), facts([{ code: "MAT 113", status: "completed" }]), {}, bundle);
  const second = buildTbcTemporalWitness(tbcPlan([...courses].reverse().map(course => ({ ...course, projectedTerm: "May", planningSequence: -1 }))), facts([{ code: "MAT 113", status: "completed" }]), {}, bundle);
  assert.equal(first.status, "PRELIMINARY");
  assert.deepEqual(first.topologicalWitness, second.topologicalWitness);
  const edge = first.precedenceEdges.find(item => item.beforeCourseId === "ECO 113" && item.afterCourseId === "ECO 213");
  assert.equal(edge.relation, "STRICT_PRIOR");
  const witness = new Map(first.topologicalWitness.placements.map(item => [item.course, item.ordinal]));
  assert.ok(witness.get("ECO 113") < witness.get("ECO 213"));
  assert.ok(first.placements.every(item => item.placementWindow.allowedTermKeys.length > 0));
});

test("TBC concurrency requires and retains canonical approval authority", () => {
  const plan = tbcPlan([
    { course: "MAT 113", requirementId: "cognate" },
    {
      course: "ECO 213",
      requirementId: "eco-213",
      approvalRequired: [{
        ruleId: "CONCURRENT-MATH-ECO-213",
        course: "ECO 213",
        prerequisite: "MAT 113",
        type: "instructor",
        authority: "ECO 213 instructor",
        evidenceRef: "approval://fixture"
      }]
    }
  ]);
  const witness = buildTbcTemporalWitness(plan, facts([{ code: "ECO 113", status: "completed" }]), {}, bundle);
  const edge = witness.precedenceEdges.find(item => item.beforeCourseId === "MAT 113");
  assert.equal(edge.relation, "CONCURRENT_WITH_APPROVAL");
  assert.equal(edge.approvalRuleId, "CONCURRENT-MATH-ECO-213");
  assert.ok(edge.governingAuthority);
});

test("impossible TBC precedence blocks and exact schedules override TBC", () => {
  const plan = tbcPlan([
    { course: "ECO 213", requirementId: "eco-213" },
    { course: "ECO 461", requirementId: "eco-461" }
  ]);
  const context = { authoritativeSlots: [{ academicYear: "2027/2028", canonicalTerm: "FALL", reservedCourseUnits: 4 }] };
  const impossible = buildTbcTemporalWitness(plan, facts([{ code: "ECO 214", status: "completed" }, { code: "ECO 257", status: "completed" }]), context, bundle);
  assert.equal(impossible.status, "BLOCK");
  assert.equal(impossible.topologicalWitness.legal, false);
  const exact = buildTbcTemporalWitness(tbcPlan([{ course: "ECO 113", requirementId: "eco-113" }], "2026/2027"), facts(), {}, bundle);
  assert.equal(exact.status, "BLOCK");
  assert.equal(exact.decisions[0].reasonCode, "EXACT_SCHEDULE_OVERRIDES_TBC_WINDOW");
});

test("readiness preserves complete review-dependent plans without authority approval", () => {
  const studentReady = classifyPlanReadiness({ completionStatus: "COMPLETE", academicallyValid: true, decisions: [] });
  assert.equal(studentReady.readinessStatus, "STUDENT_READY");
  const conditional = classifyPlanReadiness({ completionStatus: "COMPLETE", academicallyValid: true, decisions: [{ status: "PRELIMINARY" }] });
  assert.equal(conditional.readinessStatus, "READY_WITH_CONDITIONS");
  const review = {
    status: "REVIEW_REQUIRED",
    decisionId: "decision-review",
    reasonCode: "EQUIVALENCY_REVIEW",
    ruleIds: ["REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE"],
    sourceRefs: ["source://fixture"],
    requiredEvidence: ["EQUIVALENCY_DECISION"],
    subject: { course: "ECO 321" },
    objectPath: "$.courses[0]"
  };
  const advisor = classifyPlanReadiness({ completionStatus: "COMPLETE", academicallyValid: true, decisions: [review, review] });
  assert.equal(advisor.readinessStatus, "ADVISOR_ACTION_REQUIRED");
  assert.equal(advisor.planDisposition, "COMPLETE_ADVISOR_ACTION_REQUIRED");
  assert.equal(advisor.advisorActions.length, 1);
  assert.ok(advisor.advisorActions[0].actionId);
});

test("explicit evidence facts stay scoped while broad fallback remains review-only", () => {
  const normalized = normalizeStudentFacts({
    courses: [{ code: "ECO 331", status: "completed" }],
    evidenceFacts: [
      { factType: "COMPLETED_COURSEWORK", affectedCourse: "ECO 331", source: "transcript://official", authority: "Registrar", evidenceStatus: "VERIFIED", effectiveScope: { purpose: "COURSE_COMPLETION" } },
      { factType: "PREREQUISITE_SATISFACTION", affectedCourse: "ECO 461", source: "advisor://memo", authority: "Economics Department", evidenceStatus: "VERIFIED", effectiveScope: { purpose: "PREREQUISITE_SATISFACTION_ONLY" } },
      { factType: "REQUIREMENT_CREDIT_EQUIVALENCY", affectedRequirement: "eco-elective-1", source: "advisor://memo", authority: "Economics Department", evidenceStatus: "VERIFIED", effectiveScope: { purpose: "REQUIREMENT_CREDIT_ONLY" } }
    ]
  });
  assert.equal(normalized.evidenceFacts.length, 3);
  assert.notDeepEqual(normalized.evidenceFacts[1].effectiveScope, normalized.evidenceFacts[2].effectiveScope);
  const fallback = auditStudentHistory({ courses: [{ code: "ECO 331", status: "transfer", source: "possible_equivalency" }] }, bundle);
  assert.ok(fallback.decisions.length > 0);
  assert.ok(fallback.decisions.every(decision => decision.status === "REVIEW_REQUIRED"));
});

test("catalog applicability always applies the owner-designated flexible set and preserves incoming metadata", () => {
  const ambiguous = resolveCatalogApplicability({ entryCatalogYear: "2025-2026", currentCatalogYear: "2026-2027", availableCatalogYears: ["2025-2026"] });
  assert.equal(ambiguous.status, "OWNER_DESIGNATED_REQUIREMENTS_MATCH_INCOMING_CATALOG");
  assert.equal(ambiguous.governingMajorCatalogYear, "2025-2026");
  assert.deepEqual(ambiguous.candidateCatalogYears, ["2025-2026"]);
  assert.equal(ambiguous.advisorAction, null);
  assert.equal(ambiguous.advisorNotice, null);
  const exact = resolveCatalogApplicability({ majorDeclarationCatalogYear: "2025-2026", entryCatalogYear: "2024-2025", availableCatalogYears: ["2025-2026"] });
  assert.equal(exact.status, "OWNER_DESIGNATED_REQUIREMENTS_SAC_PETITION_NOTICE");
  assert.equal(exact.governingMajorCatalogYear, "2025-2026");
  assert.equal(exact.incomingCatalogYear, "2024-2025");
  assert.equal(exact.advisorNotice.reasonCode, "FLEXIBLE_MAJOR_REQUIREMENTS_SAC_PETITION_NOTICE");
  const unavailable = resolveCatalogApplicability({ majorDeclarationCatalogYear: "2026-2027", availableCatalogYears: ["2025-2026"] });
  assert.equal(unavailable.status, "OWNER_DESIGNATED_REQUIREMENTS_INCOMING_YEAR_UNKNOWN");
  assert.equal(unavailable.requestedUnavailableCatalogYear, "2026-2027");
  assert.equal(unavailable.appliedMajorCatalogYear, "2025-2026");
  assert.equal(unavailable.advisorNotice.reasonCode, "FLEXIBLE_MAJOR_REQUIREMENTS_INCOMING_YEAR_UNKNOWN");
});
