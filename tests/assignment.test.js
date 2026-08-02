import test from "node:test";
import assert from "node:assert/strict";
import { mapStudentToProgram } from "../lib/assignment/solve.js";

const economics = {
  id: "economics",
  name: "Economics",
  catalogYear: "2025-2026",
  sourceStatus: "APPROVED_LOCAL_SOURCE"
};

const requirements = {
  sourceStatus: "APPROVED_LOCAL_SOURCE",
  requirementSlots: [
    { id: "micro", label: "Micro", kind: "exact", options: ["ECO 113"], units: 1 },
    { id: "macro", label: "Macro", kind: "exact", options: ["ECO 114"], units: 1 },
    { id: "statistics", label: "Statistics", kind: "choice", options: ["MAT 217", "PSY 217"], provisionalOptions: ["PSY 217"], units: 1 },
    { id: "elective-1", label: "Elective 1", kind: "elective", subject: "ECO", excludedCourses: ["ECO 113", "ECO 114"], units: 1 },
    { id: "elective-2", label: "Elective 2", kind: "elective", subject: "ECO", excludedCourses: ["ECO 113", "ECO 114"], units: 1 }
  ]
};

test("global assignment prevents double counting", () => {
  const result = mapStudentToProgram(economics, requirements, {
    courses: [
      { code: "ECO 113", status: "completed", units: 1 },
      { code: "ECO 114", status: "completed", units: 1 },
      { code: "ECO 234", status: "completed", units: 1 }
    ]
  });

  assert.equal(result.strict.appliedUnits, 3);
  assert.equal(result.strict.remainingUnits, 2);
  assert.equal(result.strict.assignments.filter(item => item.code === "ECO 113").length, 1);
  assert.equal(result.unusedCourses.length, 0);
});

test("PHI 234 cross-listing counts as ECO 234 without approval", () => {
  const result = mapStudentToProgram(economics, requirements, {
    courses: [
      { code: "ECO 113", status: "completed", units: 1 },
      { code: "ECO 114", status: "completed", units: 1 },
      { code: "PHI 234", status: "completed", units: 1 }
    ]
  });

  assert.ok(result.strict.assignments.some(item => item.code === "ECO 234"));
  assert.equal(result.unusedCourses.length, 0);
});

test("ECO 234 and PHI 234 are one canonical course and cannot count twice", () => {
  const result = mapStudentToProgram(economics, requirements, {
    courses: [
      { code: "ECO 113", status: "completed", units: 1 },
      { code: "ECO 114", status: "completed", units: 1 },
      { code: "ECO 234", status: "completed", units: 1 },
      { code: "PHI 234", status: "completed", units: 1 }
    ]
  });

  assert.equal(result.strict.assignments.filter(item => item.code === "ECO 234").length, 1);
  assert.equal(result.strict.appliedUnits, 3);
});

test("Finance assigns BUSN 323 first and frees ECO 321 for an elective", () => {
  const financeRequirements = {
    sourceStatus: "APPROVED_LOCAL_SOURCE",
    requirementSlots: [
      {
        id: "finance",
        label: "Finance",
        kind: "choice",
        options: ["ECO 321", "BUSN 323"],
        preferredOptions: ["BUSN 323", "ECO 321"],
        units: 1
      },
      {
        id: "elective",
        label: "Elective",
        kind: "elective",
        subject: "ECO",
        excludedCourses: [],
        conditionalCourses: {
          "ECO 321": {
            slotId: "finance",
            assignedCode: "BUSN 323"
          }
        },
        units: 1
      }
    ]
  };

  const scenarios = [
    { courses: [], remaining: 2, finance: null, elective: null },
    { courses: [{ code: "ECO 321", status: "completed" }], remaining: 1, finance: "ECO 321", elective: null },
    { courses: [{ code: "BUSN 323", status: "completed" }], remaining: 1, finance: "BUSN 323", elective: null },
    {
      courses: [{ code: "ECO 321", status: "completed" }, { code: "BUSN 323", status: "completed" }],
      remaining: 0,
      finance: "BUSN 323",
      elective: "ECO 321"
    }
  ];

  for (const scenario of scenarios) {
    const result = mapStudentToProgram(economics, financeRequirements, { courses: scenario.courses });
    assert.equal(result.strict.remainingUnits, scenario.remaining);
    assert.equal(result.strict.assignments.find(item => item.slotId === "finance")?.code || null, scenario.finance);
    assert.equal(result.strict.assignments.find(item => item.slotId === "elective")?.code || null, scenario.elective);
  }
});

test("provisional transfer evidence separates strict and optimistic results", () => {
  const result = mapStudentToProgram(economics, requirements, {
    courses: [
      { code: "ECO 113", status: "completed", units: 1 },
      { code: "ECO 114", status: "completed", units: 1 },
      { code: "PSY 217", status: "transfer", units: 1 }
    ]
  });

  assert.equal(result.strict.remainingUnits, 3);
  assert.equal(result.optimistic.remainingUnits, 2);
  assert.equal(result.optimistic.assignments.find(item => item.code === "PSY 217").evidenceStatus, "PROVISIONAL");
});

test("in-progress courses only count in projected results", () => {
  const result = mapStudentToProgram(economics, requirements, {
    courses: [
      { code: "ECO 113", status: "completed", units: 1 },
      { code: "ECO 114", status: "in_progress", units: 1 }
    ]
  });

  assert.equal(result.strict.remainingUnits, 4);
  assert.equal(result.projectedAfterInProgress.strict.remainingUnits, 3);
});

test("Hanover-only capstone ignores transfer, AP, and uncertain evidence", () => {
  const capstone = {
    sourceStatus: "APPROVED_LOCAL_SOURCE",
    requirementSlots: [
      { id: "capstone", label: "ECO 461", kind: "exact", options: ["ECO 461"], residency: "hanover", units: 1 }
    ]
  };

  for (const course of [
    { code: "ECO 461", status: "transfer", source: "manual_code" },
    { code: "ECO 461", status: "completed", source: "ap_credit" },
    { code: "ECO 461", status: "uncertain", source: "title_only" }
  ]) {
    const result = mapStudentToProgram(economics, capstone, { courses: [course] });
    assert.equal(result.strict.assignments.length, 0);
    assert.equal(result.strict.remainingUnits, 1);
  }

  const HanoverResult = mapStudentToProgram(economics, capstone, {
    courses: [{ code: "ECO 461", status: "completed", source: "manual_code" }]
  });
  assert.equal(HanoverResult.strict.assignments[0].code, "ECO 461");
  assert.equal(HanoverResult.strict.remainingUnits, 0);
});
