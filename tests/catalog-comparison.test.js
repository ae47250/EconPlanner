import test from "node:test";
import assert from "node:assert/strict";
import { compareRequirementSnapshots } from "../lib/catalog/compare.js";

const base = {
  requirementSlots: [
    { id: "stats", label: "Statistics", kind: "choice", options: ["ECO 257"], units: 1 },
    { id: "electives", label: "ECO electives", kind: "elective", excludedCourses: ["ECO 307"], maxLevel100: 1, units: 4 }
  ],
  rules: { totalMajorCourses: 11, totalCognateCourses: 1, max100LevelElectives: 1 }
};

test("structural comparison identifies a more flexible newer catalog", () => {
  const newer = {
    requirementSlots: [
      { id: "stats", label: "Statistics", kind: "choice", options: ["ECO 257", "MAT 217"], units: 1 },
      { id: "electives", label: "ECO electives", kind: "elective", excludedCourses: [], maxLevel100: 1, units: 4 }
    ],
    rules: { totalMajorCourses: 11, totalCognateCourses: 1, max100LevelElectives: 1 }
  };
  const result = compareRequirementSnapshots(base, newer, {
    "ECO 461": { all: ["ECO 213", "ECO 214"], any: [] }
  }, {
    "ECO 461": { all: ["ECO 213"], any: [] }
  });

  assert.equal(result.status, "more_flexible");
  assert.ok(result.findings.some(item => item.code === "added_option"));
  assert.ok(result.findings.some(item => item.code === "fewer_exclusions"));
  assert.ok(result.findings.some(item => item.code === "removed_prerequisite"));
});

test("mixed structural changes require review instead of being called flexible", () => {
  const newer = {
    ...base,
    requirementSlots: [
      { id: "stats", label: "Statistics", kind: "choice", options: ["ECO 257", "MAT 217"], units: 1 },
      { id: "electives", label: "ECO electives", kind: "elective", excludedCourses: ["ECO 307"], maxLevel100: 1, units: 4 },
      { id: "new-rule", label: "New rule", kind: "exact", options: ["ECO 999"], units: 1 }
    ],
    rules: { totalMajorCourses: 12, totalCognateCourses: 1, max100LevelElectives: 1 }
  };
  const result = compareRequirementSnapshots(base, newer);

  assert.equal(result.status, "changed_review");
  assert.ok(result.favorable.length > 0);
  assert.ok(result.unfavorable.length > 0);
});
