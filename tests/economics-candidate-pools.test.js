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

function buildBundle(profileId, { schedule = productionSchedule, nodeLimit } = {}) {
  const student = studentFor(profileId);
  const mapping = mappingFor(student);
  const bundle = economicsModule.buildEconomicsTermPlans({
    student,
    mapping,
    schedule,
    prerequisites: productionPrerequisites,
    ...(Number.isInteger(nodeLimit) ? { nodeLimit } : {})
  });
  return { student, mapping, bundle };
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
  const type = ruleId === "CONCURRENT-INTERMEDIATE-ECO-461"
    ? "DEPARTMENT_APPROVAL"
    : "INSTRUCTOR_APPROVAL";
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
        courses: term.courses.map(course => oracleCourse(plan, term, course))
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

function strategyTopSignature(profileId, variantId, options = {}) {
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
  detected.set("RESERVE_SUBSTITUTION", false);

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

    const reserveCase = buildBundle(capabilitiesFixture.expectations.safeReserveSubstitution.profileId);
    detected.set("RESERVE_SUBSTITUTION", reserveCase.bundle.candidateOutcomes.some(outcome => (
      outcome.substitutionReason === "NEXT_DISTINCT_RESERVE"
    )));
  }

  const missing = capabilitiesFixture.requiredCapabilities
    .filter(capability => !detected.get(capability.id))
    .map(capability => capability.id);
  return {
    status: missing.length
      ? capabilitiesFixture.capabilityPolicy.unavailableStatus
      : capabilitiesFixture.capabilityPolicy.availableStatus,
    missing,
    detected: Object.fromEntries(detected)
  };
}

const capability = await detectCapabilities();
const featureGateMessage = `${capabilitiesFixture.capabilityPolicy.unavailableStatus}: ${capabilitiesFixture.capabilityPolicy.unavailableExplanation} Missing: ${capability.missing.join(", ") || "none"}.`;

function requireCandidatePools(t) {
  if (capability.status === capabilitiesFixture.capabilityPolicy.availableStatus) return true;
  t.skip(featureGateMessage);
  return false;
}

test("Task 14 candidate-pool capability is detected or explicitly feature-gated", t => {
  assert.equal(capabilitiesFixture.schemaVersion, 1);
  assert.equal(capabilitiesFixture.authorship, "Handcrafted Task 14 capability and candidate-pool cases");
  assert.ok(["ACTIVE", "FEATURE_GATED"].includes(capability.status));
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
  const result = buildStrategy("verified-five-remaining", "plan-1", {
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
  const materializedAt = source.indexOf("const materialized = rawSolutions.map");
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
  const result = buildStrategy("verified-five-remaining", "plan-1", {
    planningMode: "graduation_priority",
    candidateLimit: 12
  });
  assert.equal(result.selected, result.reserve[0]);
  assert.deepEqual(result.reserve.map(candidate => candidate.candidateRank), [1, 2, 3]);
  assert.ok(result.reserve.every(candidate => candidate.validation.valid));
  assert.ok(result.reserve.every(candidate => !flatCourses(candidate).some(course => (
    course.course === "ECO 257" && String(course.requirementId).startsWith("eco-elective")
  ))));
});

test("Plan A and Plan B share a top schedule, then Plan B uses its safe distinct reserve", t => {
  if (!requireCandidatePools(t)) return;
  const expectation = capabilitiesFixture.expectations.safeReserveSubstitution;
  const [planAId, planBId] = expectation.topStrategies;
  const planA = strategyTopSignature(expectation.profileId, planAId);
  const planB = strategyTopSignature(expectation.profileId, planBId);
  assert.equal(planA.signature, planB.signature);
  assert.ok(planB.reserve.length > 1);
  for (const candidate of [...planA.reserve, ...planB.reserve]) {
    assertPassesIndependentOracle(planA.student, candidate);
  }

  const { student, bundle } = buildBundle(expectation.profileId);
  const planBOutcome = bundle.candidateOutcomes.find(outcome => outcome.id === expectation.substitutedStrategy);
  assert.ok(planBOutcome);
  assert.equal(planBOutcome.substitutionReason, expectation.substitutionReason);
  assert.equal(planBOutcome.selectedCandidateRank, expectation.selectedCandidateRank);
  assert.equal(bundle.convergences.length, 0);

  const substitute = planB.reserve[expectation.selectedCandidateRank - 1];
  assert.notEqual(economicsModule.semanticPlanSignature(substitute), planA.signature);
  assert.ok(substitute.safetyScore.approvalWeight <= planB.reserve[0].safetyScore.approvalWeight);
  assert.ok(substitute.safetyScore.conditionCount <= planB.reserve[0].safetyScore.conditionCount);
  assert.ok(substitute.safetyScore.maxEco <= planB.reserve[0].safetyScore.maxEco);
  assert.ok(substitute.safetyScore.loadSquares <= planB.reserve[0].safetyScore.loadSquares);
  assertPassesIndependentOracle(student, substitute);
});

test("an unsafe or materially worse reserve is not used merely for visual variety", t => {
  if (!requireCandidatePools(t)) return;
  const expectation = capabilitiesFixture.expectations.unsafeReserve;
  const schedule = closeMayOfferings(productionSchedule);
  const planA = strategyTopSignature(expectation.profileId, "plan-1", { schedule });
  const planB = strategyTopSignature(expectation.profileId, "plan-2", { schedule });
  assert.equal(planA.signature, planB.signature);
  assert.ok(planB.reserve.length > 1);
  for (const candidate of [...planA.reserve, ...planB.reserve]) {
    assertPassesIndependentOracle(planA.student, candidate);
  }
  const materiallyWorse = planB.reserve[1];
  assert.ok(
    materiallyWorse.safetyScore.approvalWeight > planB.reserve[0].safetyScore.approvalWeight
      || materiallyWorse.safetyScore.conditionCount > planB.reserve[0].safetyScore.conditionCount
      || materiallyWorse.safetyScore.maxEco > planB.reserve[0].safetyScore.maxEco
      || materiallyWorse.safetyScore.loadSquares > planB.reserve[0].safetyScore.loadSquares
  );

  const { bundle } = buildBundle(expectation.profileId, { schedule });
  const planBOutcome = bundle.candidateOutcomes.find(outcome => outcome.id === "plan-2");
  assert.equal(planBOutcome.substitutionReason, null);
  assert.equal(planBOutcome.selectedCandidateRank, null);
  assert.equal(planBOutcome.suppressionReason.code, expectation.suppressionCode);
  assert.ok(bundle.convergences.some(item => item.convergedPlanId === "plan-2"));
});

test("exact duplicates and semantic elective-slot duplicates are distinguished", t => {
  if (!requireCandidatePools(t)) return;
  const result = buildStrategy("verified-five-remaining", "plan-1", {
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
  assert.equal(exactComparison.valid, true);
  assert.equal(exactComparison.uniquePlanCount, 2);
  assert.equal(
    economicsModule.semanticPlanSignature(original),
    economicsModule.semanticPlanSignature(semanticClone)
  );
  assert.ok(result.selected.candidatePool.semanticDuplicatesRemoved > 0);
});

test("true convergence is reported only after a complete search finds no meaningful distinct candidate", t => {
  if (!requireCandidatePools(t)) return;
  const expectation = capabilitiesFixture.expectations.trueConvergence;
  const { student, bundle } = buildBundle(expectation.profileId);
  const planA = bundle.candidateOutcomes.find(outcome => outcome.id === "plan-1");
  const planB = bundle.candidateOutcomes.find(outcome => outcome.id === "plan-2");
  assert.equal(planA.candidatePool.complete, true);
  assert.equal(planB.candidatePool.complete, true);
  assert.equal(planA.candidatePool.retainedDistinctSchedules, 1);
  assert.equal(planB.candidatePool.retainedDistinctSchedules, 1);
  assert.equal(planB.suppressionReason.code, expectation.suppressionCode);
  assert.ok(bundle.convergences.some(item => item.code === expectation.convergenceCode));
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

  const firstReserve = buildStrategy("verified-five-remaining", "plan-1", {
    planningMode: "graduation_priority"
  }).reserve.map(candidate => ({
    rank: candidate.candidateRank,
    signature: economicsModule.semanticPlanSignature(candidate)
  }));
  const secondReserve = buildStrategy("verified-five-remaining", "plan-1", {
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
  const baseline = buildStrategy("verified-five-remaining", "plan-1", {
    planningMode: "graduation_priority"
  });
  const temptedSchedule = injectEco257ElectiveTemptation(productionSchedule);
  const tempted = buildStrategy("verified-five-remaining", "plan-1", {
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
