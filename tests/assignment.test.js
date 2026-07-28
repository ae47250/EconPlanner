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
