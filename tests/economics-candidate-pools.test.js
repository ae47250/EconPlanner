import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import { resolvePlanningContext } from "../lib/planning/horizon.js";
import { auditExternalEconomicsPlanComplete } from "./oracle/audit-external-plan.js";

const capabilitiesFixture = JSON.parse(await readFile(
  new URL("./fixtures/economics-test-capabilities.v1.json", import.meta.url),
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
const productionSchedule = JSON.parse(await readFile(
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

const economicsModule = await import("../lib/planning/economics.js");
const termSolverModule = await import("../lib/planning/termSolver.js");
const ECONOMICS_PROGRAM = Object.freeze({ id: "economics", name: "Economics" });
const profilesById = new Map(capabilitiesFixture.profiles.map(profile => [profile.id, profile]));
const variantsById = new Map([
  ...(economicsModule.PLAN_VARIANTS || []),
  ...(economicsModule.EARLY_GRADUATION_VARIANT ? [economicsModule.EARLY_GRADUATION_VARIANT] : [])
].map(variant => [variant.id, variant]));

function studentFor(profileId) {
  const profile = profilesById.get(profileId);
  assert.ok(profile, `Missing Task 14 profile ${profileId}.`);
  return structuredClone(profile.student);
}

function mappingFor(student) {
  return mapStudentToProgram(ECONOMICS_PROGRAM, productionRequirements, student);
}

function buildStrategy(profileId, variantId, {
  schedule = productionSchedule,
  nodeLimit,
  candidateLimit = 12,
  planningMode = "standard"
} = {}) {
  const student = studentFor(profileId);
  const mapping = mappingFor(student);
  const planVariant = variantsById.get(variantId);
  assert.ok(planVariant, `Missing production plan variant ${variantId}.`);
  const selected = economicsModule.buildEconomicsTermPlan({
    student,
    mapping,
    schedule,
    prerequisites: productionPrerequisites,
    planningContext: resolvePlanningContext(student),
    planVariant,
    planningMode,
    candidateLimit,
    ...(Number.isInteger(nodeLimit) ? { nodeLimit } : {})
  });
  return {
    student,
    mapping,
    selected,
    reserve: selected?._candidateReserve || []
  };
}

function buildBundle(profileId, { schedule = productionSchedule, nodeLimit, collectDiagnostics = false } = {}) {
  const student = studentFor(profileId);
  const mapping = mappingFor(student);
  const bundle = economicsModule.buildEconomicsTermPlans({
    student,
    mapping,
    schedule,
    prerequisites: productionPrerequisites,
    collectDiagnostics,
    ...(Number.isInteger(nodeLimit) ? { nodeLimit } : {})
  });
  return { student, mapping, bundle };
}

function currentFreshmanStudent(overrides = {}) {
  return {
    academicStanding: "freshman",
    planCreationDate: "2026-08-10",
    planningPace: "standard",
    courses: [],
    reservedCourseUnits: {},
    scheduleSetByTerm: {},
    studyAbroadTerm: "",
    ...overrides
  };
}

function buildCurrentFreshmanBundle(overrides = {}) {
  const student = currentFreshmanStudent(overrides);
  const mapping = mappingFor(student);
  const bundle = economicsModule.buildEconomicsTermPlans({
    student,
    mapping,
    schedule: productionSchedule,
    prerequisites: productionPrerequisites,
    collectDiagnostics: true
  });
  return { student, mapping, bundle };
}

function firstYearTermLoads(plan) {
  return ["Fall", "Winter", "Spring"].map(termKey => (
    plan.terms.find(term => term.yearIndex === 0 && term.termKey === termKey)?.courses.length || 0
  ));
}

function assertIntroCoursesAreSeparated(plan) {
  const introTerms = plan.terms
    .filter(term => term.courses.some(course => ["ECO 113", "ECO 114"].includes(course.course)))
    .map(term => term.slotId);
  assert.equal(introTerms.length, 2);
  assert.notEqual(introTerms[0], introTerms[1]);
}

test("opt-in nightly diagnostics do not change production planner output", () => {
  const withoutDiagnostics = buildBundle("safe-reserve-two-remaining").bundle;
  const withDiagnostics = buildBundle("safe-reserve-two-remaining", { collectDiagnostics: true }).bundle;
  const { metricsDiagnostics, ...productionShape } = withDiagnostics;
  assert.deepEqual(productionShape, withoutDiagnostics);
  assert.ok(metricsDiagnostics.strategyAttempts.length > 0);
  assert.ok(metricsDiagnostics.searchAttempts.length >= metricsDiagnostics.strategyAttempts.length);
  for (const attempt of metricsDiagnostics.strategyAttempts) {
    assert.equal(attempt.attempted, true);
    assert.ok(Number.isFinite(attempt.durationMs));
    assert.ok(Number.isInteger(attempt.nodesVisited));
    assert.ok(Array.isArray(attempt.validationErrors));
    assert.equal(attempt.perInvocationSolutionLimit, 100);
    assert.ok(Array.isArray(attempt.rawSolutionsByStage));
    assert.equal(
      attempt.totalRawSolutionsAcrossAttemptChain,
      attempt.rawSolutionsByStage.reduce((sum, stage) => sum + stage.rawSolutionsEncountered, 0)
    );
  }
  for (const search of metricsDiagnostics.searchAttempts) {
    assert.ok(["economics-load-preference", "preferred-distribution", "soft-preference-rescue", "same-solver-rescue", "final-validator-rescue"].includes(search.innerSearchStage));
    assert.equal(search.solutionLimit, 100);
    assert.ok(Number.isInteger(search.rawSolutionsEncountered));
    assert.equal(typeof search.domainSizes, "object");
    assert.ok(Array.isArray(search.emptyDomains));
  }
});

test("nightly diagnostics retain the standard and selected early strategy attempts", () => {
  const student = {
    ...studentFor("verified-five-remaining"),
    academicStanding: "freshman"
  };
  const standardBundle = economicsModule.buildEconomicsTermPlans({
    student,
    mapping: mappingFor(student),
    schedule: productionSchedule,
    prerequisites: productionPrerequisites,
    collectDiagnostics: true
  });
  const earlyGraduationYear = resolvePlanningContext(student).expectedGraduationYear - 1;
  const earlyStudent = {
    ...student,
    planningPace: "one_year_early",
    projectedSeniorStandingConfirmation: {
      status: "STUDENT_REPORTED_REGISTRAR_OR_ADVISOR_CONFIRMATION",
      academicYear: `${earlyGraduationYear - 1}/${earlyGraduationYear}`
    }
  };
  const earlyBundle = economicsModule.buildEconomicsTermPlans({
    student: earlyStudent,
    mapping: mappingFor(earlyStudent),
    schedule: productionSchedule,
    prerequisites: productionPrerequisites,
    collectDiagnostics: true
  });
  const strategies = new Set([
    ...standardBundle.metricsDiagnostics.strategyAttempts,
    ...earlyBundle.metricsDiagnostics.strategyAttempts
  ].map(attempt => attempt.strategyId));
  assert.deepEqual(strategies, new Set(["balanced", "explore-first", "one-year-early"]));
  assert.ok(standardBundle.metricsDiagnostics.strategyAttempts.every(attempt => attempt.strategyId !== "one-year-early"));
  assert.ok(earlyBundle.metricsDiagnostics.strategyAttempts.some(attempt => attempt.strategyId === "one-year-early"));
});

test("the current freshman Explore plan selects the top separated first-year tier within the ordinary solution budget", () => {
  const result = buildCurrentFreshmanBundle();
  const balanced = result.bundle.plans.find(plan => plan.id === "balanced");
  const explore = result.bundle.plans.find(plan => plan.id === "explore-first");
  const outcome = result.bundle.candidateOutcomes.find(item => item.id === "explore-first");

  assert.ok(balanced);
  assert.ok(explore);
  assert.deepEqual(firstYearTermLoads(explore), [1, 1, 0]);
  assert.ok(firstYearTermLoads(explore).every(load => load <= 1));
  assertIntroCoursesAreSeparated(explore);
  assert.equal(explore.validation.distribution.exactPreferredPacingFound, true);
  assert.ok(firstYearTermLoads(explore).reduce((sum, load) => sum + load, 0)
    < firstYearTermLoads(balanced).reduce((sum, load) => sum + load, 0));
  assert.equal(economicsModule.materialPlanDistance(balanced, explore).materiallyDifferent, true);
  assert.equal(validateCandidate(result, explore).valid, true);
  assertPassesIndependentOracle(result.student, explore);
  assert.equal(explore.candidateRank, 1);
  assert.equal(outcome.selectedCandidateRank, 1);
  assert.equal(outcome.candidatePool.perInvocationSolutionLimit, 100);
  assert.equal(outcome.candidatePool.eligibleFinalValidSchedules > 0, true);
  assert.equal(outcome.suppressionReason, null);
});

test("Explore counts fixed Fall Taking now occupancy toward the top separated first-year tier", () => {
  const result = buildCurrentFreshmanBundle({
    planCreationDate: "2026-08-24",
    courses: [{ code: "ECO 113", status: "in_progress" }]
  });
  const explore = result.bundle.plans.find(plan => plan.id === "explore-first");
  const outcome = result.bundle.candidateOutcomes.find(item => item.id === "explore-first");
  const shape = explore?.distribution.preferredTermShapeTiersByYear[0];
  const fall = explore?.terms.find(term => term.slotId === "fall-2026");
  const winter = explore?.terms.find(term => term.slotId === "winter-2027");

  assert.ok(explore);
  assert.deepEqual(firstYearTermLoads(explore), [1, 1, 0]);
  assert.deepEqual(shape.selected, [1, 1, 0]);
  assert.equal(shape.selectedPreferenceTier, 1);
  assert.equal(shape.lowerTierUsed, false);
  assert.equal(shape.higherTiersUnavailableByCapacity, false);
  assert.equal(explore.distribution.fixedTrackedOccupancy.byTerm["fall-2026"], 1);
  assert.equal(fall.courses.length, 1);
  assert.equal(fall.courses[0].course, "ECO 113");
  assert.equal(fall.courses[0].fixedInProgress, true);
  assert.equal(winter.courses.length, 1);
  assert.notEqual(winter.courses[0].fixedInProgress, true);
  assert.equal(explore.validation.distribution.termShapeDistance, 0);
  assert.equal(explore.validation.distribution.exactPreferredPacingFound, true);
  assert.equal(validateCandidate(result, explore).valid, true);
  assertPassesIndependentOracle(result.student, explore);
  assert.equal(explore.candidateRank, 1);
  assert.equal(outcome.selectedCandidateRank, 1);
  assert.equal(outcome.candidatePool.perInvocationSolutionLimit, 100);
  assert.equal(outcome.candidatePool.complete, false);
  assert.equal(outcome.candidatePool.terminationReason, "SOLUTION_BUDGET");
  assert.equal(outcome.candidatePool.eligibleFinalValidSchedules > 0, true);
  assert.equal(outcome.suppressionReason, null);
});

test("Explore retains the fixed-occupancy same-term rescue only when later first-year terms have no capacity", () => {
  const result = buildCurrentFreshmanBundle({
    planCreationDate: "2026-08-24",
    courses: [{ code: "ECO 113", status: "in_progress" }],
    reservedCourseUnits: {
      "winter-2027": 4,
      "spring-2027": 1
    }
  });
  const explore = result.bundle.plans.find(plan => plan.id === "explore-first");
  const outcome = result.bundle.candidateOutcomes.find(item => item.id === "explore-first");
  const shape = explore?.distribution.preferredTermShapeTiersByYear[0];
  const fall = explore?.terms.find(term => term.slotId === "fall-2026");

  assert.ok(explore);
  assert.deepEqual(firstYearTermLoads(explore), [2, 0, 0]);
  assert.deepEqual(shape.selected, [2, 0, 0]);
  assert.equal(shape.selectedPreferenceTier, 3);
  assert.equal(shape.lowerTierUsed, true);
  assert.equal(shape.higherTiersUnavailableByCapacity, true);
  assert.deepEqual(shape.minimums, [1, 0, 0]);
  assert.deepEqual(shape.maximums, [4, 0, 0]);
  assert.equal(fall.courses.filter(course => course.course === "ECO 113" && course.fixedInProgress).length, 1);
  assert.equal(fall.courses.filter(course => !course.fixedInProgress).length, 1);
  assert.equal(explore.validation.distribution.termShapeDistance, 0);
  assert.equal(explore.validation.distribution.exactPreferredPacingFound, true);
  assert.equal(validateCandidate(result, explore).valid, true);
  assertPassesIndependentOracle(result.student, explore);
  assert.equal(outcome.selectedCandidateRank, 1);
  assert.equal(outcome.candidatePool.complete, false);
  assert.equal(outcome.candidatePool.terminationReason, "SOLUTION_BUDGET");
  assert.notEqual(outcome.status, "NOT_FEASIBLE");
  assert.notEqual(outcome.status, "SEARCH_INCOMPLETE");
  assert.equal(outcome.suppressionReason, null);
});

test("Explore keeps fixed Fall occupancy but adds nothing to Fall when the current schedule is already set", () => {
  const result = buildCurrentFreshmanBundle({
    planCreationDate: "2026-08-24",
    courses: [{ code: "ECO 113", status: "in_progress" }],
    scheduleSetByTerm: { "fall-2026": true }
  });
  const explore = result.bundle.plans.find(plan => plan.id === "explore-first");
  const fall = explore?.terms.find(term => term.slotId === "fall-2026");
  const winter = explore?.terms.find(term => term.slotId === "winter-2027");

  assert.ok(explore);
  assert.deepEqual(firstYearTermLoads(explore), [1, 1, 0]);
  assert.equal(fall.courses.length, 1);
  assert.equal(fall.courses[0].course, "ECO 113");
  assert.equal(fall.courses[0].fixedInProgress, true);
  assert.equal(winter.courses.length, 1);
  assert.notEqual(winter.courses[0].fixedInProgress, true);
  assert.equal(explore.validation.distribution.termShapeDistance, 0);
  assert.equal(explore.validation.distribution.exactPreferredPacingFound, true);
  assert.equal(validateCandidate(result, explore).valid, true);
  assertPassesIndependentOracle(result.student, explore);
});

test("Explore uses the same-term rescue tier only when first-year capacity rules out every separated tier", () => {
  const result = buildCurrentFreshmanBundle({
    reservedCourseUnits: {
      "winter-2027": 4,
      "spring-2027": 1
    }
  });
  const explore = result.bundle.plans.find(plan => plan.id === "explore-first");
  const outcome = result.bundle.candidateOutcomes.find(item => item.id === "explore-first");
  const shape = explore?.distribution.preferredTermShapeTiersByYear[0];

  assert.ok(explore);
  assert.deepEqual(firstYearTermLoads(explore), [2, 0, 0]);
  assert.equal(shape.selectedPreferenceTier, 3);
  assert.equal(shape.lowerTierUsed, true);
  assert.equal(shape.higherTiersUnavailableByCapacity, true);
  assert.deepEqual(shape.preferredTiers, [[[2, 0, 0]]]);
  assert.equal(explore.validation.distribution.exactPreferredPacingFound, true);
  assert.equal(validateCandidate(result, explore).valid, true);
  assertPassesIndependentOracle(result.student, explore);
  assert.equal(outcome.selectedCandidateRank, 1);
  assert.equal(outcome.candidatePool.eligibleFinalValidSchedules > 0, true);
  assert.notEqual(outcome.status, "NOT_FEASIBLE");
  assert.notEqual(outcome.status, "SEARCH_INCOMPLETE");
  assert.equal(outcome.suppressionReason, null);
});

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
  const type = "INSTRUCTOR_APPROVAL";
  return {
    ruleId,
    type,
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
    completedCourses: student.courses
      .filter(course => ["completed", "transfer", "in_progress"].includes(course.status))
      .map(course => ({
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

function auditPlan(student, plan, verifiedSchedule = oracleSchedule) {
  return auditExternalEconomicsPlanComplete({
    student: externalStudent(student),
    expectedContext: plan.planningContext,
    plan: {
      id: plan.id,
      terms: plan.terms.map(term => ({
        ...term,
        reservedOutsideCourseUnits: Number(term.reservedCourseUnits || 0)
          + term.courses.filter(course => course.fixedInProgress).reduce((sum, course) => (
            sum + Number(course.units || 1)
          ), 0),
        courses: term.courses
          .filter(course => !course.fixedInProgress)
          .map(course => oracleCourse(plan, term, course))
      })),
      requirementClaims: []
    },
    policy: oraclePolicy,
    verifiedSchedule
  });
}

function assertPassesIndependentOracle(student, plan, verifiedSchedule = oracleSchedule) {
  const audit = auditPlan(student, plan, verifiedSchedule);
  assert.equal(
    audit.valid,
    true,
    `${plan.label || plan.id} failed the independent oracle: ${JSON.stringify({
      violations: audit.violations,
      reviewItems: audit.reviewItems
    })}`
  );
}

function flatCourses(plan) {
  return (plan?.terms || []).flatMap(term => term.courses || []);
}

function _strategyTopSignature(profileId, variantId, options = {}) {
  const result = buildStrategy(profileId, variantId, options);
  return {
    ...result,
    signature: result.reserve[0]
      ? economicsModule.semanticPlanSignature(result.reserve[0])
      : null
  };
}

function closeMayOfferings(schedule) {
  const altered = structuredClone(schedule);
  for (const offering of altered.terms?.May || []) {
    offering.availability = {
      ...offering.availability,
      status: "closed",
      seatsOpen: 0,
      asOf: "2026-07-30"
    };
  }
  return altered;
}

function injectEco257ElectiveTemptation(schedule) {
  const altered = structuredClone(schedule);
  const template = structuredClone(altered.terms.Fall.find(offering => offering.course === "ECO 333"));
  assert.ok(template, "Task 14 requires an existing verified Fall section template.");
  template.course = "ECO 257";
  template.section = "FILTER";
  template.title = "Applied Statistics";
  template.meeting = {
    ...template.meeting,
    days: ["Tue", "Thu"],
    startTime: "6:00 PM",
    endTime: "7:15 PM"
  };
  altered.terms.Fall.push(template);
  return altered;
}

function mutateElectiveToEco257(plan) {
  const invalid = structuredClone(plan);
  const elective = flatCourses(invalid).find(course => (
    String(course.requirementId || "").startsWith("eco-elective")
  ));
  assert.ok(elective, "The Task 14 fault injection requires an Economics elective.");
  elective.course = "ECO 257";
  elective.title = "Applied Statistics";
  elective.source = "requirement-placeholder";
  elective.verificationStatus = "unverified";
  elective.availability = { status: "unknown", seatsOpen: null, capacity: null, asOf: null };
  elective.meeting = null;
  elective.provenance = {};
  delete elective.section;
  delete invalid.candidateRank;
  delete invalid.strategyScore;
  delete invalid.safetyScore;
  return invalid;
}

function validateCandidate(result, candidate) {
  return economicsModule.validateGeneratedPlan(candidate, {
    student: result.student,
    mapping: result.mapping,
    schedule: productionSchedule,
    prerequisites: productionPrerequisites,
    context: candidate.planningContext
  });
}

async function detectCapabilities() {
  const detected = new Map();
  detected.set("SEMANTIC_SIGNATURE", typeof economicsModule.semanticPlanSignature === "function");
  detected.set("SEARCH_INCOMPLETE", typeof economicsModule.buildEconomicsTermPlans === "function");
  detected.set("CANDIDATE_POOL_DIAGNOSTICS", false);
  detected.set("MULTIPLE_CANDIDATE_RESERVE", false);

  if (typeof economicsModule.buildEconomicsTermPlan === "function"
    && typeof economicsModule.buildEconomicsTermPlans === "function"
    && typeof termSolverModule.solveEconomicsTermPlan === "function") {
    const poolCase = buildStrategy(
      capabilitiesFixture.expectations.multipleCandidatePool.profileId,
      capabilitiesFixture.expectations.multipleCandidatePool.variantId,
      { planningMode: "graduation_priority" }
    );
    detected.set("CANDIDATE_POOL_DIAGNOSTICS", Boolean(
      poolCase.selected?.candidatePool
      && typeof poolCase.selected.candidatePool.complete === "boolean"
      && Number.isInteger(poolCase.selected.candidatePool.retainedDistinctSchedules)
    ));
    detected.set("MULTIPLE_CANDIDATE_RESERVE", poolCase.reserve.length > 1);

  }

  const missing = capabilitiesFixture.requiredCapabilities
    .filter(capability => !detected.get(capability.id))
    .map(capability => capability.id);
  return {
    status: missing.length
      ? "MISSING_REQUIRED_CAPABILITY"
      : capabilitiesFixture.capabilityPolicy.requiredStatus,
    missing,
    detected: Object.fromEntries(detected)
  };
}

const capability = await detectCapabilities();
const missingCapabilityMessage = `Active candidate-pool behavior is missing: ${capability.missing.join(", ") || "none"}.`;

function requireCandidatePools() {
  assert.deepEqual(capability.missing, [], missingCapabilityMessage);
  assert.equal(capability.status, capabilitiesFixture.capabilityPolicy.requiredStatus);
  return true;
}

test("Task 14 active candidate-pool capabilities are all required", t => {
  assert.equal(capabilitiesFixture.schemaVersion, 1);
  assert.equal(capabilitiesFixture.authorship, "Handcrafted Task 14 capability and candidate-pool cases");
  assert.equal(capabilitiesFixture.capabilityPolicy.missingCapabilityBehavior, "FAIL");
  assert.equal(capability.status, "ACTIVE");
  assert.deepEqual(capability.missing, []);
  assert.deepEqual(
    Object.keys(capability.detected).sort(),
    capabilitiesFixture.requiredCapabilities.map(item => item.id).sort()
  );
  t.diagnostic(JSON.stringify({ task: 14, capability }));
});

test("one strategy retains multiple exact-unique, valid, independently audited candidates", t => {
  if (!requireCandidatePools(t)) return;
  const expectation = capabilitiesFixture.expectations.multipleCandidatePool;
  const result = buildStrategy(expectation.profileId, expectation.variantId, {
    planningMode: "graduation_priority",
    candidateLimit: 12
  });
  const pool = result.selected.candidatePool;
  assert.ok(result.reserve.length >= expectation.minimumRetainedDistinctSchedules);
  assert.equal(result.reserve.length, pool.retainedDistinctSchedules);
  assert.ok(pool.semanticDuplicatesRemoved >= expectation.minimumSemanticDuplicatesRemoved);
  assert.equal(pool.complete, true);
  assert.equal(pool.terminationReason, expectation.searchTerminationReason);
  assert.ok(result.reserve.every(candidate => candidate.validation.valid));
  for (const candidate of result.reserve) assertPassesIndependentOracle(result.student, candidate);
  t.diagnostic(JSON.stringify({
    profile: expectation.profileId,
    retained: result.reserve.length,
    finalValid: pool.finalValidSchedules,
    semanticDuplicatesRemoved: pool.semanticDuplicatesRemoved,
    nodesVisited: pool.nodesVisited
  }));
});

test("an invalid first candidate is rejected while a later valid candidate remains selectable", async t => {
  if (!requireCandidatePools(t)) return;
  const result = buildStrategy("verified-five-remaining", "balanced", {
    planningMode: "graduation_priority",
    candidateLimit: 12
  });
  assert.ok(result.reserve.length >= 2);
  const invalidFirst = mutateElectiveToEco257(result.reserve[0]);
  const validLater = result.reserve[1];
  const candidates = [invalidFirst, validLater];
  const validations = candidates.map(candidate => validateCandidate(result, candidate));
  const retained = candidates.filter((_candidate, index) => validations[index].valid);

  assert.equal(validations[0].valid, false);
  assert.equal(validations[1].valid, true);
  assert.deepEqual(retained, [validLater]);
  assert.equal(retained.some(candidate => candidate === invalidFirst), false);
  assertPassesIndependentOracle(result.student, validLater);

  const source = await readFile(new URL("../lib/planning/economics.js", import.meta.url), "utf8");
  const materializedAt = source.indexOf("let materialized = rawSolutions.map");
  const validationGateAt = source.indexOf("if (!candidate.validation.valid) continue;", materializedAt);
  const exactDedupAt = source.indexOf("const signature = planSignature(candidate);", validationGateAt);
  const semanticDedupAt = source.indexOf("const semanticGroups = new Map();", exactDedupAt);
  const rankingAt = source.indexOf("const rankedCandidates = [...semanticGroups.values()]", semanticDedupAt);
  assert.ok(materializedAt >= 0 && validationGateAt > materializedAt);
  assert.ok(exactDedupAt > validationGateAt);
  assert.ok(semanticDedupAt > exactDedupAt);
  assert.ok(rankingAt > semanticDedupAt);
});

test("the best valid candidate is rank one and no invalid candidate enters the reserve", t => {
  if (!requireCandidatePools(t)) return;
  const result = buildStrategy("verified-five-remaining", "balanced", {
    planningMode: "graduation_priority",
    candidateLimit: 12
  });
  assert.equal(result.selected, result.reserve[0]);
  assert.ok(result.reserve.length >= 3 && result.reserve.length <= 12);
  assert.deepEqual(
    result.reserve.map(candidate => candidate.candidateRank),
    Array.from({ length: result.reserve.length }, (_item, index) => index + 1)
  );
  assert.ok(result.reserve.every(candidate => candidate.validation.valid));
  assert.ok(result.reserve.every(candidate => !flatCourses(candidate).some(course => (
    course.course === "ECO 257" && String(course.requirementId).startsWith("eco-elective")
  ))));
});

test("a retained candidate reserve stays independently valid", t => {
  if (!requireCandidatePools(t)) return;
  const result = buildStrategy("safe-reserve-two-remaining", "balanced");
  assert.ok(result.reserve.length > 0);
  for (const candidate of result.reserve) assertPassesIndependentOracle(result.student, candidate);
});

test("ungoverned schedule mutations cannot force a reserve substitution", t => {
  if (!requireCandidatePools(t)) return;
  const expectation = capabilitiesFixture.expectations.unsafeReserve;
  const schedule = closeMayOfferings(productionSchedule);
  const baseline = buildBundle(expectation.profileId).bundle;
  const mutated = buildBundle(expectation.profileId, { schedule }).bundle;
  assert.deepEqual(mutated.plans.map(economicsModule.semanticPlanSignature), baseline.plans.map(economicsModule.semanticPlanSignature));
  assert.deepEqual(mutated.candidateOutcomes, baseline.candidateOutcomes);
});

test("generic elective-slot swaps are treated as the same material plan", t => {
  if (!requireCandidatePools(t)) return;
  const result = buildStrategy("verified-five-remaining", "balanced", {
    planningMode: "graduation_priority"
  });
  const original = result.reserve[0];
  const exactClone = structuredClone(original);
  exactClone.label = "Exact clone";
  const exactSet = economicsModule.validatePlanSet([original, exactClone]);
  assert.equal(exactSet.valid, false);
  assert.equal(exactSet.uniquePlanCount, 1);
  assert.equal(exactSet.pairwise[0].different, false);

  const semanticClone = structuredClone(original);
  semanticClone.label = "Elective slots exchanged";
  const electives = flatCourses(semanticClone).filter(course => (
    String(course.requirementId || "").startsWith("eco-elective")
  ));
  assert.ok(electives.length >= 2);
  [electives[0].requirementId, electives[1].requirementId] = [
    electives[1].requirementId,
    electives[0].requirementId
  ];
  const exactComparison = economicsModule.validatePlanSet([original, semanticClone]);
  assert.equal(exactComparison.valid, false);
  assert.equal(exactComparison.uniquePlanCount, 1);
  assert.equal(exactComparison.pairwise[0].different, false);
  assert.equal(
    economicsModule.semanticPlanSignature(original),
    economicsModule.semanticPlanSignature(semanticClone)
  );
  assert.ok(result.selected.candidatePool.semanticDuplicatesRemoved >= 0);
});

test("a standing with one applicable strategy does not invent a strategy convergence", t => {
  if (!requireCandidatePools(t)) return;
  const expectation = capabilitiesFixture.expectations.trueConvergence;
  const { student, bundle } = buildBundle(expectation.profileId);
  const balanced = bundle.candidateOutcomes.find(outcome => outcome.id === "balanced");
  assert.equal(balanced.candidatePool.complete, true);
  assert.equal(balanced.candidatePool.retainedDistinctSchedules, 1);
  assert.equal(bundle.convergences.length, 0);
  assert.equal(bundle.plans.length, 1);
  assertPassesIndependentOracle(student, bundle.plans[0]);
});

test("a budget-limited search reports SEARCH_INCOMPLETE, not infeasible or converged", t => {
  if (!requireCandidatePools(t)) return;
  const expectation = capabilitiesFixture.expectations.searchIncomplete;
  const complete = buildBundle(expectation.profileId);
  assert.ok(complete.bundle.candidateOutcomes.every(outcome => outcome.candidatePool.complete));
  assert.ok(complete.bundle.plans.length > 0);

  const limited = buildBundle(expectation.profileId, { nodeLimit: expectation.nodeLimit });
  assert.equal(limited.bundle.plans.length, 0);
  assert.equal(limited.bundle.convergences.length, 0);
  for (const outcome of limited.bundle.candidateOutcomes) {
    assert.equal(outcome.status, expectation.status);
    assert.equal(outcome.candidatePool.complete, false);
    assert.equal(outcome.candidatePool.terminationReason, expectation.terminationReason);
    assert.equal(outcome.suppressionReason.code, expectation.status);
    assert.notEqual(outcome.suppressionReason.code, "NOT_FEASIBLE");
    assert.notEqual(outcome.suppressionReason.code, "SEMANTIC_CONVERGENCE");
  }
});

test("suppression reasons and reserve ordering are stable across repeated runs", t => {
  if (!requireCandidatePools(t)) return;
  const first = buildBundle("safe-reserve-two-remaining").bundle;
  const second = buildBundle("safe-reserve-two-remaining").bundle;
  assert.deepEqual(first.candidateOutcomes, second.candidateOutcomes);
  assert.deepEqual(first.convergences, second.convergences);

  const firstReserve = buildStrategy("verified-five-remaining", "balanced", {
    planningMode: "graduation_priority"
  }).reserve.map(candidate => ({
    rank: candidate.candidateRank,
    signature: economicsModule.semanticPlanSignature(candidate)
  }));
  const secondReserve = buildStrategy("verified-five-remaining", "balanced", {
    planningMode: "graduation_priority"
  }).reserve.map(candidate => ({
    rank: candidate.candidateRank,
    signature: economicsModule.semanticPlanSignature(candidate)
  }));
  assert.deepEqual(firstReserve, secondReserve);
});

test("ECO 257 is filtered before elective candidates can enter pools, ranking, or display", t => {
  if (!requireCandidatePools(t)) return;
  const expectation = capabilitiesFixture.expectations.eco257;
  const baseline = buildStrategy("verified-five-remaining", "balanced", {
    planningMode: "graduation_priority"
  });
  const temptedSchedule = injectEco257ElectiveTemptation(productionSchedule);
  const tempted = buildStrategy("verified-five-remaining", "balanced", {
    schedule: temptedSchedule,
    planningMode: "graduation_priority"
  });
  const temptedBundle = buildBundle("verified-five-remaining", { schedule: temptedSchedule });

  const baselineSignatures = baseline.reserve.map(economicsModule.semanticPlanSignature);
  const temptedSignatures = tempted.reserve.map(economicsModule.semanticPlanSignature);
  assert.deepEqual(temptedSignatures, baselineSignatures);
  assert.equal(
    tempted.selected.candidatePool.completeSchedulesExamined,
    baseline.selected.candidatePool.completeSchedulesExamined
  );
  assert.equal(
    tempted.selected.candidatePool.finalValidSchedules,
    baseline.selected.candidatePool.finalValidSchedules
  );
  for (const plan of [...tempted.reserve, ...temptedBundle.bundle.plans]) {
    for (const course of flatCourses(plan)) {
      if (course.course === "ECO 257") {
        assert.equal(course.requirementId, expectation.allowedRequirementId);
      }
      assert.equal(
        course.course === "ECO 257" && String(course.requirementId).startsWith(expectation.prohibitedRequirementPrefix),
        false
      );
    }
    assertPassesIndependentOracle(tempted.student, plan);
  }

  const invalid = mutateElectiveToEco257(baseline.reserve[0]);
  const productionValidation = validateCandidate(baseline, invalid);
  const oracleAudit = auditPlan(baseline.student, invalid);
  assert.equal(productionValidation.valid, false);
  assert.ok(productionValidation.errors.some(error => (
    /ECO 257 is not a valid course for requirement eco-elective/.test(error)
  )));
  assert.ok(oracleAudit.violations.some(violation => violation.ruleId === expectation.oracleRuleId));
  assert.equal(invalid.candidateRank, undefined);
  assert.equal(invalid.strategyScore, undefined);
  assert.equal(invalid.safetyScore, undefined);
});
