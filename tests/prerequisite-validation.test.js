import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validateCoursePrerequisites,
  validateStudentPrerequisites
} from "../lib/planning/prerequisiteValidation.js";

const prerequisites = JSON.parse(await readFile(
  new URL("../data/normalized/economics/prerequisites.json", import.meta.url),
  "utf8"
));

test("ECO 213 in progress is blocked when its prerequisites are missing", () => {
  const result = validateStudentPrerequisites([
    { code: "ECO 213", status: "in_progress" }
  ], prerequisites);

  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map(issue => issue.options?.length ? issue.options : [issue.prerequisite]), [
    ["ECO 113"],
    ["MAT 113", "MAT 121"]
  ]);
});

test("completed ECO 113 and MAT 113 allow ECO 213 in progress without approval", () => {
  const result = validateStudentPrerequisites([
    { code: "ECO 113", status: "completed" },
    { code: "MAT 113", status: "completed" },
    { code: "ECO 213", status: "in_progress" }
  ], prerequisites);

  assert.equal(result.valid, true);
  assert.deepEqual(result.conditionalApprovals, []);
});

test("concurrent math allows ECO 213 in progress only with an approval notice", () => {
  const result = validateStudentPrerequisites([
    { code: "ECO 113", status: "completed" },
    { code: "MAT 113", status: "in_progress" },
    { code: "ECO 213", status: "in_progress" }
  ], prerequisites);

  assert.equal(result.valid, true);
  assert.equal(result.conditionalApprovals.length, 1);
  assert.equal(result.conditionalApprovals[0].course, "ECO 213");
  assert.equal(result.conditionalApprovals[0].prerequisite, "MAT 113");
  assert.match(result.conditionalApprovals[0].message, /instructor/);
});

test("ECO 113 in progress does not unlock ECO 213", () => {
  const result = validateStudentPrerequisites([
    { code: "ECO 113", status: "in_progress" },
    { code: "MAT 113", status: "completed" },
    { code: "ECO 213", status: "in_progress" }
  ], prerequisites);

  assert.equal(result.valid, false);
  assert.ok(result.issues.some(issue => issue.prerequisite === "ECO 113"));
});

test("completed target courses are retained with a historical-evidence review", () => {
  const result = validateCoursePrerequisites({
    course: "ECO 214",
    targetStatus: "completed",
    courses: [
      { code: "ECO 114", status: "completed" },
      { code: "MAT 121", status: "in_progress" }
    ],
    prerequisites
  });

  assert.equal(result.valid, true);
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.deepEqual(result.conditionalApprovals, []);
  assert.deepEqual(result.issues, []);
  assert.equal(result.reviewFindings[0].reasonCode, "COURSE_HISTORY_EVIDENCE_FACT_REQUIRED");
});

test("ECO 214 supports the same MAT 121 concurrency rule but not concurrent ECO 114", () => {
  const allowed = validateStudentPrerequisites([
    { code: "ECO 114", status: "completed" },
    { code: "MAT 121", status: "in_progress" },
    { code: "ECO 214", status: "in_progress" }
  ], prerequisites);
  const blocked = validateStudentPrerequisites([
    { code: "ECO 114", status: "in_progress" },
    { code: "MAT 121", status: "completed" },
    { code: "ECO 214", status: "in_progress" }
  ], prerequisites);

  assert.equal(allowed.valid, true);
  assert.equal(allowed.conditionalApprovals[0].prerequisite, "MAT 121");
  assert.equal(blocked.valid, false);
  assert.ok(blocked.issues.some(issue => issue.prerequisite === "ECO 114"));
});
