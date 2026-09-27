import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { evaluateOffering, evaluatePrerequisites, evaluateRequirementAllocation, evaluateTermLoad, normalizeStudentFacts } from "../lib/decision-engine/index.js";
import { buildPrerequisiteStatusNotices } from "../lib/planning/prerequisiteEvaluator.js";
import { loadPolicyBundle } from "../lib/policy/load-bundle.js";
import { checkExternalEconomicsPrerequisites } from "./oracle/check-prerequisites.js";
import { loadCanonicalPolicy, oracleEvaluateAllocation, oracleEvaluateOffering, oracleEvaluatePrerequisite, oracleEvaluateTermLoad } from "./oracle/load-canonical-policy.js";

const AUTHORITY_CONFLICT_MESSAGE = "SPECIFICATION / AUTHORITY CONFLICT — inspect controlling policy and provenance before changing either implementation.";
const ECO_461_CONCURRENCY_RULE_ID = "CONCURRENT-INTERMEDIATE-ECO-461";

const [bundle, oracle, independentOraclePolicy, prerequisiteFixtures, compatibilityPrerequisites] = await Promise.all([
  loadPolicyBundle({ allowPending: true }),
  loadCanonicalPolicy(),
  readJson("./oracle/economics-policy.v1.json"),
  readJson("./fixtures/economics-oracle-plans/prerequisite-cases.json"),
  readJson("../data/normalized/economics/prerequisites.json")
]);
const facts = normalizeStudentFacts({ courses: [] });

test("catalog projections require matching course, term and effective evidence; exact schedules win", () => {
  for (const [course, term, expected] of [
    [{course: "ECO 222", source: "catalog-statement"}, {academicYear: "2027-2028", termKey: "May"}, "ALLOW"],
    [{course: "ECO 222", source: "catalog-statement"}, {academicYear: "2027-2028", termKey: "Winter"}, "BLOCK"],
    [{course: "ECO 221", source: "catalog-statement"}, {academicYear: "2027-2028", termKey: "May"}, "UNKNOWN"],
    [{course: "ECO 222", source: "catalog-statement"}, {academicYear: "2023-2024", termKey: "May"}, "UNKNOWN"],
    [{course: "ECO 222", section: "fictional", source: "catalog-statement"}, {academicYear: "2026-2027", termKey: "May"}, "BLOCK"],
    [{course: "ECO 222", source: "projected-offering"}, {academicYear: "2027-2028", termKey: "Winter"}, "BLOCK"]
  ]) {
    assert.equal(evaluateOffering(course, term, bundle.indexes.offeringByTerm, bundle).status, expected);
    assert.equal(oracleEvaluateOffering(oracle, course, term).status, expected);
  }
  // Internal boundary diagnostics: neither implementation may silently extend
  // expired evidence or guess a term date inside a partially covered year.
  for (const effective of [
    {from: "2024-01-01", through: "2027-12-31"},
    {from: "2028-04-01", through: null}
  ]) {
    const changedOracle = structuredClone(oracle);
    const changedBundle = structuredClone(bundle);
    changedOracle.offeringPatterns.find(pattern => pattern.patternId === "CATALOG-ECO-222-SPRING").effective = effective;
    changedBundle.indexes.offeringPatternsById["CATALOG-ECO-222-SPRING"].effective = effective;
    const course = {course: "ECO 222", source: "catalog-statement"};
    const term = {academicYear: "2027-2028", termKey: "May"};
    assert.equal(oracleEvaluateOffering(changedOracle, course, term).status, "UNKNOWN");
    assert.equal(evaluateOffering(course, term, changedBundle.indexes.offeringByTerm, changedBundle).status, "UNKNOWN");
  }
});

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

function fixtureById(fixtureId) {
  return prerequisiteFixtures.cases.find(item => item.fixtureId === fixtureId);
}

function oracleInput(fixture) {
  return {
    student: fixture.student || {},
    expectedContext: fixture.expectedContext || {
      startYear: 2026,
      remainingYears: 1,
      expectedGraduationYear: 2027,
      expectedGraduationTerm: "Spring/May 2027"
    },
    plan: {
      id: fixture.fixtureId,
      terms: (fixture.terms || []).map(term => ({
        ...term,
        courses: (term.courses || []).map((course, index) => ({
          ...(typeof course === "string" ? { course } : course),
          requirementId: typeof course === "object" && course.requirementId
            ? course.requirementId
            : `authority-guard-${index + 1}`
        }))
      }))
    },
    policy: independentOraclePolicy,
    verifiedSchedule: {}
  };
}

function assertAuthorityAlignment({ authorityDecision, productionDecision, oracleDecision }) {
  if (authorityDecision === null) {
    if (productionDecision !== oracleDecision) throw new Error(AUTHORITY_CONFLICT_MESSAGE);
    return;
  }
  if (productionDecision !== oracleDecision) {
    const implementation = productionDecision === authorityDecision ? "ORACLE" : "PRODUCTION";
    throw new Error(`${implementation} IMPLEMENTATION CONFLICT — implementation disagrees with explicit canonical policy.`);
  }
  assert.equal(
    productionDecision,
    authorityDecision,
    "Production and Oracle agree with each other but conflict with explicit canonical policy."
  );
}

function productionCapstoneDecision({ beforeTargetIntermediates, sameTermIntermediates, includeApproval = true }) {
  const term = { term: "Winter 2027", termKey: "Winter", termId: "2027-WINTER", academicYear: "2026-2027" };
  const approval = {
    approvalId: "authority-guard-department-approval",
    ruleId: ECO_461_CONCURRENCY_RULE_ID,
    status: "APPROVED",
    scope: { course: "ECO 461", termId: term.termId },
    authority: "ECONOMICS_DEPARTMENT",
    authorityBoundary: "ECO_461_INTERMEDIATE_CONCURRENCY",
    evidenceRef: "fictional-authority-guard-evidence",
    effectiveDate: "2026-08-09",
    expirationDate: null
  };
  return evaluatePrerequisites({ course: "ECO 461" }, term, facts, bundle, {
    traceId: "eco-461-authority-guard",
    availableCourses: new Set(["ECO 213", "ECO 214", "PSY 217"].filter(course => (
      course === "PSY 217" || beforeTargetIntermediates.includes(course)
    ))),
    sameTermCourses: new Set([...sameTermIntermediates, "ECO 461"]),
    approvalInstances: includeApproval ? [approval] : [],
    evaluationDate: "2026-08-09"
  });
}

test("allocation decisions agree for every core choice and the ECO 257 negative case", () => {
  const cases = [
    ["ECO 113", "eco-113"], ["ECO 257", "statistics"], ["MAT 217", "statistics"],
    ["BUSN 323", "finance"], ["MAT 121", "cognate"], ["ECO 260", "eco-elective-1"],
    ["ECO 257", "eco-elective-1"]
  ];
  for (const [course, requirement] of cases) {
    const production = evaluateRequirementAllocation(course, requirement, facts, bundle, { traceId: "differential" });
    const independent = oracleEvaluateAllocation(oracle, course, requirement);
    assert.equal(production.status, independent.status, `${course}/${requirement}`);
    assert.equal(production.reasonCode, independent.reasonCode, `${course}/${requirement}`);
  }
});

test("prerequisite decisions agree across prior, missing, and concurrent evidence", () => {
  const cases = [
    { course: "ECO 213", available: [], sameTerm: [], approvals: [] },
    { course: "ECO 213", available: ["ECO 113", "MAT 113"], sameTerm: [], approvals: [] },
    { course: "ECO 213", available: ["ECO 113"], sameTerm: ["ECO 213", "MAT 113"], approvals: [{ course: "ECO 213", prerequisite: "MAT 113", type: "INSTRUCTOR_APPROVAL" }] },
    { course: "ECO 331", available: ["ECO 213"], sameTerm: [], approvals: [] }
  ];
  for (const item of cases) {
    const approvalInstances = item.approvals.length ? [{
      approvalId: "differential-concurrency",
      ruleId: "CONCURRENT-MATH-ECO-213",
      status: "APPROVED",
      scope: { course: "ECO 213", termId: null },
      authority: "ECO_213_INSTRUCTOR",
      authorityBoundary: "ECO_213_INTERMEDIATE_CONCURRENCY",
      evidenceRef: "fixture-evidence",
      effectiveDate: "2026-08-01",
      expirationDate: null
    }] : [];
    const production = evaluatePrerequisites({ course: item.course }, {}, facts, bundle, { traceId: "differential", availableCourses: new Set(item.available), sameTermCourses: new Set(item.sameTerm), approvalInstances });
    const independent = oracleEvaluatePrerequisite(oracle, item.course, item);
    assert.equal(production.status, independent.status, JSON.stringify(item));
    assert.equal(production.reasonCode, independent.reasonCode, JSON.stringify(item));
  }
});

test("offering and term-load states agree including FULL and preliminary", () => {
  const offeringCases = [
    [{ course: "ECO 113", section: "A", source: "verified-offering" }, { academicYear: "2026-2027", termKey: "Fall" }],
    [{ course: "ECO 234", section: "A", source: "verified-offering" }, { academicYear: "2026-2027", termKey: "Fall" }],
    [{ course: "ECO 213", source: "projected-offering" }, { academicYear: "2027-2028", termKey: "Fall" }]
  ];
  for (const [course, term] of offeringCases) {
    assert.equal(evaluateOffering(course, term, bundle.indexes.offeringByTerm, bundle, { traceId: "differential" }).status, oracleEvaluateOffering(oracle, course, term).status);
  }
  const termCases = [
    { termKey: "Fall", academicYear: "2026-2027", courses: [{ course: "ECO 221" }] },
    { termKey: "May", academicYear: "2026-2027", courses: [{ course: "ECO 260" }, { course: "ECO 234" }] }
  ];
  for (const term of termCases) assert.equal(evaluateTermLoad(term, {}, bundle, { traceId: "differential" }).status, oracleEvaluateTermLoad(oracle, term).status);
});

test("ECO 461 chronology has one explicit authoritative meaning across source, bundle, and Oracle specification", () => {
  const canonicalRule = oracle.byRuleId[ECO_461_CONCURRENCY_RULE_ID];
  const compiledRule = bundle.indexes.byRuleId[ECO_461_CONCURRENCY_RULE_ID];
  const oracleRule = independentOraclePolicy.concurrencyRules.find(rule => rule.ruleId === ECO_461_CONCURRENCY_RULE_ID);
  const authority = oracle.provenance.sources.find(source => source.sourceId === "OWNER-ECO461-CHRONOLOGY-2026-08-09");
  const expectedMeaning = {
    requiresCompletedFromOptions: 1,
    requiresCompletedBeforeTargetTerm: true,
    earlierPendingCoursesRequireSuccessfulCompletion: true,
    maxConcurrent: 1,
    approvalAuthority: "Economics Department"
  };

  assert.deepEqual({
    requiresCompletedFromOptions: canonicalRule.condition.requiresCompletedFromOptions,
    requiresCompletedBeforeTargetTerm: canonicalRule.condition.requiresCompletedBeforeTargetTerm,
    earlierPendingCoursesRequireSuccessfulCompletion: canonicalRule.condition.earlierPendingCoursesRequireSuccessfulCompletion,
    maxConcurrent: canonicalRule.condition.maxConcurrent,
    approvalAuthority: canonicalRule.effect.approvalAuthority
  }, expectedMeaning);
  assert.deepEqual({
    requiresCompletedFromOptions: compiledRule.condition.requiresCompletedFromOptions,
    requiresCompletedBeforeTargetTerm: compiledRule.condition.requiresCompletedBeforeTargetTerm,
    earlierPendingCoursesRequireSuccessfulCompletion: compiledRule.condition.earlierPendingCoursesRequireSuccessfulCompletion,
    maxConcurrent: compiledRule.condition.maxConcurrent,
    approvalAuthority: compiledRule.effect.approvalAuthority
  }, expectedMeaning);
  assert.deepEqual({
    requiresCompletedFromOptions: oracleRule.requiresCompletedFromOptions,
    requiresCompletedBeforeTargetTerm: oracleRule.requiresCompletedBeforeTargetTerm,
    earlierPendingCoursesRequireSuccessfulCompletion: oracleRule.earlierPendingCoursesRequireSuccessfulCompletion,
    maxConcurrent: oracleRule.maxConcurrent,
    approvalAuthority: oracleRule.approvalAuthority
  }, expectedMeaning);
  assert.match(authority.statement, /successfully completed before the target ECO 461 term/iu);
  assert.match(authority.statement, /current in-progress course finishing before the target term.*may count/iu);
  assert.match(authority.statement, /Same-term or later courses.*do not count/iu);
});

test("production and Oracle independently enforce the canonical ECO 461 target-term chronology", () => {
  const productionEarlierPending = productionCapstoneDecision({
    beforeTargetIntermediates: ["ECO 213"],
    sameTermIntermediates: ["ECO 214"]
  });
  const productionSameTermOnly = productionCapstoneDecision({
    beforeTargetIntermediates: [],
    sameTermIntermediates: ["ECO 213", "ECO 214"]
  });
  const productionMissingApproval = productionCapstoneDecision({
    beforeTargetIntermediates: ["ECO 213"],
    sameTermIntermediates: ["ECO 214"],
    includeApproval: false
  });
  const oracleEarlierPending = checkExternalEconomicsPrerequisites(oracleInput(
    fixtureById("prereq-valid-in-progress-eco213-before-concurrent-eco214-capstone")
  ));
  const oracleSameTermOnly = checkExternalEconomicsPrerequisites(oracleInput(
    fixtureById("prereq-invalid-both-intermediates-concurrent-capstone")
  ));
  const oracleMissingApproval = checkExternalEconomicsPrerequisites(oracleInput(
    fixtureById("prereq-invalid-capstone-concurrency-no-approval")
  ));

  assertAuthorityAlignment({
    authorityDecision: true,
    productionDecision: productionEarlierPending.status === "ALLOW",
    oracleDecision: oracleEarlierPending.status === "VALID_PREREQUISITES"
  });
  assertAuthorityAlignment({
    authorityDecision: false,
    productionDecision: productionSameTermOnly.status !== "BLOCK",
    oracleDecision: oracleSameTermOnly.status === "VALID_PREREQUISITES"
  });
  assertAuthorityAlignment({
    authorityDecision: false,
    productionDecision: productionMissingApproval.status !== "BLOCK",
    oracleDecision: oracleMissingApproval.status === "VALID_PREREQUISITES"
  });

  const pendingNotices = buildPrerequisiteStatusNotices({
    student: { courses: [{ code: "ECO 213", status: "in_progress" }] },
    plan: {
      terms: [{
        term: "Winter 2027",
        termKey: "Winter",
        academicYear: "2026-2027",
        courses: [{ course: "ECO 461" }]
      }]
    },
    prerequisites: compatibilityPrerequisites
  });
  assert.ok(pendingNotices.some(notice => (
    notice.code === "PREREQUISITE_IN_PROGRESS_SUCCESS_PENDING"
      && notice.prerequisite === "ECO 213"
      && notice.dependentCourse === "ECO 461"
  )));
});

test("authority guard catches either implementation mutation and stops on ambiguous authority", () => {
  assert.throws(() => assertAuthorityAlignment({
    authorityDecision: true,
    productionDecision: true,
    oracleDecision: false
  }), /ORACLE IMPLEMENTATION CONFLICT/iu);
  assert.throws(() => assertAuthorityAlignment({
    authorityDecision: true,
    productionDecision: false,
    oracleDecision: true
  }), /PRODUCTION IMPLEMENTATION CONFLICT/iu);
  assert.throws(() => assertAuthorityAlignment({
    authorityDecision: null,
    productionDecision: false,
    oracleDecision: true
  }), error => error.message === AUTHORITY_CONFLICT_MESSAGE);
});

test("Independent Oracle cannot import or invoke production academic evaluators", async () => {
  const oracleDirectory = new URL("./oracle/", import.meta.url);
  const filenames = (await readdir(oracleDirectory)).filter(filename => filename.endsWith(".js"));
  const prohibited = /(?:lib[\\/](?:decision-engine|planning|assignment|requirements)|loadPolicyBundle|validateGeneratedPlan|evaluatePrerequisites)/iu;

  for (const filename of filenames) {
    const source = await readFile(new URL(filename, oracleDirectory), "utf8");
    assert.doesNotMatch(source, prohibited, filename);
  }
});
