import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  auditExternalEconomicsPlanComplete
} from "./oracle/audit-external-plan.js";
import {
  checkExternalEconomicsScheduleAndHorizon
} from "./oracle/check-schedule-and-horizon.js";

const policy = JSON.parse(await readFile(
  new URL("./oracle/economics-policy.v1.json", import.meta.url),
  "utf8"
));
const verifiedSchedule = JSON.parse(await readFile(
  new URL("./oracle/verified-schedule-2026-2027.json", import.meta.url),
  "utf8"
));
const fixtures = JSON.parse(await readFile(
  new URL("./fixtures/economics-oracle-plans/schedule-capacity-cases.json", import.meta.url),
  "utf8"
));

const completeAllocation = Object.freeze({
  allocation: Array.from({ length: 12 }, (_, index) => ({
    requirementId: `oracle-requirement-${index + 1}`,
    coursePath: `$.student.completedCourses[${index}]`
  }))
});

function inputFromCompleteFixture() {
  const value = structuredClone(fixtures.completeVerifiedPlan);
  return {
    student: value.student,
    expectedContext: value.expectedContext,
    plan: { id: value.fixtureId, terms: value.terms },
    policy,
    verifiedSchedule
  };
}

function setPath(object, path, value) {
  const segments = path.split(".");
  let cursor = object;
  for (const segment of segments.slice(0, -1)) cursor = cursor[segment];
  cursor[segments.at(-1)] = value;
}

function section(course, sectionId, term) {
  return verifiedSchedule.sections.find(row => (
    row.course === course && row.section === sectionId && row.term === term
  ));
}

function verifiedCourse(row, requirementId) {
  return {
    course: row.course,
    requirementId,
    section: row.section,
    title: row.title,
    units: row.units,
    source: "verified-offering",
    verificationStatus: "verified",
    canonicalCrossListIdentity: row.canonicalCrossListIdentity,
    meeting: {
      ...row.meeting,
      ...row.courseDates
    },
    availability: { ...row.availability },
    provenance: {
      verificationDate: row.verificationDate,
      sourceReference: row.sourceReference
    }
  };
}

function projectedInput({
  fixtureId,
  academicYear = "2027/2028",
  termKey = "Fall",
  count = 1,
  reserved = 0,
  source = "projected-offering",
  course = "ECO 399",
  graduationYear = 2028
}) {
  const displayYear = termKey === "Fall" ? academicYear.slice(0, 4) : academicYear.slice(5);
  return {
    student: { completedCourses: [] },
    expectedContext: {
      startYear: Number(academicYear.slice(0, 4)),
      remainingYears: graduationYear - Number(academicYear.slice(0, 4)),
      expectedGraduationYear: graduationYear,
      expectedGraduationTerm: `Spring/May ${graduationYear}`
    },
    plan: {
      id: fixtureId,
      terms: [{
        slotId: `${termKey.toLowerCase().replace(/\W+/gu, "-")}-${displayYear}`,
        term: `${termKey} ${displayYear}`,
        termKey,
        academicYear,
        reservedOutsideCourseUnits: reserved,
        courses: Array.from({ length: count }, (_, index) => ({
          course: index ? `ECO ${390 + index}` : course,
          requirementId: `projected-${index + 1}`,
          units: 1,
          section: "TBC",
          source,
          availability: { state: "open" }
        }))
      }]
    },
    policy,
    verifiedSchedule,
    requirementAllocation: completeAllocation
  };
}

test("Task 6 oracle imports no production planning or schedule modules", async () => {
  const sources = await Promise.all([
    readFile(new URL("./oracle/check-schedule-and-horizon.js", import.meta.url), "utf8"),
    readFile(new URL("./oracle/audit-external-plan.js", import.meta.url), "utf8")
  ]);
  const prohibited = /(?:from\s+|import\s*\()[^;\n]*(?:lib[\\/](?:planning|assignment|requirements)|scheduleProvider|normalizeEconomicsSchedule|data[\\/]normalized)/iu;
  for (const source of sources) assert.equal(prohibited.test(source), false);
});

test("the handwritten complete fixture passes every independent oracle family", () => {
  assert.equal(fixtures.authorship, "handwritten");
  const result = auditExternalEconomicsPlanComplete(inputFromCompleteFixture());
  assert.equal(result.status, "VERIFIED_FEASIBLE");
  assert.equal(result.valid, true);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.uncheckedRuleFamilies, []);
  assert.deepEqual(result.checkedRuleFamilies.map(item => item.family), [
    "INPUT_SHAPE",
    "TERM_IDENTITIES",
    "TERM_ORDER",
    "GRADUATION_HORIZON_STRUCTURE",
    "COURSE_ENTRY_STRUCTURE",
    "REQUIREMENT_ALLOCATION",
    "PREREQUISITES",
    "SCHEDULE",
    "CAPACITY",
    "GRADUATION_RULES"
  ]);
});

test("every embedded verified field is checked against the independent snapshot", () => {
  assert.equal(fixtures.verifiedFieldMutations.length, 15);
  for (const fixture of fixtures.verifiedFieldMutations) {
    const input = inputFromCompleteFixture();
    input.requirementAllocation = completeAllocation;
    input.plan.id = fixture.fixtureId;
    setPath(input.plan.terms[0].courses[0], fixture.path, fixture.value);
    const result = checkExternalEconomicsScheduleAndHorizon(input);
    const expectedCode = fixture.expectedCode || "SCHEDULE_VERIFIED_FIELD_MISMATCH";
    assert.equal(result.status, "NOT_FEASIBLE", fixture.fixtureId);
    assert.ok(result.violations.some(item => item.code === expectedCode), fixture.fixtureId);
  }
});

test("verified academic year, term, course, and section identities must exist in the snapshot", () => {
  assert.equal(fixtures.verifiedIdentityMutations.length, 3);
  for (const fixture of fixtures.verifiedIdentityMutations) {
    const input = inputFromCompleteFixture();
    input.requirementAllocation = completeAllocation;
    input.plan.id = fixture.fixtureId;
    setPath(input.plan.terms[0], fixture.path, fixture.value);
    const result = checkExternalEconomicsScheduleAndHorizon(input);
    assert.ok(
      result.violations.some(item => item.code === "SCHEDULE_VERIFIED_SECTION_NOT_FOUND"),
      fixture.fixtureId
    );
  }
});

test("closed blocks while waitlisted, unknown, and stale remain visible conditions", () => {
  assert.equal(fixtures.availabilityCases.length, 4);
  for (const fixture of fixtures.availabilityCases) {
    const input = inputFromCompleteFixture();
    input.requirementAllocation = completeAllocation;
    const schedule = structuredClone(verifiedSchedule);
    const row = schedule.sections.find(item => item.course === "ECO 461");
    row.availability.state = fixture.state;
    row.availability.seatsOpen = fixture.seatsOpen;
    input.verifiedSchedule = schedule;
    const course = input.plan.terms[0].courses[0];
    course.availability.state = fixture.state;
    course.availability.seatsOpen = fixture.seatsOpen;
    if (fixture.freshness) course.availability.freshness = fixture.freshness;
    const result = auditExternalEconomicsPlanComplete(input);
    const findings = [
      ...result.violations,
      ...result.enrollmentConditions,
      ...result.warnings
    ];
    assert.equal(result.status, fixture.expectedStatus, fixture.fixtureId);
    assert.ok(findings.some(item => item.code === fixture.expectedCode), fixture.fixtureId);
  }
});

test("direct meeting conflicts are rejected", () => {
  const first = section("ECO 114", "B", "Fall");
  const second = section("ECO 234", "A", "Fall");
  const input = {
    ...projectedInput({ fixtureId: "meeting-conflict", academicYear: "2026/2027", graduationYear: 2027 }),
    plan: {
      id: "meeting-conflict",
      terms: [{
        slotId: "fall-2026",
        term: "Fall 2026",
        termKey: "Fall",
        academicYear: "2026/2027",
        courses: [
          verifiedCourse(first, "elective-1"),
          verifiedCourse(second, "elective-2")
        ]
      }]
    }
  };
  const result = checkExternalEconomicsScheduleAndHorizon(input);
  assert.ok(result.violations.some(item => item.code === "SCHEDULE_MEETING_CONFLICT"));
});

test("4/4/1 capacity includes reserved outside-course units", () => {
  assert.equal(fixtures.capacityCases.length, 5);
  for (const fixture of fixtures.capacityCases) {
    const input = projectedInput({
      fixtureId: fixture.fixtureId,
      termKey: fixture.termKey,
      count: fixture.planned,
      reserved: fixture.reserved
    });
    const result = checkExternalEconomicsScheduleAndHorizon(input);
    const capacityViolation = result.violations.find(item => item.code === "CAPACITY_EXCEEDED");
    assert.equal(Boolean(capacityViolation), !fixture.valid, fixture.fixtureId);
  }
});

test("future offerings are preliminary and verified-year projected sources are rejected", () => {
  for (const fixture of fixtures.offeringCases) {
    const graduationYear = fixture.academicYear === "2026/2027" ? 2027 : 2028;
    const input = projectedInput({ ...fixture, graduationYear });
    const result = checkExternalEconomicsScheduleAndHorizon(input);
    assert.equal(result.status, fixture.expectedStatus, fixture.fixtureId);
    if (fixture.expectedCode) {
      assert.ok(
        result.violations.some(item => item.code === fixture.expectedCode),
        `${fixture.fixtureId}: ${fixture.expectedCode}`
      );
    }
  }
});

test("Summer is limited to ECO 113 and remains policy review until independently confirmed", () => {
  for (const fixture of fixtures.summerCases) {
    const input = projectedInput({
      fixtureId: fixture.fixtureId,
      academicYear: "2026/2027",
      termKey: "Summer",
      course: fixture.course,
      source: "summer-last-resort",
      graduationYear: 2028
    });
    input.expectedContext.startYear = 2026;
    input.expectedContext.remainingYears = 2;
    const result = checkExternalEconomicsScheduleAndHorizon(input);
    assert.equal(result.status, fixture.expectedStatus, fixture.fixtureId);
    if (fixture.course === "ECO 113") {
      assert.deepEqual(result.violations, [], fixture.fixtureId);
      assert.ok(
        result.reviewItems.some(item => item.code === "SUMMER_ECO113_CONFIRMATION_REQUIRED"),
        fixture.fixtureId
      );
    }
  }
});

test("terms outside the horizon and incomplete final allocation are rejected", () => {
  for (const fixture of fixtures.horizonCases) {
    const input = projectedInput({
      fixtureId: fixture.fixtureId,
      academicYear: fixture.academicYear,
      termKey: fixture.termKey,
      graduationYear: 2027
    });
    input.expectedContext = {
      startYear: 2026,
      remainingYears: 1,
      expectedGraduationYear: 2027,
      expectedGraduationTerm: "Spring/May 2027"
    };
    const result = checkExternalEconomicsScheduleAndHorizon(input);
    assert.ok(
      result.violations.some(item => item.code === "GRADUATION_TERM_OUTSIDE_HORIZON"),
      fixture.fixtureId
    );
  }

  const input = inputFromCompleteFixture();
  input.requirementAllocation = { allocation: completeAllocation.allocation.slice(0, 11) };
  const result = checkExternalEconomicsScheduleAndHorizon(input);
  assert.ok(result.violations.some(item => item.code === "GRADUATION_REQUIREMENTS_INCOMPLETE"));
});
