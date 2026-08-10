import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validateCoursePrerequisites,
  validateStudentPrerequisites
} from "../lib/planning/prerequisiteValidation.js";
import {
  buildPrerequisiteFollowUp,
  selectedStatus as selectedFormStatus
} from "../lib/planning/prerequisiteFormValidation.js";

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
  assert.equal(result.reviewFindings[0].reasonCode, "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW");
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

test("form follow-up builds canonical required and alternative questions for a course taking now", () => {
  const result = buildPrerequisiteFollowUp({
    course: "ECO 213",
    targetStatus: "in_progress",
    courses: [],
    prerequisites
  });

  assert.equal(result.required, true);
  assert.equal(result.valid, false);
  assert.equal(result.status, "BLOCK");
  assert.deepEqual(result.questions.map(question => ({
    kind: question.kind,
    options: question.options,
    blocking: question.blocking
  })), [
    { kind: "required", options: ["ECO 113"], blocking: true },
    { kind: "one_of", options: ["MAT 113", "MAT 121"], blocking: true }
  ]);
  assert.deepEqual(result.conflicts.map(conflict => conflict.code), [
    "PREREQUISITE_STATUS_CONFLICT",
    "PREREQUISITE_STATUS_CONFLICT"
  ]);
});

test("completed-course follow-up asks the same canonical questions without creating a new block", () => {
  const result = buildPrerequisiteFollowUp({
    course: "ECO 214",
    targetStatus: "completed",
    courses: [],
    prerequisites
  });

  assert.equal(result.required, true);
  assert.equal(result.valid, true);
  assert.equal(result.status, "ALLOW");
  assert.deepEqual(result.questions.map(question => question.options), [
    ["ECO 114"],
    ["MAT 113", "MAT 121"]
  ]);
  assert.ok(result.questions.every(question => question.blocking === false));
  assert.deepEqual(result.conflicts, []);
});

test("alternative follow-up preserves not-started and uncertain statuses as unsatisfied", () => {
  const courses = [
    { code: "ECO 113", status: "completed" },
    { code: "MAT 113", status: "uncertain" },
    { code: "MAT 121", status: "not_started" }
  ];
  const result = buildPrerequisiteFollowUp({
    course: "ECO 213",
    targetStatus: "in_progress",
    courses,
    prerequisites
  });

  assert.equal(selectedFormStatus(courses, "MAT 113"), "uncertain");
  assert.equal(selectedFormStatus(courses, "MAT 121"), "not_started");
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].kind, "one_of");
  assert.deepEqual(result.questions[0].options, ["MAT 113", "MAT 121"]);
  assert.deepEqual(result.questions[0].statuses, [
    { code: "MAT 113", status: "uncertain" },
    { code: "MAT 121", status: "not_started" }
  ]);
  assert.deepEqual(result.conflicts[0].statuses, result.questions[0].statuses);
  assert.equal(result.conflicts[0].blocking, true);
});

test("approved current-term prerequisite paths produce metadata instead of a follow-up conflict", () => {
  const result = buildPrerequisiteFollowUp({
    course: "ECO 213",
    targetStatus: "in_progress",
    courses: [
      { code: "ECO 113", status: "completed" },
      { code: "MAT 113", status: "in_progress" }
    ],
    prerequisites
  });

  assert.equal(result.required, false);
  assert.equal(result.valid, true);
  assert.deepEqual(result.questions, []);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.conditionalApprovals.length, 1);
  assert.equal(result.conditionalApprovals[0].prerequisite, "MAT 113");
});
