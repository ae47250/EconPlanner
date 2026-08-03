import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  auditExternalEconomicsPlanWithPrerequisites
} from "./oracle/audit-external-plan.js";
import { checkExternalEconomicsPrerequisites } from "./oracle/check-prerequisites.js";

const policy = JSON.parse(await readFile(
  new URL("./oracle/economics-policy.v1.json", import.meta.url),
  "utf8"
));
const verifiedSchedule = JSON.parse(await readFile(
  new URL("./oracle/verified-schedule-2026-2027.json", import.meta.url),
  "utf8"
));
const fixtureDocument = JSON.parse(await readFile(
  new URL("./fixtures/economics-oracle-plans/prerequisite-cases.json", import.meta.url),
  "utf8"
));

const DEFAULT_CONTEXT = Object.freeze({
  startYear: 2026,
  remainingYears: 1,
  expectedGraduationYear: 2027,
  expectedGraduationTerm: "Spring/May 2027"
});

function courseObject(entry, index) {
  return {
    ...(typeof entry === "string" ? { course: entry } : entry),
    requirementId: typeof entry === "object" && entry.requirementId
      ? entry.requirementId
      : `handwritten-course-${index + 1}`
  };
}

function externalInput(fixture) {
  return {
    student: fixture.student || {},
    expectedContext: fixture.expectedContext || DEFAULT_CONTEXT,
    plan: {
      id: fixture.fixtureId,
      terms: (fixture.terms || []).map(term => ({
        ...term,
        courses: (term.courses || []).map(courseObject)
      }))
    },
    policy,
    verifiedSchedule
  };
}

function fixtureById(fixtureId) {
  return fixtureDocument.cases.find(item => item.fixtureId === fixtureId);
}

function policyRuleIds() {
  return new Set([
    ...policy.prerequisiteRules,
    ...policy.concurrencyRules,
    ...policy.permissionRules,
    ...policy.capstoneRules,
    ...policy.unresolvedPolicyQuestions
  ].map(rule => rule.ruleId));
}

function permissionApproval(course = "ECO 357") {
  return {
    ruleId: "PERMISSION-ECO-357",
    type: "DEPARTMENT_PERMISSION",
    authority: "Economics Department",
    course,
    prerequisite: null,
    term: "Fall 2026",
    reason: "Economics Department permission is recorded.",
    sourceRef: "ECONOMICS-REQUIREMENTS#Key Prerequisites by Course Number"
  };
}

function prerequisiteTableInput(value, { invalid = false } = {}) {
  const completedCourses = invalid
    ? value.completedCourses.filter(course => course !== value.missingCourse)
    : value.completedCourses;
  const dependent = { course: value.course };
  if (value.permissionRequired) dependent.approvalRequired = [permissionApproval(value.course)];
  return externalInput({
    fixtureId: `table-${value.course}-${invalid ? "invalid" : "valid"}`,
    student: { completedCourses },
    terms: [{
      slotId: "fall-2026",
      term: "Fall 2026",
      termKey: "Fall",
      academicYear: "2026/2027",
      courses: [dependent]
    }]
  });
}

function approvalMutationInput(value) {
  const input = structuredClone(externalInput(fixtureById("prereq-valid-concurrent-math-eco213")));
  const courses = input.plan.terms[0].courses;
  const dependent = courses.find(course => course.course === "ECO 213");
  const approval = dependent.approvalRequired[0];
  if (value.field === "attachment") {
    dependent.approvalRequired = [];
    courses.find(course => course.course === "MAT 113").approvalRequired = [approval];
  } else {
    approval[value.field] = value.value;
  }
  input.plan.id = value.fixtureId;
  return input;
}

test("Task 5 oracle has no prohibited production imports", async () => {
  const files = await Promise.all([
    readFile(new URL("./oracle/check-prerequisites.js", import.meta.url), "utf8"),
    readFile(new URL("./oracle/audit-external-plan.js", import.meta.url), "utf8")
  ]);
  const prohibited = /(?:from\s+|import\s*\()[^;\n]*(?:lib[\\/](?:planning|assignment|requirements)|prerequisiteEvaluator|prerequisiteValidation|normalizeEconomicsSchedule|scheduleProvider|data[\\/]normalized)/iu;
  for (const source of files) assert.equal(prohibited.test(source), false);
});

test("every manifest prerequisite table row accepts prior evidence and rejects missing evidence", () => {
  const coveredRuleIds = new Set(fixtureDocument.prerequisiteTableCases.map(item => item.ruleId));
  const expectedRuleIds = new Set(
    policy.prerequisiteRules
      .filter(rule => rule.course !== "ECO 461")
      .map(rule => rule.ruleId)
  );
  assert.deepEqual(coveredRuleIds, expectedRuleIds);

  for (const value of fixtureDocument.prerequisiteTableCases) {
    const accepted = checkExternalEconomicsPrerequisites(prerequisiteTableInput(value));
    assert.equal(accepted.status, "VALID_PREREQUISITES", `${value.course}: valid`);
    assert.deepEqual(accepted.violations, [], `${value.course}: valid`);

    const rejected = checkExternalEconomicsPrerequisites(prerequisiteTableInput(value, { invalid: true }));
    assert.equal(rejected.status, "INVALID_PREREQUISITES", `${value.course}: invalid`);
    assert.ok(
      rejected.violations.some(item => item.code === value.ruleId),
      `${value.course}: ${value.ruleId}`
    );
  }
});

test("handwritten valid cases enforce chronology and every confirmed exception", () => {
  const accepted = fixtureDocument.cases.filter(item => item.expectedStatus === "VALID_PREREQUISITES");
  assert.equal(fixtureDocument.authorship, "handwritten");
  assert.equal(accepted.length, 8);

  for (const fixture of accepted) {
    const result = checkExternalEconomicsPrerequisites(externalInput(fixture));
    assert.equal(result.status, "VALID_PREREQUISITES", fixture.fixtureId);
    assert.equal(result.valid, true, fixture.fixtureId);
    assert.deepEqual(result.violations, [], fixture.fixtureId);
  }
});

test("handwritten invalid cases fail under stable manifest rule IDs", () => {
  const rejected = fixtureDocument.cases.filter(item => item.expectedStatus === "INVALID_PREREQUISITES");
  const manifestIds = policyRuleIds();
  assert.equal(rejected.length, 15);

  for (const fixture of rejected) {
    const result = checkExternalEconomicsPrerequisites(externalInput(fixture));
    const codes = result.violations.map(item => item.code);
    assert.equal(result.status, "INVALID_PREREQUISITES", fixture.fixtureId);
    assert.equal(result.valid, false, fixture.fixtureId);
    for (const code of fixture.expectedCodes) {
      assert.ok(codes.includes(code), `${fixture.fixtureId}: ${code}`);
    }
    for (const finding of result.violations) {
      assert.ok(manifestIds.has(finding.code), `${fixture.fixtureId}: ${finding.code}`);
      assert.equal(finding.code, finding.ruleId, fixture.fixtureId);
      assert.match(finding.objectPath, /^\$/u, fixture.fixtureId);
      assert.ok(finding.message, fixture.fixtureId);
      assert.ok(finding.sourceReference, fixture.fixtureId);
    }
  }
});

test("every approval metadata field and attachment is validated independently", () => {
  assert.equal(fixtureDocument.approvalMetadataCases.length, 9);
  for (const fixture of fixtureDocument.approvalMetadataCases) {
    const result = checkExternalEconomicsPrerequisites(approvalMutationInput(fixture));
    assert.equal(result.status, "INVALID_PREREQUISITES", fixture.fixtureId);
    assert.ok(
      result.violations.some(item => item.code === "CONCURRENT-MATH-ECO-213"),
      fixture.fixtureId
    );
  }
});

test("advanced-course gaps, ECO 335 equivalency, waivers, and substitutions remain review-only", () => {
  const reviewCases = fixtureDocument.cases.filter(item => item.expectedStatus === "REVIEW_REQUIRED");
  const expectedStatuses = new Map(policy.unresolvedPolicyQuestions.map(rule => [rule.ruleId, rule.status]));
  assert.equal(reviewCases.length, 4);

  for (const fixture of reviewCases) {
    const result = checkExternalEconomicsPrerequisites(externalInput(fixture));
    const reviewItems = result.reviewItems.filter(item => fixture.expectedReviewCodes.includes(item.code));
    assert.equal(result.status, "REVIEW_REQUIRED", fixture.fixtureId);
    assert.equal(result.valid, false, fixture.fixtureId);
    assert.deepEqual(result.violations, [], fixture.fixtureId);
    assert.equal(reviewItems.length, fixture.expectedReviewCodes.length, fixture.fixtureId);
    for (const item of reviewItems) {
      assert.equal(item.status, expectedStatuses.get(item.code), fixture.fixtureId);
    }
  }
});

test("capstone rules include final-Winter senior standing and never infer concurrent statistics", () => {
  assert.deepEqual(policy.concurrencyRules.map(rule => rule.ruleId), [
    "CONCURRENT-MATH-ECO-213",
    "CONCURRENT-MATH-ECO-214",
    "CONCURRENT-INTERMEDIATE-ECO-461"
  ]);
  assert.deepEqual(policy.permissionRules.map(rule => rule.ruleId), ["PERMISSION-ECO-357"]);
  assert.deepEqual(policy.capstoneRules.map(rule => rule.ruleId), [
    "CAPSTONE-WINTER-ONLY",
    "CAPSTONE-SENIOR-STANDING",
    "CAPSTONE-EARLY-GRADUATE-STANDING",
    "CAPSTONE-HANOVER-RESIDENCY",
    "CAPSTONE-STATISTICS-BEFORE"
  ]);
  assert.equal(
    fixtureById("prereq-valid-integrated-strict-capstone").expectedContext.oneAcademicYearEarly,
    true
  );
  const strict = checkExternalEconomicsPrerequisites(externalInput(
    fixtureById("prereq-valid-integrated-strict-capstone")
  ));
  assert.equal(strict.status, "VALID_PREREQUISITES");

  const concurrentStatistics = checkExternalEconomicsPrerequisites(externalInput(
    fixtureById("prereq-invalid-statistics-concurrent-capstone")
  ));
  assert.ok(concurrentStatistics.violations.some(item => item.code === "CAPSTONE-STATISTICS-BEFORE"));
});

test("integrated Task 5 audit checks requirements and prerequisites but leaves schedules NOT_CHECKED", () => {
  const fixture = fixtureById("prereq-valid-integrated-strict-capstone");
  const result = auditExternalEconomicsPlanWithPrerequisites(externalInput(fixture));

  assert.equal(result.status, "NOT_CHECKED");
  assert.equal(result.valid, false);
  assert.equal(result.requirementAllocation.status, "VALID_REQUIREMENTS");
  assert.equal(result.prerequisiteValidation.status, "VALID_PREREQUISITES");
  assert.ok(result.checkedRuleFamilies.some(item => item.family === "REQUIREMENT_ALLOCATION"));
  assert.ok(result.checkedRuleFamilies.some(item => item.family === "PREREQUISITES"));
  assert.ok(result.uncheckedRuleFamilies.some(item => (
    item.family === "SCHEDULE" && item.status === "NOT_CHECKED"
  )));
});
