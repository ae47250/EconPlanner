import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import { loadEconomicsPolicyCompatibility } from "../lib/policy/compat-normalized.js";
import { checkExternalEconomicsRequirements } from "./oracle/check-requirements.js";

const policy = JSON.parse(await readFile(
  new URL("./oracle/economics-policy.v1.json", import.meta.url),
  "utf8"
));
const fixture = JSON.parse(await readFile(
  new URL("./fixtures/economics-requirement-cases.v1.json", import.meta.url),
  "utf8"
));
const productionPolicy = loadEconomicsPolicyCompatibility({ allowPending: true });
const productionRequirements = productionPolicy.requirements;

const PROGRAM = Object.freeze({ id: "economics", name: "Economics" });
const PROVISIONAL_STATUS = new Set(["transfer", "uncertain"]);
const PROVISIONAL_SOURCE = /ap|transfer|equivalency|substitution|outside/iu;

function canonicalCourse(value) {
  const course = String(value || "").trim().toUpperCase();
  return course === "PHI 234" ? "ECO 234" : course;
}

function asCourseObject(value) {
  return typeof value === "string" ? { course: value } : structuredClone(value);
}

function materializeCase(definition) {
  const omitted = new Set(definition.omittedCourses || []);
  const electiveIndexes = new Map(
    (definition.electives || []).map((course, index) => [course, index])
  );
  const values = [
    ...fixture.mandatoryExactCourses,
    definition.statistics,
    ...(definition.financeCourses || []),
    definition.cognate,
    ...(definition.electives || []),
    ...(definition.extraCourses || [])
  ].filter(Boolean).filter(course => !omitted.has(course));
  const byExactCourse = new Map();

  for (const value of values) {
    const entry = asCourseObject(value);
    const course = String(entry.course || "").trim().toUpperCase();
    if (!course || byExactCourse.has(course)) continue;
    const override = definition.courseOverrides?.[course] || {};
    const electiveIndex = electiveIndexes.get(course);
    const completedElectiveCount = definition.completedElectiveCount;
    const location = Number.isInteger(electiveIndex) && Number.isInteger(completedElectiveCount)
      ? (electiveIndex < completedElectiveCount ? "completed" : "planned")
      : "completed";
    const requirementId = definition.requirementHints?.[course]
      || (Number.isInteger(electiveIndex) ? `eco-elective-candidate-${electiveIndex + 1}` : null);
    byExactCourse.set(course, {
      course,
      units: 1,
      source: "direct-record",
      status: "completed",
      ...(course === "ECO 461" ? { institution: "Hanover College" } : {}),
      ...(requirementId ? { requirementId } : {}),
      ...entry,
      ...override,
      location
    });
  }

  const entries = [...byExactCourse.values()];
  return {
    definition,
    completedEntries: entries.filter(entry => entry.location === "completed"),
    plannedEntries: entries.filter(entry => entry.location === "planned")
  };
}

function confirmedForOracle(entry) {
  if (entry.course === "ECO 461") return true;
  if (PROVISIONAL_STATUS.has(entry.status)) return false;
  return !PROVISIONAL_SOURCE.test(entry.source || "");
}

function oracleCourse(entry) {
  const value = {
    course: entry.course,
    units: entry.units,
    ...(entry.requirementId ? { requirementId: entry.requirementId } : {}),
    ...(entry.institution ? { institution: entry.institution } : {})
  };
  return value;
}

function oracleInput(materialized) {
  const { definition, completedEntries, plannedEntries } = materialized;
  return {
    student: {
      studentId: `fictional-${definition.caseId}`,
      completedCourses: completedEntries
        .filter(confirmedForOracle)
        .map(oracleCourse)
    },
    expectedContext: {
      startYear: 2026,
      remainingYears: 1,
      expectedGraduationYear: 2027,
      expectedGraduationTerm: "Spring/May 2027"
    },
    plan: {
      id: definition.caseId,
      requirementClaims: definition.requirementClaims || [],
      terms: plannedEntries.length ? [{
        slotId: "fall-2026",
        term: "Fall 2026",
        termKey: "Fall",
        academicYear: "2026/2027",
        courses: plannedEntries.map(oracleCourse)
      }] : []
    },
    policy
  };
}

function productionCourse(entry, planned) {
  return {
    code: entry.course,
    status: planned ? "in_progress" : entry.status,
    units: entry.units,
    source: entry.source,
    ...(entry.institution ? { institution: entry.institution } : {})
  };
}

function productionResult(materialized) {
  const student = {
    courses: [
      ...materialized.completedEntries.map(entry => productionCourse(entry, false)),
      ...materialized.plannedEntries.map(entry => productionCourse(entry, true))
    ]
  };
  const mapping = mapStudentToProgram(PROGRAM, productionRequirements, student, { policyBundle: productionPolicy.bundle });
  const strict = mapping.projectedAfterInProgress.strict;
  const optimistic = mapping.projectedAfterInProgress.optimistic;
  return {
    mapping,
    strict,
    optimistic,
    status: mapping.reviewFindings?.length ? "REVIEW_REQUIRED" : optimistic.remainingUnits === 0 ? "ALLOW" : "BLOCK",
    strictComplete: strict.remainingUnits === 0,
    optimisticComplete: optimistic.remainingUnits === 0
  };
}

function substantiveReviews(result) {
  return result.reviewItems.filter(item => item.code !== "RULE_FAMILY_NOT_CHECKED");
}

function semanticOracleAssignments(allocation) {
  const fixed = Object.fromEntries(allocation
    .filter(item => item.ruleId !== "REQ-ECO-ELECTIVES")
    .map(item => [item.ruleId, item.canonicalCourse]));
  const electives = allocation
    .filter(item => item.ruleId === "REQ-ECO-ELECTIVES")
    .map(item => item.canonicalCourse)
    .sort();
  return { fixed, electives };
}

function productionRuleId(slotId) {
  const fixed = {
    "eco-113": "REQ-ECO-113",
    "eco-114": "REQ-ECO-114",
    "eco-213": "REQ-ECO-213",
    "eco-214": "REQ-ECO-214",
    statistics: "REQ-STATISTICS",
    finance: "REQ-FINANCE",
    "eco-461": "REQ-ECO-461",
    cognate: "REQ-COGNATE"
  };
  if (String(slotId).startsWith("eco-elective-")) return "REQ-ECO-ELECTIVES";
  return fixed[slotId] || null;
}

function semanticProductionAssignments(assignments) {
  const normalized = assignments.map(item => ({
    ruleId: productionRuleId(item.slotId),
    course: canonicalCourse(item.code)
  }));
  return {
    fixed: Object.fromEntries(normalized
      .filter(item => item.ruleId && item.ruleId !== "REQ-ECO-ELECTIVES")
      .map(item => [item.ruleId, item.course])),
    electives: normalized
      .filter(item => item.ruleId === "REQ-ECO-ELECTIVES")
      .map(item => item.course)
      .sort()
  };
}

function expectedSemanticAssignments(definition) {
  return {
    fixed: {
      ...fixture.assignmentDefaults.fixed,
      "REQ-STATISTICS": definition.expectedAssignments.statistics,
      "REQ-FINANCE": definition.expectedAssignments.finance,
      "REQ-COGNATE": definition.expectedAssignments.cognate
    },
    electives: [...definition.expectedAssignments.electives].map(canonicalCourse).sort()
  };
}

function evaluateCase(definition) {
  const materialized = materializeCase(definition);
  return {
    definition,
    materialized,
    oracle: checkExternalEconomicsRequirements(oracleInput(materialized)),
    production: productionResult(materialized)
  };
}

const evaluations = fixture.cases.map(evaluateCase);

function allowedDisagreement(evaluation) {
  return fixture.allowedProductionDisagreements.find(item => (
    item.caseId === evaluation.definition.caseId
    && item.oracleStatus === evaluation.oracle.status
    && item.productionComplete === evaluation.production.optimisticComplete
  )) || null;
}

function resultsDisagree(evaluation) {
  if (evaluation.oracle.status === "REVIEW_REQUIRED") return evaluation.production.status !== "REVIEW_REQUIRED";
  return evaluation.oracle.valid !== evaluation.production.optimisticComplete;
}

function assertSourcedFindings(evaluation) {
  for (const finding of [
    ...evaluation.oracle.violations,
    ...substantiveReviews(evaluation.oracle)
  ]) {
    assert.ok(finding.code, `${evaluation.definition.caseId}: finding has no stable code`);
    assert.ok(finding.sourceReference, `${evaluation.definition.caseId}: finding has no policy source`);
  }
}

test("Task 9 fixture covers every requested allocation combination", () => {
  assert.equal(fixture.authorship, "handwritten-independent");
  assert.equal(fixture.policyVersion, policy.policy.version);
  assert.equal(fixture.cases.length, 26);
  assert.deepEqual(
    fixture.cases.reduce((counts, item) => ({
      ...counts,
      [item.category]: (counts[item.category] || 0) + 1
    }), {}),
    { confirmed: 15, invalid: 7, review: 4 }
  );
  assert.equal(new Set(fixture.cases.map(item => item.caseId)).size, fixture.cases.length);

  const ids = new Set(fixture.cases.map(item => item.caseId));
  for (const required of [
    "finance-eco321-alone",
    "finance-busn323-alone",
    "finance-both-busn-finance-eco321-elective",
    "finance-eco321-attempted-double-count",
    "statistics-eco257",
    "statistics-mat217",
    "statistics-psy217",
    "statistics-mat217-eco257-elective",
    "elective-crosslist-eco234-phi234-duplicate",
    "elective-eco260-counts",
    "elective-eco307-half-unit",
    "elective-one-existing-100-level",
    "elective-attempted-second-100-level",
    "capstone-transfer-eco461",
    "capstone-ap-eco461",
    "review-provisional-transfer-statistics",
    "review-uncertain-cognate-equivalency",
    "review-cognate-waiver",
    "review-eco214-substitution"
  ]) assert.ok(ids.has(required), `missing requested case: ${required}`);

  const completedCounts = fixture.cases
    .filter(item => /^electives-(?:zero|one|two|three|four)-completed$/u.test(item.caseId))
    .map(item => item.completedElectiveCount)
    .sort((left, right) => left - right);
  assert.deepEqual(completedCounts, [0, 1, 2, 3, 4]);
});

test("all confirmed cases have exact independent semantic slot assignments", () => {
  const confirmed = evaluations.filter(item => item.definition.category === "confirmed");
  assert.equal(confirmed.length, 15);

  for (const evaluation of confirmed) {
    const { definition, oracle } = evaluation;
    assert.equal(oracle.status, "VALID_REQUIREMENTS", definition.caseId);
    assert.equal(oracle.valid, true, definition.caseId);
    assert.deepEqual(oracle.violations, [], definition.caseId);
    assert.equal(oracle.allocations.length, 1, definition.caseId);
    assert.equal(oracle.allocation.length, 12, definition.caseId);
    assert.deepEqual(
      semanticOracleAssignments(oracle.allocation),
      expectedSemanticAssignments(definition),
      definition.caseId
    );

    if (Number.isInteger(definition.expectedCompletedElectiveCount)) {
      const completedElectives = oracle.allocation.filter(item => (
        item.ruleId === "REQ-ECO-ELECTIVES"
        && item.coursePath.startsWith("$.student.completedCourses")
      ));
      assert.equal(
        completedElectives.length,
        definition.expectedCompletedElectiveCount,
        definition.caseId
      );
    }
    assertSourcedFindings(evaluation);
  }
});

test("invalid combinations fail under the confirmed independent rule IDs", () => {
  const invalid = evaluations.filter(item => item.definition.category === "invalid");
  assert.equal(invalid.length, 7);

  for (const evaluation of invalid) {
    const { definition, oracle } = evaluation;
    const codes = new Set(oracle.violations.map(item => item.code));
    assert.equal(oracle.status, "INVALID_REQUIREMENTS", definition.caseId);
    assert.equal(oracle.valid, false, definition.caseId);
    assert.equal(oracle.allocations.length, 0, definition.caseId);
    for (const expected of definition.expectedViolationCodes) {
      assert.ok(codes.has(expected), `${definition.caseId}: missing ${expected}`);
    }
    assertSourcedFindings(evaluation);
  }
});

test("equivalencies, provisional evidence, waivers, and substitutions remain explicit review states", () => {
  const review = evaluations.filter(item => item.definition.category === "review");
  assert.equal(review.length, 4);

  for (const evaluation of review) {
    const { definition, oracle, production } = evaluation;
    const reviewCodes = new Set(substantiveReviews(oracle).map(item => item.code));
    assert.equal(oracle.status, "REVIEW_REQUIRED", definition.caseId);
    assert.equal(oracle.valid, false, definition.caseId);
    assert.equal(oracle.allocation, null, definition.caseId);
    assert.equal(oracle.allocations.length, 0, definition.caseId);
    assert.deepEqual(oracle.violations, [], definition.caseId);
    for (const expected of definition.expectedReviewCodes) {
      assert.ok(reviewCodes.has(expected), `${definition.caseId}: missing ${expected}`);
    }
    assert.equal(
      production.strictComplete,
      definition.expectedProduction.strictComplete,
      `${definition.caseId}: strict production outcome`
    );
    assert.equal(
      production.optimisticComplete,
      definition.expectedProduction.optimisticComplete,
      `${definition.caseId}: optimistic production outcome`
    );
    if (Number.isFinite(definition.expectedProduction.appliedUnits)) {
      assert.equal(
        production.optimistic.appliedUnits,
        definition.expectedProduction.appliedUnits,
        `${definition.caseId}: a review claim must not create units`
      );
    }
    assertSourcedFindings(evaluation);
  }
});

test("production agreements and disagreements are explicit and bounded", () => {
  const disagreements = evaluations.filter(resultsDisagree);
  assert.equal(
    disagreements.length,
    0,
    JSON.stringify(disagreements.map(evaluation => ({
      caseId: evaluation.definition.caseId,
      oracleStatus: evaluation.oracle.status,
      productionStatus: evaluation.production.status,
      productionStrictComplete: evaluation.production.strictComplete,
      productionOptimisticComplete: evaluation.production.optimisticComplete,
      productionReviewCodes: evaluation.production.mapping.reviewFindings?.map(item => item.code) || []
    })))
  );

  for (const evaluation of disagreements) {
    assert.ok(allowedDisagreement(evaluation), JSON.stringify({
      caseId: evaluation.definition.caseId,
      oracleStatus: evaluation.oracle.status,
      productionStrictComplete: evaluation.production.strictComplete,
      productionOptimisticComplete: evaluation.production.optimisticComplete,
      productionUnresolved: evaluation.production.optimistic.unresolved
    }));
  }
  for (const resolved of fixture.allowedProductionDisagreements) {
    assert.ok(evaluations.some(evaluation => evaluation.definition.caseId === resolved.caseId));
  }

  for (const evaluation of evaluations.filter(item => !resultsDisagree(item))) {
    if (evaluation.definition.category === "confirmed") {
      assert.equal(evaluation.production.optimisticComplete, true, evaluation.definition.caseId);
      assert.deepEqual(
        semanticProductionAssignments(evaluation.production.optimistic.assignments),
        expectedSemanticAssignments(evaluation.definition),
        evaluation.definition.caseId
      );
    } else if (evaluation.definition.category === "invalid") {
      assert.equal(evaluation.production.optimisticComplete, false, evaluation.definition.caseId);
    }
  }
});

test("ECO 257 remains statistics-only when another course fills statistics", () => {
  const evaluation = evaluations.find(item => (
    item.definition.caseId === "statistics-mat217-eco257-elective"
  ));
  assert.ok(evaluation);
  assert.equal(evaluation.oracle.status, "INVALID_REQUIREMENTS");
  assert.ok(evaluation.oracle.violations.some(item => (
    item.code === "ELECTIVE-ECO-257-STATISTICS-ONLY"
  )));
  assert.equal(evaluation.production.optimisticComplete, false);
  assert.equal(allowedDisagreement(evaluation), null);
});
