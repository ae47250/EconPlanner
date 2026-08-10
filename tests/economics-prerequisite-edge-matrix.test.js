import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  evaluatePlanPrerequisites,
  evaluateStudentPrerequisites
} from "../lib/planning/prerequisiteEvaluator.js";
import {
  evaluatePlan as evaluateProductionPlan,
  evaluatePrerequisites as evaluateProductionPrerequisites,
  normalizeStudentFacts
} from "../lib/decision-engine/index.js";
import { loadEconomicsPolicyCompatibility } from "../lib/policy/compat-normalized.js";
import { checkExternalEconomicsPrerequisites } from "./oracle/check-prerequisites.js";

const policy = JSON.parse(await readFile(
  new URL("./oracle/economics-policy.v1.json", import.meta.url),
  "utf8"
));
const fixture = JSON.parse(await readFile(
  new URL("./fixtures/economics-prerequisite-cases.v1.json", import.meta.url),
  "utf8"
));
const productionPolicy = loadEconomicsPolicyCompatibility({ allowPending: true });
const productionPrerequisites = productionPolicy.prerequisites;

const NIGHTLY = process.env.ECONOMICS_PREREQUISITE_MATRIX_NIGHTLY === "1";
const REPORT = process.env.ECONOMICS_PREREQUISITE_MATRIX_REPORT === "1";
const CAPSTONE_STATISTICS = new Set(["ECO 257", "MAT 217", "PSY 217"]);
const EXPLICIT_COURSES = Object.freeze([
  "ECO 213",
  "ECO 214",
  "ECO 321",
  "ECO 335",
  "ECO 357",
  "ECO 461",
  "ECO 471"
]);

function upper(value) {
  return String(value || "").trim().toUpperCase();
}

function ruleById(ruleId) {
  return [
    ...policy.prerequisiteRules,
    ...policy.concurrencyRules,
    ...policy.permissionRules,
    ...policy.unresolvedPolicyQuestions
  ].find(rule => rule.ruleId === ruleId);
}

function confirmedPrerequisiteEdges() {
  return policy.prerequisiteRules
    .filter(rule => rule.status === "CONFIRMED")
    .flatMap(rule => [
      ...(rule.allOf || []).map(prerequisite => ({
        edgeId: `${rule.ruleId}:allOf:${prerequisite}`,
        ruleId: rule.ruleId,
        course: rule.course,
        kind: "allOf",
        groupIndex: null,
        prerequisite
      })),
      ...(rule.oneOfGroups || []).flatMap((group, groupIndex) => (
        group.map(prerequisite => ({
          edgeId: `${rule.ruleId}:oneOf:${groupIndex}:${prerequisite}`,
          ruleId: rule.ruleId,
          course: rule.course,
          kind: "oneOf",
          groupIndex,
          prerequisite
        }))
      ))
    ]);
}

const edges = confirmedPrerequisiteEdges();
const anchors = new Map(fixture.ruleAnchors.map(anchor => [anchor.ruleId, anchor]));
const prerequisiteRules = new Map(policy.prerequisiteRules.map(rule => [rule.course, rule]));

function selectedDirectPrerequisites(rule, edge = null) {
  const selected = [...(rule.allOf || [])];
  (rule.oneOfGroups || []).forEach((group, groupIndex) => {
    const edgeChoice = edge?.kind === "oneOf" && edge.groupIndex === groupIndex
      ? edge.prerequisite
      : group[0];
    if (edgeChoice) selected.push(edgeChoice);
  });
  return new Set(selected);
}

function directWithoutTarget(rule, edge) {
  const selected = selectedDirectPrerequisites(rule, edge);
  if (edge.kind === "allOf") {
    selected.delete(edge.prerequisite);
  } else {
    for (const option of rule.oneOfGroups[edge.groupIndex]) selected.delete(option);
  }
  return selected;
}

function addClosure(course, target, seen = new Set()) {
  const code = upper(course);
  if (!code || seen.has(code)) return;
  seen.add(code);
  target.add(code);
  const rule = prerequisiteRules.get(code);
  if (!rule) return;
  for (const prerequisite of selectedDirectPrerequisites(rule)) {
    addClosure(prerequisite, target, seen);
  }
}

function completionClosure(courses) {
  const completed = new Set();
  for (const course of courses) addClosure(course, completed);
  return completed;
}

function prerequisitesOf(course) {
  const closure = completionClosure(selectedDirectPrerequisites(prerequisiteRules.get(course) || {}));
  closure.delete(course);
  return closure;
}

function precedingTerm(anchor) {
  const [startText] = anchor.academicYear.split("/");
  const startYear = Number(startText);
  if (anchor.termKey === "Fall") {
    return {
      academicYear: `${startYear - 1}/${startYear}`,
      termKey: "Winter",
      term: `Winter ${startYear}`
    };
  }
  if (anchor.termKey === "Winter") {
    return {
      academicYear: anchor.academicYear,
      termKey: "Fall",
      term: `Fall ${startYear}`
    };
  }
  return {
    academicYear: anchor.academicYear,
    termKey: "Winter",
    term: `Winter ${startYear + 1}`
  };
}

function concurrencyRuleFor(edge) {
  return policy.concurrencyRules.find(rule => (
    rule.course === edge.course
    && (rule.concurrentOptions || []).includes(edge.prerequisite)
  )) || null;
}

function approvalType(rule, oracleFormat) {
  if (oracleFormat && rule.ruleId.startsWith("PERMISSION-")) {
    return "DEPARTMENT_PERMISSION";
  }
  const instructor = /instructor/iu.test(rule.approvalAuthority);
  if (oracleFormat) return instructor ? "INSTRUCTOR_APPROVAL" : "DEPARTMENT_APPROVAL";
  return instructor ? "instructor" : "department";
}

function approvalReason(rule) {
  if (rule.ruleId === "CONCURRENT-INTERMEDIATE-ECO-461") {
    return "concurrent_intermediate_with_capstone";
  }
  if (rule.ruleId.startsWith("CONCURRENT-MATH-")) return "concurrent_math";
  return "Economics Department permission is recorded.";
}

function approvalRecord(rule, dependent, prerequisite, anchor, oracleFormat) {
  const productionConcurrencyPolicy = (productionPrerequisites[dependent]?.concurrentWithApproval || [])
    .find(item => (item.options || []).includes(prerequisite));
  const productionCode = rule.ruleId === "CONCURRENT-INTERMEDIATE-ECO-461"
    ? "CONCURRENT_INTERMEDIATE_DEPARTMENT_APPROVAL"
    : "CONCURRENT_MATH_INSTRUCTOR_APPROVAL";
  if (!oracleFormat && rule.ruleId.startsWith("PERMISSION-")) {
    const canonicalRule = productionPolicy.bundle.indexes.byRuleId[rule.ruleId];
    const years = String(anchor.academicYear).match(/(\d{4})\D+(\d{4})/);
    const termKey = String(anchor.termKey).toUpperCase() === "SPRING" ? "MAY" : String(anchor.termKey).toUpperCase();
    const termId = `${termKey === "FALL" ? years[1] : years[2]}-${termKey}`;
    return {
      approvalId: `fixture-${rule.ruleId.toLowerCase()}`,
      schemaVersion: "1.0.0",
      ruleId: rule.ruleId,
      status: "APPROVED",
      scope: { course: dependent, termId, requirementId: null },
      authority: "ECONOMICS_DEPARTMENT",
      authorityBoundary: canonicalRule.authority.boundary,
      evidenceRef: rule.sourceRefs[0],
      effectiveDate: "2026-08-01",
      expirationDate: null
    };
  }
  return {
    ...(oracleFormat
      ? { ruleId: rule.ruleId }
      : {
          code: productionCode,
          policySource: productionConcurrencyPolicy?.policySource,
          sourceRef: productionConcurrencyPolicy?.sourceRef
        }),
    type: approvalType(rule, oracleFormat),
    authority: rule.approvalAuthority,
    course: dependent,
    prerequisite,
    term: anchor.term,
    reason: approvalReason(rule),
    ...(oracleFormat ? { sourceRef: rule.sourceRefs[0] } : {})
  };
}

function mutatedApproval(record, mutation, oracleFormat) {
  const value = structuredClone(record);
  if (!oracleFormat && value.approvalId) {
    if (mutation === "type" || mutation === "authority") value.authority = "REGISTRAR";
    else if (mutation === "course") value.scope.course = "ECO 999";
    else if (mutation === "prerequisite") value.ruleId = "PERMISSION-ECO-999";
    else if (mutation === "term") value.scope.termId = "2099-WINTER";
    else if (mutation === "source") value.evidenceRef = "unverified";
    return value;
  }
  if (mutation === "type") {
    value.type = oracleFormat
      ? (value.type === "INSTRUCTOR_APPROVAL" ? "DEPARTMENT_APPROVAL" : "INSTRUCTOR_APPROVAL")
      : (value.type === "instructor" ? "department" : "instructor");
  } else if (mutation === "authority") {
    value.authority = "Registrar";
  } else if (mutation === "course") {
    value.course = "ECO 999";
  } else if (mutation === "prerequisite") {
    value.prerequisite = value.prerequisite === null ? "ECO 999" : "ECO 999";
  } else if (mutation === "term") {
    value.term = "Winter 2099";
  }
  return value;
}

function expectedReviewRule(edge) {
  return edge.course === "ECO 335" && edge.prerequisite === "MAT 121"
    ? "REVIEW-ECO-335-MATH-EQUIVALENT"
    : "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE";
}

function expectedViolationRule(edge) {
  if (edge.course !== "ECO 461") return edge.ruleId;
  return CAPSTONE_STATISTICS.has(edge.prerequisite)
    ? "CAPSTONE-STATISTICS-BEFORE"
    : "PREREQ-ECO-461";
}

function evidenceCaseState(edge, scenarioId) {
  const rule = prerequisiteRules.get(edge.course);
  const baselineDirect = selectedDirectPrerequisites(rule, edge);
  const withoutTarget = directWithoutTarget(rule, edge);
  const completed = new Set();
  const oracleInProgress = [];
  const productionRecords = [];
  const sameTermCourses = [];
  let claim = null;
  let inProgressSameTerm = false;

  const addCompleted = (courses, status = "completed", source = "direct-record") => {
    for (const course of completionClosure(courses)) completed.add(course);
    if (status !== "completed" || source !== "direct-record") {
      productionRecords.push({ code: edge.prerequisite, status, source });
    }
  };

  if (scenarioId === "all_prerequisites_completed") {
    addCompleted(baselineDirect);
  } else if (["target_prerequisite_missing", "failed_prerequisite", "withdrawn_prerequisite"].includes(scenarioId)) {
    addCompleted(withoutTarget);
    if (scenarioId !== "target_prerequisite_missing") {
      productionRecords.push({
        code: edge.prerequisite,
        status: scenarioId === "failed_prerequisite" ? "failed" : "withdrawn",
        source: "course-status-matrix"
      });
    }
  } else if (scenarioId === "all_prerequisites_missing") {
    // Intentionally empty.
  } else if (scenarioId === "prerequisite_in_progress_same_term") {
    addCompleted(withoutTarget);
    for (const prerequisite of prerequisitesOf(edge.prerequisite)) completed.add(prerequisite);
    oracleInProgress.push({ course: edge.prerequisite, ...anchors.get(edge.ruleId) });
    productionRecords.push({ code: edge.prerequisite, status: "in_progress", source: "current-term" });
    inProgressSameTerm = true;
  } else if (scenarioId === "dependent_in_later_term") {
    addCompleted(withoutTarget);
    for (const prerequisite of prerequisitesOf(edge.prerequisite)) completed.add(prerequisite);
    const earlier = precedingTerm(anchors.get(edge.ruleId));
    oracleInProgress.push({ course: edge.prerequisite, ...earlier });
    productionRecords.push({ code: edge.prerequisite, status: "in_progress", source: "prior-current-term" });
  } else if (["same_term_without_approval", "same_term_with_correct_approval"].includes(scenarioId)) {
    addCompleted(withoutTarget);
    for (const prerequisite of prerequisitesOf(edge.prerequisite)) completed.add(prerequisite);
    sameTermCourses.push(edge.prerequisite);
  } else if (["ap_evidence", "transfer_evidence", "uncertain_evidence"].includes(scenarioId)) {
    addCompleted(withoutTarget);
    for (const prerequisite of prerequisitesOf(edge.prerequisite)) completed.add(prerequisite);
    completed.add(edge.prerequisite);
    const status = scenarioId === "transfer_evidence"
      ? "transfer"
      : scenarioId === "uncertain_evidence"
        ? "uncertain"
        : "completed";
    productionRecords.push({ code: edge.prerequisite, status, source: scenarioId });
    claim = {
      kind: "equivalency",
      prerequisite: edge.prerequisite,
      evidenceStatus: scenarioId,
      authority: "not independently confirmed"
    };
  } else if (scenarioId === "repeated_course_record") {
    addCompleted(withoutTarget);
    for (const prerequisite of prerequisitesOf(edge.prerequisite)) completed.add(prerequisite);
    completed.add(edge.prerequisite);
    productionRecords.push(
      { code: edge.prerequisite, status: "failed", source: "first-attempt" },
      { code: edge.prerequisite, status: "completed", source: "repeat-completed" }
    );
  } else {
    throw new Error(`Unknown edge scenario: ${scenarioId}`);
  }

  return {
    completed,
    oracleInProgress,
    productionRecords,
    sameTermCourses,
    claim,
    inProgressSameTerm
  };
}

function directProductionRecords(completed, explicitRecords) {
  const explicitCodes = new Set(explicitRecords.map(record => record.code));
  return [
    ...[...completed]
      .filter(code => !explicitCodes.has(code))
      .map(code => ({ code, status: "completed", source: "direct-record" })),
    ...explicitRecords
  ];
}

function makeOracleCourse(course, anchor, approval, claim) {
  return {
    course,
    ...(course === "ECO 461" ? { institution: "Hanover College" } : {}),
    ...(anchor.projectedStanding ? { projectedStanding: anchor.projectedStanding } : {}),
    ...(approval ? { approvalRequired: [approval] } : {}),
    ...(claim ? { prerequisiteClaims: [claim] } : {})
  };
}

function makeProductionCourse(course, approval, prerequisiteClaims = []) {
  return {
    course,
    ...(course === "ECO 461" ? { residency: "hanover" } : {}),
    ...(approval ? { approvalRequired: [approval] } : {}),
    ...(prerequisiteClaims.length ? { prerequisiteClaims } : {})
  };
}

function makeEdgeCase(edge, scenario, { approvalMutation = null } = {}) {
  const anchor = anchors.get(edge.ruleId);
  const state = evidenceCaseState(edge, scenario.scenarioId);
  const concurrencyRule = concurrencyRuleFor(edge);
  const permissionRule = anchor.permissionRuleId ? ruleById(anchor.permissionRuleId) : null;
  const concurrentApprovalNeeded = scenario.scenarioId === "same_term_with_correct_approval";
  let oracleConcurrencyApproval = concurrentApprovalNeeded
    ? approvalRecord(concurrencyRule, edge.course, edge.prerequisite, anchor, true)
    : null;
  let productionConcurrencyApproval = concurrentApprovalNeeded
    ? approvalRecord(concurrencyRule, edge.course, edge.prerequisite, anchor, false)
    : null;
  if (approvalMutation) {
    oracleConcurrencyApproval = mutatedApproval(
      approvalRecord(concurrencyRule, edge.course, edge.prerequisite, anchor, true),
      approvalMutation,
      true
    );
    productionConcurrencyApproval = mutatedApproval(
      approvalRecord(concurrencyRule, edge.course, edge.prerequisite, anchor, false),
      approvalMutation,
      false
    );
  }
  const oraclePermission = permissionRule
    ? approvalRecord(permissionRule, edge.course, null, anchor, true)
    : null;
  const productionPermission = permissionRule
    ? approvalRecord(permissionRule, edge.course, null, anchor, false)
    : null;
  const oracleApproval = oracleConcurrencyApproval || oraclePermission;
  const productionApproval = productionConcurrencyApproval || productionPermission;
  const oracleCourses = [
    ...state.sameTermCourses.map(course => makeOracleCourse(course, anchor, null, null)),
    makeOracleCourse(edge.course, anchor, oracleApproval, state.claim)
  ];
  const productionCourses = [
    ...state.sameTermCourses.map(course => makeProductionCourse(course, null)),
    makeProductionCourse(edge.course, productionApproval)
  ];
  const endYear = Number(anchor.academicYear.split("/")[1]);

  return {
    caseId: `${edge.edgeId}:${scenario.scenarioId}`,
    scenarioId: scenario.scenarioId,
    edge,
    expectedOracleStatus: scenario.expectedOracleStatus,
    expectedReviewRule: scenario.expectedOracleStatus === "REVIEW_REQUIRED"
      ? expectedReviewRule(edge)
      : null,
    expectedViolationRule: scenario.expectedOracleStatus === "INVALID_PREREQUISITES"
      ? expectedViolationRule(edge)
      : null,
    oracleInput: {
      student: {
        academicStanding: edge.course === "ECO 461" ? "Senior" : "Junior",
        completedCourses: [...state.completed].map(course => ({ course })),
        inProgressCourses: state.oracleInProgress
      },
      expectedContext: {
        startYear: Number(anchor.academicYear.split("/")[0]),
        remainingYears: 1,
        expectedGraduationYear: endYear,
        expectedGraduationTerm: `Spring/May ${endYear}`
      },
      plan: {
        id: `${edge.edgeId}:${scenario.scenarioId}`,
        terms: [{
          slotId: `${anchor.termKey.toLowerCase()}-${anchor.academicYear.replace("/", "-")}`,
          ...anchor,
          courses: oracleCourses
        }]
      },
      policy
    },
    productionInput: {
      student: {
        courses: directProductionRecords(state.completed, state.productionRecords)
      },
      plan: {
        terms: [{
          ...anchor,
          absoluteStandingIndex: edge.course === "ECO 461" ? 3 : 2,
          ...(state.inProgressSameTerm ? { inProgressPrerequisitesAvailable: false } : {}),
          courses: productionCourses
        }]
      }
    }
  };
}

function makeApprovalMutationCase(edge, scenario) {
  const concurrencyRule = concurrencyRuleFor(edge);
  const matrixCase = concurrencyRule
    ? makeEdgeCase(
      edge,
      { ...scenario, scenarioId: "same_term_with_correct_approval" },
      { approvalMutation: scenario.mutation }
    )
    : makeEdgeCase(edge, {
      ...scenario,
      scenarioId: "same_term_without_approval"
    });
  if (!concurrencyRule) {
    const anchor = anchors.get(edge.ruleId);
    const templateRule = policy.concurrencyRules[0];
    const oracleApproval = mutatedApproval(
      approvalRecord(templateRule, edge.course, edge.prerequisite, anchor, true),
      scenario.mutation,
      true
    );
    const productionApproval = mutatedApproval(
      approvalRecord(templateRule, edge.course, edge.prerequisite, anchor, false),
      scenario.mutation,
      false
    );
    const oracleDependent = matrixCase.oracleInput.plan.terms[0].courses
      .find(course => course.course === edge.course);
    const productionDependent = matrixCase.productionInput.plan.terms[0].courses
      .find(course => course.course === edge.course);
    oracleDependent.approvalRequired = [
      ...(oracleDependent.approvalRequired || []),
      oracleApproval
    ];
    productionDependent.approvalRequired = [
      ...(productionDependent.approvalRequired || []),
      productionApproval
    ];
  }
  return {
    ...matrixCase,
    caseId: `${edge.edgeId}:${scenario.scenarioId}`,
    scenarioId: scenario.scenarioId
  };
}

function makePermissionCase(scenario) {
  const edge = edges.find(candidate => candidate.course === "ECO 357");
  const anchor = anchors.get(edge.ruleId);
  const rule = prerequisiteRules.get(edge.course);
  const completed = completionClosure(selectedDirectPrerequisites(rule, edge));
  const permissionRule = ruleById(anchor.permissionRuleId);
  const missing = scenario.scenarioId === "permission_missing";
  const oracleApproval = missing
    ? null
    : mutatedApproval(
      approvalRecord(permissionRule, edge.course, null, anchor, true),
      scenario.mutation,
      true
    );
  const productionApproval = missing
    ? null
    : mutatedApproval(
      approvalRecord(permissionRule, edge.course, null, anchor, false),
      scenario.mutation,
      false
    );
  const endYear = Number(anchor.academicYear.split("/")[1]);
  return {
    caseId: `PERMISSION-ECO-357:${scenario.scenarioId}`,
    scenarioId: scenario.scenarioId,
    expectedOracleStatus: scenario.expectedOracleStatus,
    expectedViolationRule: scenario.expectedOracleStatus === "INVALID_PREREQUISITES"
      ? "PERMISSION-ECO-357"
      : null,
    oracleInput: {
      student: {
        academicStanding: "Junior",
        completedCourses: [...completed].map(course => ({ course })),
        inProgressCourses: []
      },
      expectedContext: {
        startYear: Number(anchor.academicYear.split("/")[0]),
        remainingYears: 1,
        expectedGraduationYear: endYear,
        expectedGraduationTerm: `Spring/May ${endYear}`
      },
      plan: {
        id: `PERMISSION-ECO-357:${scenario.scenarioId}`,
        terms: [{
          ...anchor,
          courses: [makeOracleCourse(edge.course, anchor, oracleApproval, null)]
        }]
      },
      policy
    },
    productionInput: {
      student: { courses: directProductionRecords(completed, []) },
      plan: {
        terms: [{
          ...anchor,
          absoluteStandingIndex: 2,
          courses: [makeProductionCourse(edge.course, productionApproval)]
        }]
      }
    }
  };
}

function reviewCaseAnchor(course) {
  const rule = policy.prerequisiteRules.find(candidate => candidate.course === course);
  return anchors.get(rule.ruleId);
}

function makeReviewOnlyCase(definition) {
  const anchor = reviewCaseAnchor(definition.course);
  let completed = new Set();
  let planCourses = [];
  let productionRecords = [];
  let productionClaims = [];

  if (definition.kind === "advanced-course-closure") {
    completed.add(definition.course);
    productionRecords = [{ code: definition.course, status: "completed", source: "advanced-record" }];
  } else {
    const rule = prerequisiteRules.get(definition.course);
    const direct = selectedDirectPrerequisites(rule);
    if (definition.kind === "equivalency") direct.delete("MAT 121");
    if (definition.kind === "waiver") direct.delete(definition.prerequisite);
    if (definition.kind === "substitution") direct.delete(definition.prerequisite);
    completed = completionClosure(direct);
    const claim = {
      kind: definition.kind,
      prerequisite: definition.prerequisite,
      authority: "not independently confirmed"
    };
    productionClaims = [claim];
    planCourses = [makeOracleCourse(definition.course, anchor, null, claim)];
    productionRecords = directProductionRecords(completed, []);
  }
  const endYear = Number(anchor.academicYear.split("/")[1]);
  return {
    caseId: definition.scenarioId,
    scenarioId: definition.scenarioId,
    expectedOracleStatus: definition.expectedOracleStatus,
    expectedReviewRule: definition.expectedReviewRule,
    oracleInput: {
      student: {
        academicStanding: "Junior",
        completedCourses: [...completed].map(course => ({ course })),
        inProgressCourses: []
      },
      expectedContext: {
        startYear: Number(anchor.academicYear.split("/")[0]),
        remainingYears: 1,
        expectedGraduationYear: endYear,
        expectedGraduationTerm: `Spring/May ${endYear}`
      },
      plan: {
        id: definition.scenarioId,
        terms: planCourses.length ? [{ ...anchor, courses: planCourses }] : []
      },
      policy
    },
    productionInput: {
      student: { courses: productionRecords },
      plan: {
        terms: planCourses.length
          ? [{
            ...anchor,
            absoluteStandingIndex: 2,
            courses: [makeProductionCourse(definition.course, null, productionClaims)]
          }]
          : []
      }
    }
  };
}

const concurrencyEdges = edges.filter(concurrencyRuleFor);
const pullRequestCases = [
  ...edges.flatMap(edge => fixture.pullRequestScenarios.map(scenario => makeEdgeCase(edge, scenario))),
  ...concurrencyEdges.flatMap(edge => (
    fixture.concurrencyScenarios.pullRequest.map(scenario => makeEdgeCase(edge, scenario))
  )),
  ...fixture.permissionScenarios.pullRequest.map(makePermissionCase),
  ...fixture.reviewOnlyCases.map(makeReviewOnlyCase)
];
const nightlyOnlyCases = [
  ...edges.flatMap(edge => fixture.nightlyOnlyScenarios.map(scenario => makeEdgeCase(edge, scenario))),
  ...edges.flatMap(edge => (
    fixture.concurrencyScenarios.nightlyOnly.map(scenario => makeApprovalMutationCase(edge, scenario))
  )),
  ...fixture.permissionScenarios.nightlyOnly.map(makePermissionCase)
];

function productionResult(input) {
  const studentResult = evaluateStudentPrerequisites(
    input.student.courses,
    productionPrerequisites
  );
  const planResult = evaluatePlanPrerequisites({
    plan: input.plan,
    student: input.student,
    prerequisites: productionPrerequisites,
    requireRecordedApprovals: true,
    policyBundle: productionPolicy.bundle
  });
  const firstTerm = input.plan.terms?.[0] || null;
  const startYear = Number(firstTerm?.academicYear?.split("/")[0]) || 2027;
  const decisionPlan = {
    ...input.plan,
    unscheduled: input.plan.unscheduled || [],
    terms: (input.plan.terms || []).map((term, termIndex) => ({
      ...term,
      yearIndex: term.yearIndex ?? termIndex,
      courses: (term.courses || []).map(course => ({
        ...course,
        requirementId: course.requirementId || "eco-elective-1",
        source: course.source || "projected-offering"
      }))
    }))
  };
  const decisionEngine = evaluateProductionPlan(
    decisionPlan,
    normalizeStudentFacts({ planCreationDate: "2026-08-05", courses: input.student.courses }),
    {
      planningContext: {
        startYear,
        expectedGraduationYear: startYear + 1,
        effectiveStanding: "junior"
      }
    },
    productionPolicy.bundle
  );
  return {
    valid: studentResult.valid && planResult.valid,
    status: studentResult.status === "REVIEW_REQUIRED" || planResult.status === "REVIEW_REQUIRED"
      ? "REVIEW_REQUIRED"
      : !studentResult.valid || !planResult.valid
        ? "BLOCK"
        : "ALLOW",
    studentResult,
    planResult,
    decisionEngine
  };
}

function substantiveReviews(result) {
  return result.reviewItems.filter(item => item.code !== "RULE_FAMILY_NOT_CHECKED");
}

function assertCanonicalProductionReview(finding, expectedRule, caseId) {
  const policyRecord = productionPolicy.bundle.unresolved.find(record => (
    record.ruleId === expectedRule
  ));
  assert.ok(policyRecord, `${caseId}: missing compiled review policy record`);
  assert.deepEqual(finding.ruleIds, [expectedRule], caseId);
  assert.deepEqual(finding.sourceRefs, policyRecord.sourceRefs, caseId);
  assert.equal(finding.policyDisposition?.disposition, "REVIEW_ONLY", caseId);
  assert.equal(finding.policyDisposition?.enforcement, "NON_ENFORCING", caseId);
  assert.equal(finding.policyDisposition?.status, "REVIEW_REQUIRED", caseId);
  assert.equal(finding.policyDisposition?.requiredDisposition, policyRecord.requiredDisposition, caseId);
  assert.deepEqual(
    finding.provenance?.map(source => source.sourceId),
    policyRecord.sourceRefs.map(sourceRef => sourceRef.split("#")[0]),
    caseId
  );
}

function evaluateMatrixCase(matrixCase) {
  return {
    matrixCase,
    oracle: checkExternalEconomicsPrerequisites(matrixCase.oracleInput),
    production: productionResult(matrixCase.productionInput)
  };
}

function assertOracleOutcome(evaluation) {
  const { matrixCase, oracle } = evaluation;
  assert.equal(oracle.status, matrixCase.expectedOracleStatus, matrixCase.caseId);
  if (matrixCase.expectedReviewRule) {
    assert.ok(
      substantiveReviews(oracle).some(item => item.code === matrixCase.expectedReviewRule),
      `${matrixCase.caseId}: missing review ${matrixCase.expectedReviewRule}`
    );
  }
  if (matrixCase.expectedViolationRule) {
    assert.ok(
      oracle.violations.some(item => item.code === matrixCase.expectedViolationRule)
      || oracle.violations.some(item => item.code === concurrencyRuleFor(matrixCase.edge)?.ruleId),
      `${matrixCase.caseId}: missing violation ${matrixCase.expectedViolationRule}`
    );
  }
  for (const finding of [...oracle.violations, ...substantiveReviews(oracle)]) {
    assert.ok(finding.code, `${matrixCase.caseId}: finding has no stable code`);
    assert.ok(finding.sourceReference, `${matrixCase.caseId}: finding has no policy source`);
  }
}

function resultsDisagree(evaluation) {
  if (evaluation.oracle.status === "REVIEW_REQUIRED") return evaluation.production.status !== "REVIEW_REQUIRED";
  return evaluation.oracle.valid !== evaluation.production.valid;
}

function allowedDisagreement(evaluation) {
  return fixture.allowedProductionDisagreements.find(item => (
    item.scenarioId === evaluation.matrixCase.scenarioId
    && item.oracleStatus === evaluation.oracle.status
    && item.productionValid === evaluation.production.valid
  )) || null;
}

function assertProductionDisagreements(evaluations, suiteName) {
  const disagreements = evaluations.filter(resultsDisagree);
  for (const evaluation of disagreements) {
    const allowed = allowedDisagreement(evaluation);
    assert.ok(allowed, JSON.stringify({
      suiteName,
      caseId: evaluation.matrixCase.caseId,
      oracleStatus: evaluation.oracle.status,
      oracleViolations: evaluation.oracle.violations.map(item => item.code),
      oracleReviews: substantiveReviews(evaluation.oracle).map(item => item.code),
      productionValid: evaluation.production.valid,
      productionStudentIssues: evaluation.production.studentResult.issues,
      productionPlanErrors: evaluation.production.planResult.errors
    }));
  }
  const scenarioIds = new Set(evaluations.map(item => item.matrixCase.scenarioId));
  for (const resolved of fixture.allowedProductionDisagreements.filter(item => scenarioIds.has(item.scenarioId))) {
    assert.ok(
      evaluations.some(evaluation => evaluation.matrixCase.scenarioId === resolved.scenarioId),
      `${suiteName}: missing classified legacy scenario ${resolved.scenarioId}`
    );
  }
  return disagreements;
}

function disagreementClassCounts(disagreements) {
  return disagreements.reduce((counts, evaluation) => {
    const classification = allowedDisagreement(evaluation).classification;
    counts[classification] = (counts[classification] || 0) + 1;
    return counts;
  }, {});
}

function productionEdgeSet() {
  return new Set(Object.entries(productionPrerequisites).flatMap(([course, rule]) => [
    ...(rule.all || []).map(prerequisite => `${course}:allOf:${prerequisite}`),
    ...(rule.any || []).flatMap((group, groupIndex) => (
      group.map(prerequisite => `${course}:oneOf:${groupIndex}:${prerequisite}`)
    ))
  ]));
}

function oracleEdgeSet() {
  return new Set(edges.map(edge => (
    `${edge.course}:${edge.kind}:${edge.kind === "oneOf" ? `${edge.groupIndex}:` : ""}${edge.prerequisite}`
  )));
}

test("Task 8 fixture covers every confirmed and normalized prerequisite-bearing ECO course", () => {
  assert.equal(fixture.authorship, "handwritten-independent");
  assert.equal(fixture.policyVersion, policy.policy.version);
  assert.equal(edges.length, 36);
  assert.equal(new Set(edges.map(edge => edge.edgeId)).size, edges.length);

  const manifestRuleIds = policy.prerequisiteRules
    .filter(rule => rule.status === "CONFIRMED")
    .map(rule => rule.ruleId)
    .sort();
  assert.deepEqual([...anchors.keys()].sort(), manifestRuleIds);
  assert.deepEqual(
    [...new Set(policy.prerequisiteRules.map(rule => rule.course))].sort(),
    Object.keys(productionPrerequisites).sort()
  );
  assert.deepEqual([...oracleEdgeSet()].sort(), [...productionEdgeSet()].sort());
  for (const course of EXPLICIT_COURSES) {
    assert.ok(edges.some(edge => edge.course === course), `missing explicit coverage for ${course}`);
  }

  const micro = anchors.get("PREREQ-ECO-213");
  const macro = anchors.get("PREREQ-ECO-214");
  assert.deepEqual([micro.termKey, micro.term], ["Fall", "Fall 2026"]);
  assert.deepEqual([macro.termKey, macro.term], ["Winter", "Winter 2027"]);
  assert.notEqual(micro.termKey, macro.termKey);

  assert.equal(concurrencyEdges.length, 6);
  assert.equal(pullRequestCases.length, 336);
  assert.equal(nightlyOnlyCases.length, 293);
  assert.equal(fixture.reviewOnlyCases.length, 4);
  assert.equal(
    fixture.matrixPolicy.nightlyEnvironmentVariable,
    "ECONOMICS_PREREQUISITE_MATRIX_NIGHTLY"
  );
});

test(`bounded pull-request prerequisite subset audits ${pullRequestCases.length} cases`, () => {
  const evaluations = pullRequestCases.map(evaluateMatrixCase);
  evaluations.forEach(assertOracleOutcome);
  const disagreements = assertProductionDisagreements(evaluations, "pull-request");
  assert.equal(disagreements.length, 0);
  if (REPORT) {
    console.log(JSON.stringify({
      suite: "pull-request",
      confirmedEdges: edges.length,
      cases: evaluations.length,
      productionDisagreements: disagreements.length,
      disagreementClasses: disagreementClassCounts(disagreements),
      disagreementScenarios: disagreements.reduce((counts, evaluation) => {
        const scenarioId = evaluation.matrixCase.scenarioId;
        counts[scenarioId] = (counts[scenarioId] || 0) + 1;
        return counts;
      }, {})
    }, null, 2));
  }
});

test("review-only evidence never becomes an invented prerequisite conclusion", () => {
  const evaluations = fixture.reviewOnlyCases
    .map(makeReviewOnlyCase)
    .map(evaluateMatrixCase);
  for (const evaluation of evaluations) {
    assertOracleOutcome(evaluation);
    assert.equal(evaluation.oracle.valid, false, evaluation.matrixCase.caseId);
    assert.equal(evaluation.oracle.violations.length, 0, evaluation.matrixCase.caseId);
    assert.equal(evaluation.production.status, "REVIEW_REQUIRED", evaluation.matrixCase.caseId);
    assert.equal(evaluation.production.decisionEngine.status, "REVIEW_REQUIRED", evaluation.matrixCase.caseId);
    assert.equal(
      evaluation.production.decisionEngine.reviewFindings.length,
      1,
      `${evaluation.matrixCase.caseId}: expected exactly one total Production review finding`
    );
    assertCanonicalProductionReview(
      evaluation.production.decisionEngine.reviewFindings[0],
      evaluation.matrixCase.expectedReviewRule,
      evaluation.matrixCase.caseId
    );
  }
});

test("historical prerequisite closure takes precedence over a prerequisite claim", () => {
  const advanced = fixture.reviewOnlyCases.find(item => item.kind === "advanced-course-closure");
  const equivalency = fixture.reviewOnlyCases.find(item => item.kind === "equivalency");
  const decision = evaluateProductionPrerequisites({
    course: advanced.course,
    prerequisiteClaims: [{
      kind: equivalency.kind,
      prerequisite: equivalency.prerequisite,
      authority: "not independently confirmed"
    }]
  }, {}, normalizeStudentFacts({ courses: [] }), productionPolicy.bundle, {
    traceId: "mixed-historical-claim",
    availableCourses: new Set(),
    sameTermCourses: new Set(),
    historical: true
  });
  assert.equal(decision.status, "REVIEW_REQUIRED");
  assertCanonicalProductionReview(decision, advanced.expectedReviewRule, "mixed-historical-claim");
});

test(
  `nightly-only prerequisite subset audits ${nightlyOnlyCases.length} additional cases`,
  { skip: !NIGHTLY },
  () => {
    const evaluations = nightlyOnlyCases.map(evaluateMatrixCase);
    evaluations.forEach(assertOracleOutcome);
    const disagreements = assertProductionDisagreements(evaluations, "nightly-only");
    assert.equal(disagreements.length, 0);
    if (REPORT) {
      console.log(JSON.stringify({
        suite: "nightly-only",
        confirmedEdges: edges.length,
        cases: evaluations.length,
        productionDisagreements: disagreements.length,
        disagreementClasses: disagreementClassCounts(disagreements)
      }, null, 2));
    }
  }
);
