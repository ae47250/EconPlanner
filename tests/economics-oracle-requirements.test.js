import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  auditExternalEconomicsPlanWithRequirements
} from "./oracle/audit-external-plan.js";
import { checkExternalEconomicsRequirements } from "./oracle/check-requirements.js";

const policy = JSON.parse(await readFile(
  new URL("./oracle/economics-policy.v1.json", import.meta.url),
  "utf8"
));
const verifiedSchedule = JSON.parse(await readFile(
  new URL("./oracle/verified-schedule-2026-2027.json", import.meta.url),
  "utf8"
));
const fixtureDocument = JSON.parse(await readFile(
  new URL("./fixtures/economics-oracle-plans/requirement-allocation-cases.json", import.meta.url),
  "utf8"
));

function externalInput(fixture) {
  return {
    student: {
      studentId: `fictional-${fixture.fixtureId}`,
      completedCourses: fixture.completedCourses || []
    },
    expectedContext: {
      startYear: 2026,
      remainingYears: 1,
      expectedGraduationYear: 2027,
      expectedGraduationTerm: "Spring/May 2027"
    },
    plan: {
      id: fixture.fixtureId,
      requirementClaims: fixture.requirementClaims || [],
      terms: [{
        slotId: "fall-2026",
        term: "Fall 2026",
        termKey: "Fall",
        academicYear: "2026/2027",
        courses: fixture.courses.map((entry, index) => ({
          ...(typeof entry === "string" ? { course: entry } : entry),
          requirementId: typeof entry === "object" && entry.requirementId
            ? entry.requirementId
            : `handwritten-course-${index + 1}`,
          units: typeof entry === "object" && entry.units !== undefined ? entry.units : 1
        }))
      }]
    },
    policy,
    verifiedSchedule
  };
}

function fixtureById(fixtureId) {
  return fixtureDocument.cases.find(item => item.fixtureId === fixtureId);
}

function policyRuleIds() {
  return new Set(Object.values(policy)
    .filter(Array.isArray)
    .flat()
    .map(item => item?.ruleId)
    .filter(Boolean));
}

test("Task 4 oracle has no prohibited production imports", async () => {
  const files = await Promise.all([
    readFile(new URL("./oracle/check-requirements.js", import.meta.url), "utf8"),
    readFile(new URL("./oracle/audit-external-plan.js", import.meta.url), "utf8")
  ]);
  const prohibited = /(?:from\s+|import\s*\()[^;\n]*(?:lib[\\/](?:planning|assignment|requirements)|normalizeEconomicsSchedule|scheduleProvider|data[\\/]normalized)/iu;
  for (const source of files) assert.equal(prohibited.test(source), false);
});

test("all accepted handwritten fixtures produce one complete 12-slot allocation", () => {
  const accepted = fixtureDocument.cases.filter(item => item.expectedStatus === "VALID_REQUIREMENTS");
  assert.equal(fixtureDocument.authorship, "handwritten");
  assert.equal(accepted.length, 7);

  for (const fixture of accepted) {
    const result = checkExternalEconomicsRequirements(externalInput(fixture));
    assert.equal(result.status, "VALID_REQUIREMENTS", fixture.fixtureId);
    assert.equal(result.valid, true, fixture.fixtureId);
    assert.deepEqual(result.violations, [], fixture.fixtureId);
    assert.equal(result.allocations.length, 1, fixture.fixtureId);
    assert.equal(result.allocation.length, 12, fixture.fixtureId);
    assert.equal(new Set(result.allocation.map(item => item.slotId)).size, 12, fixture.fixtureId);
    assert.equal(new Set(result.allocation.map(item => item.coursePath)).size, 12, fixture.fixtureId);
    assert.equal(new Set(result.allocation.map(item => item.courseIdentity)).size, 12, fixture.fixtureId);
    assert.equal(
      result.allocation.filter(item => item.ruleId === "REQ-ECO-ELECTIVES").length,
      4,
      fixture.fixtureId
    );
    const capstone = result.allocation.find(item => item.ruleId === "REQ-ECO-461");
    assert.equal(capstone.attributes.requiredInstitution, "Hanover College", fixture.fixtureId);
  }
});

test("multiple valid cognate allocations still hand one complete 12-slot allocation to later oracles", () => {
  const fixture = structuredClone(fixtureById("requirements-valid-busn-finance-eco321-elective"));
  fixture.courses.push("MAT 121");
  const result = checkExternalEconomicsRequirements(externalInput(fixture));

  assert.equal(result.valid, true);
  assert.equal(result.allocations.length, 2);
  assert.equal(result.allocation.length, 12);
  assert.equal(new Set(result.allocation.map(item => item.slotId)).size, 12);
});

test("four distinct future elective placeholders fill four planned slots without becoming completed courses", () => {
  const fixture = fixtureById("requirements-valid-four-distinct-future-elective-placeholders");
  const result = checkExternalEconomicsRequirements(externalInput(fixture));
  const placeholders = result.allocation.filter(item => item.planningState === "placeholder");
  const completed = result.allocation.filter(item => item.planningState === "completed");

  assert.equal(result.valid, true);
  assert.equal(result.allocation.length, 12);
  assert.equal(placeholders.length, 4);
  assert.equal(completed.length, 8);
  assert.equal(new Set(placeholders.map(item => item.placeholderSlotIdentity)).size, 4);
  assert.equal(new Set(placeholders.map(item => item.requirementAllocationIdentity)).size, 4);
  assert.ok(placeholders.every(item => item.actualCourseIdentity === null));
  assert.ok(placeholders.every(item => item.offeringSource === "projected-offering"));
  assert.ok(placeholders.every(item => item.coursePath.startsWith("$.plan.terms")));
  assert.ok(completed.every(item => item.coursePath.startsWith("$.student.completedCourses")));
});

test("three future placeholders cannot fill four elective slots and a repeated placeholder slot is rejected", () => {
  const three = checkExternalEconomicsRequirements(externalInput(
    fixtureById("requirements-reject-only-three-future-elective-placeholders")
  ));
  const duplicate = checkExternalEconomicsRequirements(externalInput(
    fixtureById("requirements-reject-duplicate-future-placeholder-slot")
  ));

  assert.equal(three.valid, false);
  assert.ok(three.violations.some(item => item.code === "REQ-ECO-ELECTIVES"));
  assert.equal(duplicate.valid, false);
  assert.ok(duplicate.violations.some(item => item.code === "ELECTIVE-NO-DOUBLE-COUNT"));
});

test("the same actual course still cannot fill two requirement slots", () => {
  const result = checkExternalEconomicsRequirements(externalInput(
    fixtureById("requirements-reject-ordinary-double-count")
  ));
  assert.equal(result.valid, false);
  assert.ok(result.violations.some(item => item.code === "ELECTIVE-NO-DOUBLE-COUNT"));
});

test("finance, statistics, ECO 260, and cross-list choices allocate under confirmed rules", () => {
  const busn = checkExternalEconomicsRequirements(externalInput(
    fixtureById("requirements-valid-busn-finance-eco321-elective")
  )).allocation;
  assert.equal(busn.find(item => item.ruleId === "REQ-FINANCE").canonicalCourse, "BUSN 323");
  assert.ok(busn.some(item => item.ruleId === "REQ-ECO-ELECTIVES" && item.canonicalCourse === "ECO 321"));
  assert.ok(busn.some(item => item.ruleId === "REQ-ECO-ELECTIVES" && item.canonicalCourse === "ECO 260"));
  assert.ok(busn.some(item => item.ruleId === "REQ-ECO-ELECTIVES" && item.canonicalCourse === "ECO 234"));

  const ecoFinance = checkExternalEconomicsRequirements(externalInput(
    fixtureById("requirements-valid-eco321-finance")
  )).allocation;
  assert.equal(ecoFinance.find(item => item.ruleId === "REQ-FINANCE").canonicalCourse, "ECO 321");

  const statisticsCases = [
    ["requirements-valid-busn-finance-eco321-elective", "PSY 217"],
    ["requirements-valid-mat217-statistics", "MAT 217"],
    ["requirements-valid-eco257-statistics", "ECO 257"]
  ];
  for (const [fixtureId, course] of statisticsCases) {
    const allocation = checkExternalEconomicsRequirements(externalInput(fixtureById(fixtureId))).allocation;
    assert.equal(allocation.find(item => item.ruleId === "REQ-STATISTICS").canonicalCourse, course);
  }
});

test("rejected handwritten fixtures fail with their intended manifest rule codes", () => {
  const rejected = fixtureDocument.cases.filter(item => item.expectedStatus === "INVALID_REQUIREMENTS");
  const manifestRuleIds = policyRuleIds();
  assert.equal(rejected.length, 11);

  for (const fixture of rejected) {
    const result = checkExternalEconomicsRequirements(externalInput(fixture));
    const codes = result.violations.map(item => item.code);
    assert.equal(result.status, "INVALID_REQUIREMENTS", fixture.fixtureId);
    assert.equal(result.valid, false, fixture.fixtureId);
    assert.equal(result.allocations.length, 0, fixture.fixtureId);
    for (const expectedCode of fixture.expectedCodes) {
      assert.ok(codes.includes(expectedCode), `${fixture.fixtureId}: ${expectedCode}`);
    }
    for (const finding of result.violations) {
      assert.ok(manifestRuleIds.has(finding.code), `${fixture.fixtureId}: ${finding.code}`);
      assert.equal(finding.code, finding.ruleId, fixture.fixtureId);
      assert.match(finding.objectPath, /^\$/u, fixture.fixtureId);
      assert.ok(finding.message, fixture.fixtureId);
      assert.ok(finding.sourceReference, fixture.fixtureId);
    }
  }
});

test("waivers, substitutions, and unconfirmed equivalencies require review and receive no credit", () => {
  const reviewCases = fixtureDocument.cases.filter(item => item.expectedStatus === "REVIEW_REQUIRED");
  assert.equal(reviewCases.length, 3);

  for (const fixture of reviewCases) {
    const result = checkExternalEconomicsRequirements(externalInput(fixture));
    const reviewCodes = result.reviewItems.map(item => item.code);
    assert.equal(result.status, "REVIEW_REQUIRED", fixture.fixtureId);
    assert.equal(result.valid, false, fixture.fixtureId);
    assert.equal(result.allocation, null, fixture.fixtureId);
    assert.equal(result.allocations.length, 0, fixture.fixtureId);
    assert.deepEqual(result.violations, [], fixture.fixtureId);
    for (const expectedCode of fixture.expectedReviewCodes) {
      assert.ok(reviewCodes.includes(expectedCode), `${fixture.fixtureId}: ${expectedCode}`);
    }
  }
});

test("integrated Task 4 audit leaves prerequisites and schedule explicitly NOT_CHECKED", () => {
  const fixture = fixtureById("requirements-valid-busn-finance-eco321-elective");
  const result = auditExternalEconomicsPlanWithRequirements(externalInput(fixture));

  assert.equal(result.status, "NOT_CHECKED");
  assert.equal(result.valid, false);
  assert.equal(result.requirementAllocation.status, "VALID_REQUIREMENTS");
  assert.ok(result.checkedRuleFamilies.some(item => item.family === "REQUIREMENT_ALLOCATION"));
  assert.ok(result.uncheckedRuleFamilies.some(item => (
    item.family === "PREREQUISITES" && item.status === "NOT_CHECKED"
  )));
  assert.ok(result.uncheckedRuleFamilies.some(item => (
    item.family === "SCHEDULE" && item.status === "NOT_CHECKED"
  )));
});
