import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validateCoursePrerequisites,
  validateStudentPrerequisites
} from "../lib/planning/prerequisiteValidation.js";
import {
  buildPrerequisiteFollowUp,
  unansweredPrerequisiteQuestions,
  selectedStatus as selectedFormStatus
} from "../lib/planning/prerequisiteFormValidation.js";
import { acceleratedMathSequenceNotes } from "../lib/planning/acceleratedMathSequence.js";

const prerequisites = JSON.parse(await readFile(
  new URL("../data/normalized/economics/prerequisites.json", import.meta.url),
  "utf8"
));

test("ECO 213 in progress with missing prerequisites is retained for advisor review", () => {
  const result = validateStudentPrerequisites([
    { code: "ECO 213", status: "in_progress" }
  ], prerequisites);

  assert.equal(result.valid, true);
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.deepEqual(result.issues, []);
  assert.equal(result.reviewFindings[0].reasonCode, "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW");
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

test("ECO 113 in progress does not count as completed history", () => {
  const result = validateStudentPrerequisites([
    { code: "ECO 113", status: "in_progress" },
    { code: "MAT 113", status: "completed" },
    { code: "ECO 213", status: "in_progress" }
  ], prerequisites);

  assert.equal(result.valid, true);
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.deepEqual(result.issues, []);
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
  assert.equal(blocked.valid, true);
  assert.equal(blocked.status, "REVIEW_REQUIRED");
  assert.deepEqual(blocked.issues, []);
});

test("form follow-up builds canonical required and alternative questions for a course taking now", () => {
  const result = buildPrerequisiteFollowUp({
    course: "ECO 213",
    targetStatus: "in_progress",
    courses: [],
    prerequisites
  });

  assert.equal(result.required, true);
  assert.equal(result.valid, true);
  assert.equal(result.status, "ALLOW");
  assert.deepEqual(result.questions.map(question => ({
    kind: question.kind,
    options: question.options,
    blocking: question.blocking
  })), [
    { kind: "required", options: ["ECO 113"], blocking: false },
    { kind: "one_of", options: ["MAT 113", "MAT 121"], blocking: false }
  ]);
  assert.deepEqual(result.conflicts, []);
});

test("completed-course follow-up asks the same canonical questions while the form gate awaits answers", () => {
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
  assert.deepEqual(unansweredPrerequisiteQuestions(result).map(question => question.options), [
    ["ECO 114"],
    ["MAT 113", "MAT 121"]
  ]);
  assert.equal(result.status, "ALLOW");
  assert.deepEqual(result.reviewFindings, []);
});

test("explicit uncertain answers resolve the form question, and clearing one restores it", () => {
  const courses = [
    { code: "ECO 114", status: "uncertain" },
    { code: "MAT 113", status: "uncertain" },
    { code: "MAT 121", status: "uncertain" }
  ];
  const answered = buildPrerequisiteFollowUp({
    course: "ECO 214",
    targetStatus: "completed",
    courses,
    prerequisites
  });

  assert.deepEqual(unansweredPrerequisiteQuestions(answered), []);
  assert.equal(answered.questions.length, 2);
  assert.ok(answered.questions.every(question => question.statuses.every(item => item.status === "uncertain")));

  const cleared = buildPrerequisiteFollowUp({
    course: "ECO 214",
    targetStatus: "completed",
    courses: courses.map(course => course.code === "MAT 121" ? { ...course, status: "not_started" } : course),
    prerequisites
  });
  assert.deepEqual(unansweredPrerequisiteQuestions(cleared).map(question => question.options), [
    ["MAT 113", "MAT 121"]
  ]);
});

test("prerequisites answered on the course cards do not produce follow-up questions", () => {
  for (const [course, prerequisite] of [["ECO 213", "ECO 113"], ["ECO 214", "ECO 114"]]) {
    const math = course === "ECO 213" ? "MAT 113" : "MAT 121";
    const result = buildPrerequisiteFollowUp({
      course,
      targetStatus: "in_progress",
      courses: [
        { code: prerequisite, status: "completed" },
        { code: math, status: "completed" }
      ],
      prerequisites
    });
    assert.equal(result.required, false, course);
    assert.deepEqual(unansweredPrerequisiteQuestions(result), [], course);
  }
});

for (const [math, economics] of [
  ["MAT 113", "ECO 213"],
  ["MAT 121", "ECO 213"],
  ["MAT 113", "ECO 214"],
  ["MAT 121", "ECO 214"]
]) {
  test(`${math} before ${economics} produces the prerequisite-first note`, () => {
    const notes = acceleratedMathSequenceNotes({
      isEarlyGraduation: true,
      terms: [
        { courses: [{ course: math }] },
        { courses: [{ course: economics }] }
      ]
    }, prerequisites);

    assert.equal(notes.length, 1);
    assert.match(notes[0], new RegExp(`Take ${math} before ${economics}`));
  });
}

for (const [math, economics] of [
  ["MAT 113", "ECO 213"],
  ["MAT 121", "ECO 213"],
  ["MAT 113", "ECO 214"],
  ["MAT 121", "ECO 214"]
]) {
  test(`concurrent ${math} and ${economics} produces no optional alternative note`, () => {
    const notes = acceleratedMathSequenceNotes({
      isEarlyGraduation: true,
      terms: [{ courses: [{ course: math }, { course: economics }] }]
    }, prerequisites);

    assert.deepEqual(notes, []);
  });
}

test("concurrent math for one intermediate does not suppress an earlier-math note for the other", () => {
  const notes = acceleratedMathSequenceNotes({
    isEarlyGraduation: true,
    terms: [
      { courses: [{ course: "MAT 121" }, { course: "ECO 213" }] },
      { courses: [{ course: "MAT 113" }, { course: "ECO 214" }] }
    ]
  }, prerequisites);

  assert.equal(notes.length, 1);
  assert.match(notes[0], /Take MAT 121 before ECO 214/);
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
  assert.deepEqual(result.conflicts, []);
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
