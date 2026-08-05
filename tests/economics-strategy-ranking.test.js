import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import {
  buildEconomicsTermPlan,
  buildEconomicsTermPlans,
  compareEconomicsPlans,
  EARLY_GRADUATION_VARIANT,
  PLAN_VARIANTS,
  semanticPlanSignature,
  validateGeneratedPlan
} from "../lib/planning/economics.js";
import {
  PLANNING_PACES,
  PROJECTED_SENIOR_STANDING_CONFIRMATION_STATUS,
  resolvePlanningContext
} from "../lib/planning/horizon.js";
import { auditExternalEconomicsPlanComplete } from "./oracle/audit-external-plan.js";

const fixture = JSON.parse(await readFile(
  new URL("./fixtures/economics-ranking-cases.v1.json", import.meta.url),
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
const variantsById = new Map([...PLAN_VARIANTS, EARLY_GRADUATION_VARIANT].map(variant => [variant.id, variant]));
const profilesById = new Map(fixture.profiles.map(profile => [profile.id, profile]));
const bundleCache = new Map();

const APPROVAL_RULES = Object.freeze({
  CONCURRENT_INTERMEDIATE_DEPARTMENT_APPROVAL: "CONCURRENT-INTERMEDIATE-ECO-461",
  "CONCURRENT-MATH-ECO-213": "CONCURRENT-MATH-ECO-213",
  "CONCURRENT-MATH-ECO-214": "CONCURRENT-MATH-ECO-214"
});
const APPROVAL_TYPES = Object.freeze({
  "CONCURRENT-INTERMEDIATE-ECO-461": "DEPARTMENT_APPROVAL",
  "CONCURRENT-MATH-ECO-213": "INSTRUCTOR_APPROVAL",
  "CONCURRENT-MATH-ECO-214": "INSTRUCTOR_APPROVAL"
});

function profileStudent(profileId) {
  const profile = profilesById.get(profileId);
  assert.ok(profile, `Missing ranking profile ${profileId}.`);
  return structuredClone(profile.student);
}

function mappingFor(student) {
  return mapStudentToProgram(ECONOMICS_PROGRAM, productionRequirements, student);
}

function bundleFor(profileId) {
  if (bundleCache.has(profileId)) return bundleCache.get(profileId);
  const student = profileStudent(profileId);
  const mapping = mappingFor(student);
  const bundle = buildEconomicsTermPlans({
    student,
    mapping,
    schedule: productionSchedule,
    prerequisites: productionPrerequisites
  });
  const value = { student, mapping, bundle };
  bundleCache.set(profileId, value);
  return value;
}

function strategyResult(profileId, variantId, {
  allowConcurrentMath = false,
  candidateLimit = 12,
  planningMode = null,
  schedule = productionSchedule
} = {}) {
  let student = profileStudent(profileId);
  const variant = variantsById.get(variantId);
  assert.ok(variant, `Unknown plan variant ${variantId}.`);
  if (variantId === EARLY_GRADUATION_VARIANT.id) {
    const normalContext = resolvePlanningContext(student);
    const expectedGraduationYear = normalContext.expectedGraduationYear - 1;
    student = {
      ...student,
      planningPace: PLANNING_PACES.EARLY,
      projectedSeniorStandingConfirmation: {
        status: PROJECTED_SENIOR_STANDING_CONFIRMATION_STATUS,
        academicYear: `${expectedGraduationYear - 1}/${expectedGraduationYear}`
      }
    };
  }
  const mapping = mappingFor(student);
  const planningContext = resolvePlanningContext(student);
  assert.ok(planningContext, `${profileId}/${variantId} has no planning context.`);
  const selected = buildEconomicsTermPlan({
    student,
    mapping,
    schedule,
    prerequisites: productionPrerequisites,
    planningContext,
    planVariant: variant,
    allowConcurrentMath,
    planningMode: planningMode || (
      variantId === EARLY_GRADUATION_VARIANT.id || student.academicStanding === "senior"
        ? "graduation_priority"
        : "standard"
    ),
    candidateLimit
  });
  return { student, mapping, selected, reserve: selected?._candidateReserve || [] };
}

function annualLoads(plan) {
  const years = Number(plan?.planningContext?.remainingYears || 0);
  return Array.from({ length: years }, (_item, yearIndex) => (
    (plan?.terms || [])
      .filter(term => term.yearIndex === yearIndex)
      .reduce((sum, term) => sum + (term.courses || []).length, 0)
  ));
}

function termLoads(plan, yearIndex = 0) {
  return ["Fall", "Winter", "Spring"].map(termKey => (
    plan.terms.find(term => term.yearIndex === yearIndex && term.termKey === termKey)?.courses.length || 0
  ));
}

function maxRegularTermLoad(plan) {
  return Math.max(0, ...(plan.terms || [])
    .filter(term => ["Fall", "Winter", "Spring", "May"].includes(term.termKey))
    .map(term => term.courses.length));
}

function maxEconomicsLoad(plan) {
  return Math.max(0, ...(plan.terms || []).map(term => (
    term.courses.filter(course => /^ECO /.test(course.course)).length
  )));
}

function loadSquares(plan) {
  return (plan.terms || [])
    .filter(term => ["Fall", "Winter", "Spring", "May"].includes(term.termKey))
    .reduce((sum, term) => sum + term.courses.length ** 2, 0);
}

function fallWinterImbalance(plan, yearIndex = 0) {
  const [fall, winter] = termLoads(plan, yearIndex);
  return Math.abs(fall - winter);
}

function approvalWeight(plan) {
  return (plan.feasibility?.requiredApprovals || []).reduce((sum, approval) => (
    sum + (approval.type === "department" ? 2 : 1)
  ), 0);
}

function objectiveFacts(plan) {
  const courses = plan.terms.flatMap(term => term.courses || []);
  return {
    maxTermLoad: maxRegularTermLoad(plan),
    maxEconomicsLoad: maxEconomicsLoad(plan),
    verifiedCount: courses.filter(course => ["verified-offering", "summer-last-resort"].includes(course.source)).length,
    approvalWeight: approvalWeight(plan),
    conditionCount: plan.feasibility?.enrollmentConditions?.length || 0,
    loadSquares: loadSquares(plan),
    termLoads: plan.terms.map(term => term.courses.length)
  };
}

function firstYearCourses(plan) {
  return plan.terms.filter(term => term.yearIndex === 0).flatMap(term => term.courses || []);
}

function coursePosition(plan, code) {
  const termIndex = plan.terms.findIndex(term => term.courses.some(course => course.course === code));
  return termIndex < 0 ? Number.POSITIVE_INFINITY : termIndex;
}

function statisticsPlacement(plan) {
  return plan.terms.flatMap((term, termIndex) => (
    term.courses.map(course => ({ term, termIndex, course }))
  )).find(item => (
    ["MAT 217", "ECO 257", "PSY 217", "Statistics requirement"].includes(item.course.course)
  )) || null;
}

function planWithTermLoads(reserve, loads) {
  const found = reserve.find(plan => (
    JSON.stringify(termLoads(plan)) === JSON.stringify(loads)
  ));
  assert.ok(found, `No retained candidate has term loads ${loads.join("/")}.`);
  return found;
}

function manifestRule(ruleId) {
  return [
    ...(oraclePolicy.concurrencyRules || []),
    ...(oraclePolicy.permissionRules || [])
  ].find(rule => rule.ruleId === ruleId);
}

function approvalRuleId(approval) {
  if (APPROVAL_RULES[approval.code]) return APPROVAL_RULES[approval.code];
  if (approval.code === "CONCURRENT_MATH_INSTRUCTOR_APPROVAL") {
    return approval.course === "ECO 213" ? "CONCURRENT-MATH-ECO-213" : "CONCURRENT-MATH-ECO-214";
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
    sourceRef: rule?.sourceRefs?.[0] || approval.sourceRef || null
  };
}

function hasStaleCondition(plan, course, term) {
  return (plan.feasibility?.enrollmentConditions || []).some(condition => (
    condition.type === "stale_availability"
    && condition.course === course.course
    && condition.term === term.term
  ));
}

function oracleCourse(plan, term, course) {
  const value = {
    ...course,
    canonicalCrossListIdentity: [course.course, ...(course.crossListedAs || [])],
    availability: {
      ...course.availability,
      ...(hasStaleCondition(plan, course, term) ? { freshness: "stale" } : {})
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

function externalStudent(student) {
  const completed = student.courses.filter(course => ["completed", "in_progress"].includes(course.status));
  return {
    academicStanding: student.academicStanding,
    completedCourses: completed.map(course => ({
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

function assertOracleOutcomeClassified(student, plan, verifiedSchedule = oracleSchedule) {
  const audit = auditPlan(student, plan, verifiedSchedule);
  const actualViolationCodes = [...new Set(audit.violations.map(violation => violation.code))].sort();
  const reviewCodes = audit.reviewItems
    .filter(item => item.code !== "RULE_FAMILY_NOT_CHECKED")
    .map(item => item.code);
  const allowedReviewCodes = new Set([
    "REVIEW-ADVANCED-COURSE-PREREQUISITE-CLOSURE",
    "REVIEW-ECO-335-MATH-EQUIVALENT",
    "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE"
  ]);
  assert.deepEqual(
    actualViolationCodes,
    [],
    `${plan.label || plan.id} produced an unclassified independent-oracle outcome: ${JSON.stringify(audit.violations)}`
  );
  assert.ok(
    reviewCodes.every(code => allowedReviewCodes.has(code)),
    `${plan.label || plan.id} produced an unclassified policy-review outcome: ${JSON.stringify(audit.reviewItems)}`
  );
  assert.equal(
    audit.valid,
    actualViolationCodes.length === 0 && reviewCodes.length === 0,
    `${plan.label || plan.id} independent-oracle validity did not match its classified findings.`
  );
  return audit;
}

function assertReserveAudited(result, verifiedSchedule = oracleSchedule) {
  assert.ok(result.reserve.length > 0, "Expected a retained candidate reserve.");
  for (const plan of result.reserve) assertOracleOutcomeClassified(result.student, plan, verifiedSchedule);
}

function availabilityScenario(definition) {
  const schedule = structuredClone(productionSchedule);
  const oracle = structuredClone(oracleSchedule);
  const productionRow = schedule.terms.Winter.find(row => row.course === fixture.commonSafetyCases.availabilityCourse);
  const oracleRow = oracle.sections.find(row => (
    row.term === "Winter" && row.course === fixture.commonSafetyCases.availabilityCourse
  ));
  assert.ok(productionRow && oracleRow, "The availability comparison requires the verified ECO 461 section.");
  productionRow.availability = {
    ...productionRow.availability,
    status: definition.status,
    rawStatus: definition.status,
    seatsOpen: definition.seatsOpen,
    asOf: definition.asOf
  };
  oracleRow.availability = {
    ...oracleRow.availability,
    state: definition.status,
    seatsOpen: definition.seatsOpen
  };
  return { schedule, oracle };
}

function planForAvailability(definition) {
  const scenario = availabilityScenario(definition);
  const result = strategyResult(
    fixture.commonSafetyCases.availabilityProfileId,
    "plan-1",
    { schedule: scenario.schedule, planningMode: "standard" }
  );
  assert.equal(result.selected.validation.valid, true);
  assertOracleOutcomeClassified(result.student, result.selected, scenario.oracle);
  return { ...result, ...scenario };
}

test("Task 13 fixture states objective facts instead of production score arrays", () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.authorship, "Handcrafted Task 13 comparisons");
  assert.equal(fixture.profiles.length, 7);
  assert.equal(JSON.stringify(fixture).includes("strategyScore"), false);
  assert.equal(fixture.commonSafetyCases.planAObservedOrderClassification, "QUESTIONABLE_CURRENT_BEHAVIOR");
});

test("Plan A keeps annual loads even and prefers lower Fall/Winter imbalance and concentration", () => {
  const definition = fixture.strategyCases.planA;
  const freshman = strategyResult(definition.profileId, "plan-1");
  assertReserveAudited(freshman);
  assert.deepEqual(annualLoads(freshman.selected), definition.expectedAnnualLoads);
  assert.equal(Math.max(...annualLoads(freshman.selected)) - Math.min(...annualLoads(freshman.selected)), 0);

  const senior = strategyResult(definition.seniorProfileId, "plan-1", {
    planningMode: "graduation_priority",
    candidateLimit: 20
  });
  assertReserveAudited(senior);
  const preferred = planWithTermLoads(senior.reserve, definition.preferredTermLoads);
  const concentrated = planWithTermLoads(senior.reserve, definition.concentratedTermLoads);
  assert.equal(annualLoads(preferred)[0], annualLoads(concentrated)[0]);
  assert.ok(fallWinterImbalance(preferred) < fallWinterImbalance(concentrated));
  assert.ok(maxRegularTermLoad(preferred) < maxRegularTermLoad(concentrated));
  assert.ok(preferred.candidateRank < concentrated.candidateRank);
});

test("Plan B starts lighter, increases gradually, avoids a spike, and does not invent an empty early year", () => {
  const definition = fixture.strategyCases.planB;
  const result = strategyResult(definition.profileId, "plan-2");
  assertReserveAudited(result);
  const loads = annualLoads(result.selected);
  assert.deepEqual(loads, definition.expectedAnnualLoads);
  assert.ok(loads[0] > 0);
  assert.ok(loads.every((load, index) => index === 0 || load >= loads[index - 1]));
  assert.ok(loads.slice(1).every((load, index) => (
    load - loads[index] <= definition.maximumAllowedAdjacentIncrease
  )));
  assert.ok(loads[0] < loads.at(-1));
});

test("Plan C uses standing-appropriate portable foundations and a safe prerequisite sequence without fast-tracking", () => {
  const definition = fixture.strategyCases.planC;
  const freshman = strategyResult(definition.freshmanProfileId, "plan-3");
  assertReserveAudited(freshman);
  const freshmanFirstYear = firstYearCourses(freshman.selected);
  for (const code of definition.freshmanRequiredFirstYear) {
    assert.ok(freshmanFirstYear.some(course => course.course === code), `Freshman Plan C is missing ${code}.`);
  }
  assert.ok(freshmanFirstYear.some(course => definition.portableOptions.includes(course.course)));
  assert.equal(freshman.selected.isEarlyGraduation, false);
  assert.equal(freshman.selected.planningContext.expectedGraduationTerm, "Spring/May 2030");

  for (const [profileId, required] of [
    [definition.sophomore113ProfileId, definition.sophomore113RequiredFirstYear],
    [definition.sophomore114ProfileId, definition.sophomore114RequiredFirstYear]
  ]) {
    const sophomore = strategyResult(profileId, "plan-3");
    assertReserveAudited(sophomore);
    const courses = firstYearCourses(sophomore.selected);
    for (const code of required) {
      assert.ok(courses.some(course => course.course === code), `${profileId} is missing ${code}.`);
    }
    const statistics = statisticsPlacement(sophomore.selected);
    assert.ok(statistics && definition.statisticsOptions.includes(statistics.course.course));
    assert.ok(statistics.termIndex < coursePosition(sophomore.selected, "ECO 461"));
    assert.equal(courses.some(course => String(course.requirementId).startsWith("eco-elective")), false);
    assert.equal(sophomore.selected.isEarlyGraduation, false);
    assert.equal(sophomore.selected.planningContext.expectedGraduationTerm, "Spring/May 2029");
    if (statistics.course.source === "requirement-placeholder") {
      assert.equal(sophomore.selected.feasibilityStatus, "PRELIMINARY_ONLY");
      assert.ok(sophomore.selected.validation.warnings.some(warning => /Schedule confirmation required/.test(warning)));
    }
  }

  for (const standing of definition.excludedStandings) {
    const profileId = standing === "junior"
      ? fixture.strategyCases.planC2.approvalComparisonProfileId
      : definition.seniorProfileId || fixture.strategyCases.planA.seniorProfileId;
    const { bundle } = bundleFor(profileId);
    assert.equal(bundle.candidateOutcomes.some(outcome => outcome.id === "plan-3"), false);
  }
});

test("Plan C-2 keeps the shortened horizon and ranks policy-valid reserves by load and approvals", () => {
  const definition = fixture.strategyCases.planC2;
  const result = strategyResult(definition.profileId, "plan-c2", { candidateLimit: 100 });
  assertReserveAudited(result);
  assert.equal(result.selected.isEarlyGraduation, true);
  assert.equal(result.selected.planningContext.remainingYears, definition.expectedRemainingYears);
  assert.equal(result.selected.planningContext.expectedGraduationTerm, definition.expectedGraduationTerm);
  assert.ok(result.selected.terms.every(term => term.yearIndex < definition.expectedRemainingYears));

  const heavier = result.reserve.find(plan => maxRegularTermLoad(plan) > maxRegularTermLoad(result.selected));
  assert.ok(heavier, "The handcrafted C-2 pool must contain a higher-load comparison.");
  assert.ok(result.selected.candidateRank < heavier.candidateRank);
  assertOracleOutcomeClassified(result.student, heavier);

  const retained = [result.selected, ...result.reserve];
  assert.ok(retained.every(plan => objectiveFacts(plan).verifiedCount === objectiveFacts(result.selected).verifiedCount));
  assert.ok(retained.every(plan => plan.terms.every(term => (
    term.academicYear !== productionSchedule.academicYear
    || term.courses.every(course => (
      course.course !== "ECO elective"
      && !(course.course === "BUSN 323" && course.source === "requirement-placeholder")
    ))
  ))), "The C-2 pool must not retain the former invalid verified-year placeholder tie.");

  // The corrected C-2 pool has one policy-valid semantic schedule for this
  // profile. Plan B retains the same student's independently valid, isolated
  // approval-weight comparison without reintroducing the forbidden placeholder.
  const approvalResult = strategyResult(definition.approvalComparisonProfileId, "plan-2", {
    allowConcurrentMath: true,
    candidateLimit: 100
  });
  assertReserveAudited(approvalResult);
  let approvalPair = null;
  for (const lower of approvalResult.reserve) {
    for (const higher of approvalResult.reserve) {
      const left = objectiveFacts(lower);
      const right = objectiveFacts(higher);
      if (left.approvalWeight >= right.approvalWeight) continue;
      if (left.maxTermLoad !== right.maxTermLoad
        || left.maxEconomicsLoad !== right.maxEconomicsLoad
        || left.verifiedCount !== right.verifiedCount
        || left.conditionCount !== right.conditionCount
        || left.loadSquares !== right.loadSquares
        || JSON.stringify(left.termLoads) !== JSON.stringify(right.termLoads)) continue;
      approvalPair = { lower, higher };
      break;
    }
    if (approvalPair) break;
  }
  assert.ok(approvalPair, "The C-2 pool must isolate approval weight while other ranking facts tie.");
  assert.ok(approvalPair.lower.candidateRank < approvalPair.higher.candidateRank);
  assert.ok(compareEconomicsPlans(approvalPair.lower, approvalPair.higher) < 0);
});

test("current verified and open availability ranks above waitlisted or stale availability", () => {
  const definitions = new Map(fixture.commonSafetyCases.availabilityVariants.map(item => [item.id, item]));
  const open = planForAvailability(definitions.get("open-current"));
  const waitlisted = planForAvailability(definitions.get("waitlisted-current"));
  const stale = planForAvailability(definitions.get("open-stale"));

  assert.equal(open.selected.feasibilityStatus, "VERIFIED_FEASIBLE");
  assert.equal(waitlisted.selected.feasibilityStatus, "CONDITIONALLY_FEASIBLE");
  assert.equal(stale.selected.feasibilityStatus, "CONDITIONALLY_FEASIBLE");
  assert.ok(compareEconomicsPlans(open.selected, waitlisted.selected) < 0);
  assert.ok(compareEconomicsPlans(open.selected, stale.selected) < 0);
  assert.ok(waitlisted.selected.feasibility.enrollmentConditions.some(condition => condition.type === "waitlist"));
  assert.ok(stale.selected.feasibility.enrollmentConditions.some(condition => condition.type === "stale_availability"));
});

test("meeting conflicts are validity failures and cannot become ranked alternatives", () => {
  const result = strategyResult(fixture.strategyCases.planA.seniorProfileId, "plan-1", {
    planningMode: "graduation_priority",
    candidateLimit: 20
  });
  const valid = structuredClone(result.selected);
  const corrupted = structuredClone(result.selected);
  const winter = corrupted.terms.find(term => term.termKey === "Winter");
  const eco221 = winter.courses.find(course => course.course === "ECO 221");
  const eco461 = winter.courses.find(course => course.course === "ECO 461");
  assert.ok(eco221 && eco461);
  eco221.meeting = structuredClone(eco461.meeting);

  const production = validateGeneratedPlan(corrupted, {
    student: result.student,
    mapping: result.mapping,
    schedule: productionSchedule,
    prerequisites: productionPrerequisites,
    context: corrupted.planningContext
  });
  const oracle = auditPlan(result.student, corrupted);
  assert.equal(valid.validation.valid, true);
  assert.equal(production.valid, false);
  assert.ok(production.errors.some(error => /meeting/.test(error)));
  assert.ok(oracle.violations.some(violation => /MEETING/.test(violation.code)));
  assert.ok(result.reserve.every(plan => plan.validation.valid));
});

test("senior ranking and standing-specific display limits are deterministic", () => {
  const limits = fixture.displayLimits;
  const cases = [
    ["freshman", fixture.strategyCases.planA.profileId],
    ["sophomore", fixture.strategyCases.planC.sophomore113ProfileId],
    ["junior", fixture.strategyCases.planC2.approvalComparisonProfileId],
    ["senior", fixture.strategyCases.planA.seniorProfileId]
  ];
  for (const [standing, profileId] of cases) {
    const { student, bundle } = bundleFor(profileId);
    assert.ok(bundle.plans.length > 0 && bundle.plans.length <= limits[standing]);
    if (standing === "senior") assert.equal(bundle.plans.length, 1);
    for (const plan of bundle.plans) assertOracleOutcomeClassified(student, plan);
  }

  const seniorBundle = bundleFor(fixture.strategyCases.planA.seniorProfileId).bundle;
  assert.deepEqual(termLoads(seniorBundle.plans[0]), fixture.strategyCases.planA.preferredTermLoads);

  const seniorReserve = strategyResult(fixture.commonSafetyCases.seniorBalanceProfileId, "plan-1", {
    planningMode: "graduation_priority",
    candidateLimit: 20
  });
  const balanced = planWithTermLoads(seniorReserve.reserve, fixture.commonSafetyCases.balancedTermLoads);
  const concentrated = planWithTermLoads(
    seniorReserve.reserve,
    fixture.commonSafetyCases.unnecessaryConcentrationTermLoads
  );
  assertOracleOutcomeClassified(seniorReserve.student, balanced);
  assertOracleOutcomeClassified(seniorReserve.student, concentrated);
  assert.equal(objectiveFacts(balanced).verifiedCount, objectiveFacts(concentrated).verifiedCount);
  assert.equal(approvalWeight(balanced), approvalWeight(concentrated));
  assert.equal(objectiveFacts(balanced).conditionCount, objectiveFacts(concentrated).conditionCount);
  assert.equal(maxEconomicsLoad(balanced), maxEconomicsLoad(concentrated));
  assert.ok(compareEconomicsPlans(balanced, concentrated) < 0);

  assert.ok(concentrated.candidateRank < balanced.candidateRank);
  assert.deepEqual(fixture.commonSafetyCases.planAObservedOrder, ["4/3/0", "4/2/1"]);
  assert.deepEqual(fixture.commonSafetyCases.seniorSafetyPreferredOrder, ["4/2/1", "4/3/0"]);

  const first = strategyResult(fixture.strategyCases.planA.profileId, "plan-2");
  const second = strategyResult(fixture.strategyCases.planA.profileId, "plan-2");
  assert.deepEqual(
    first.reserve.map(plan => ({ rank: plan.candidateRank, signature: semanticPlanSignature(plan) })),
    second.reserve.map(plan => ({ rank: plan.candidateRank, signature: semanticPlanSignature(plan) }))
  );
});

test("ECO 257 elective candidates are academically invalid before any strategy may rank them", () => {
  const strategyRuns = [
    strategyResult(fixture.strategyCases.planA.profileId, "plan-1"),
    strategyResult(fixture.strategyCases.planB.profileId, "plan-2"),
    strategyResult(fixture.strategyCases.planC.freshmanProfileId, "plan-3"),
    strategyResult(fixture.strategyCases.planC2.profileId, "plan-c2", { candidateLimit: 100 })
  ];
  for (const result of strategyRuns) {
    assertReserveAudited(result);
    for (const plan of result.reserve) {
      for (const course of plan.terms.flatMap(term => term.courses)) {
        if (course.course === "ECO 257") assert.equal(course.requirementId, "statistics");
      }
    }
  }

  const senior = strategyResult(fixture.strategyCases.planA.seniorProfileId, "plan-1", {
    planningMode: "graduation_priority",
    candidateLimit: 20
  });
  for (const definition of fixture.eco257ValidityCases) {
    const source = senior.reserve.find(plan => (
      plan.terms.some(term => term.courses.some(course => (
        course.requirementId === "statistics"
        && (
          course.course === definition.statisticsCourse
          || (
            course.course === "Statistics requirement"
            && course.options?.includes(definition.statisticsCourse)
          )
        )
      )))
    ));
    assert.ok(source, `${definition.id} lacks its valid statistics baseline.`);
    assertOracleOutcomeClassified(senior.student, source);
    const invalid = structuredClone(source);
    const elective = invalid.terms
      .flatMap(term => term.courses)
      .find(course => String(course.requirementId).startsWith("eco-elective"));
    assert.ok(elective, `${definition.id} lacks an elective to mutate.`);
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

    const production = validateGeneratedPlan(invalid, {
      student: senior.student,
      mapping: senior.mapping,
      schedule: productionSchedule,
      prerequisites: productionPrerequisites,
      context: invalid.planningContext
    });
    const oracle = auditPlan(senior.student, invalid);
    assert.equal(production.valid, false, definition.id);
    assert.ok(
      production.errors.some(error => /ECO 257 is not a valid course for requirement eco-elective/.test(error)),
      `${definition.id}: production did not reject ECO 257 elective allocation.`
    );
    assert.ok(
      oracle.violations.some(violation => violation.ruleId === "ELECTIVE-ECO-257-STATISTICS-ONLY"),
      `${definition.id}: the independent oracle did not reject ECO 257 elective allocation.`
    );
    assert.equal(invalid.candidateRank, undefined);
    assert.equal(invalid.strategyScore, undefined);
  }
});
