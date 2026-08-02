import test from "node:test";
import assert from "node:assert/strict";
import { buildRequirementAllocation } from "../lib/planning/requirementAllocation.js";

const requirements = [
  {
    id: "finance",
    label: "ECO 321 / BUSN 323",
    kind: "choice",
    options: ["ECO 321", "BUSN 323"]
  },
  {
    id: "eco-elective-1",
    label: "ECO elective 1",
    kind: "elective",
    subject: "ECO",
    conditionalCourses: {
      "ECO 321": { slotId: "finance", assignedCode: "BUSN 323" }
    }
  }
];

function plan(courses) {
  return {
    terms: [{
      term: "Fall 2026",
      courses
    }]
  };
}

function allocate({ existingAssignments = [], plannedCourses = [] } = {}) {
  return buildRequirementAllocation({
    requirements,
    existingAssignments,
    plan: plan(plannedCourses)
  });
}

test("requirement allocation handles completed, in-progress, and planned Finance assignments consistently", () => {
  const planned = allocate({
    plannedCourses: [
      { course: "BUSN 323", requirementId: "finance" },
      { course: "ECO 321", requirementId: "eco-elective-1" }
    ]
  });
  assert.equal(planned.valid, true);

  const completed = allocate({
    existingAssignments: [{ slotId: "finance", code: "BUSN 323", status: "completed" }],
    plannedCourses: [{ course: "ECO 321", requirementId: "eco-elective-1" }]
  });
  assert.equal(completed.valid, true);

  const inProgress = allocate({
    existingAssignments: [{ slotId: "finance", code: "BUSN 323", status: "in_progress" }],
    plannedCourses: [{ course: "ECO 321", requirementId: "eco-elective-1" }]
  });
  assert.equal(inProgress.valid, true);
});

test("requirement allocation rejects double counts and invalid Finance/elective combinations", () => {
  const doubleCount = allocate({
    plannedCourses: [
      { course: "ECO 321", requirementId: "finance" },
      { course: "ECO 321", requirementId: "eco-elective-1" }
    ]
  });
  assert.equal(doubleCount.valid, false);
  assert.ok(doubleCount.errors.some(error => /both finance and eco-elective-1/.test(error)));

  const missingFinanceBusn = allocate({
    plannedCourses: [{ course: "ECO 321", requirementId: "eco-elective-1" }]
  });
  assert.equal(missingFinanceBusn.valid, false);
  assert.ok(missingFinanceBusn.errors.some(error => /BUSN 323 is assigned to finance/.test(error)));

  const busnAsElective = allocate({
    plannedCourses: [{ course: "BUSN 323", requirementId: "eco-elective-1" }]
  });
  assert.equal(busnAsElective.valid, false);
  assert.ok(busnAsElective.errors.some(error => /not a valid course for requirement eco-elective-1/.test(error)));
});
