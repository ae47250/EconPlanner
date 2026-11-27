import {
  normalizeCourseCode,
  normalizeStudentCourses
} from "../requirements/normalize.js";

// The course form's prerequisite questions. This file decides only which prerequisite courses to ask
// about while the student fills in the form; it never blocks a plan. Whether prerequisites are met is
// decided once, on the server (lib/decision-engine/prerequisites.js). The groups come from the same
// compiled prerequisite data. (Owner decision 2026-11-27: the always-passing "blocked" path, its
// conflict message and its unused approval sentences were removed.)

const ACTIVE_STATUSES = new Set(["completed", "transfer", "in_progress"]);
const COMPLETED_STATUSES = new Set(["completed", "transfer"]);
const FORM_COURSE_STATUSES = new Set([
  "completed",
  "transfer",
  "in_progress",
  "not_started",
  "uncertain",
  "repeated",
  "failed",
  "withdrawn"
]);

// A prerequisite taken in the same term as the course, under a pairing the rules allow with approval
// (for example MAT 121 with ECO 213): nothing to ask, the approval is explained after planning.
function allowedSameTerm(prerequisite, rule, sameTerm, completed) {
  const policy = (rule?.concurrentWithApproval || []).find(candidate => (
    (candidate.options || []).includes(prerequisite) && sameTerm.has(prerequisite)
  ));
  if (!policy) return false;
  const options = policy.options || [];
  if (policy.maxConcurrent && options.filter(code => sameTerm.has(code)).length > policy.maxConcurrent) return false;
  if (policy.requiresCompletedFromOptions
    && options.filter(code => completed.has(code)).length < policy.requiresCompletedFromOptions) return false;
  return true;
}

function formCourseStatus(courses, code) {
  const canonicalCode = normalizeCourseCode(code);
  const rawCourse = (Array.isArray(courses) ? courses : []).find(course => (
    normalizeCourseCode(course?.code) === canonicalCode
  ));
  if (!rawCourse) return "not_started";

  const rawStatus = String(rawCourse.status || "").trim().toLowerCase();
  if (FORM_COURSE_STATUSES.has(rawStatus)) return rawStatus;
  return normalizeStudentCourses([rawCourse])[0]?.status || "uncertain";
}

/**
 * The form questions for a selected course's prerequisites, in the order of the prerequisite data.
 */
export function buildPrerequisiteFollowUp({
  course,
  targetStatus,
  courses = [],
  prerequisites = {}
} = {}) {
  const canonicalCourse = normalizeCourseCode(course);
  const normalizedTargetStatus = String(targetStatus || "").trim().toLowerCase();
  const empty = { course: canonicalCourse, targetStatus: normalizedTargetStatus, required: false, questions: [] };
  if (!canonicalCourse || !ACTIVE_STATUSES.has(normalizedTargetStatus)) return empty;
  const rule = prerequisites[canonicalCourse];
  if (!rule) return empty;

  const others = (Array.isArray(courses) ? courses : []).filter(item => normalizeCourseCode(item?.code) !== canonicalCourse);
  const active = normalizeStudentCourses([...others, { code: canonicalCourse, status: normalizedTargetStatus }])
    .filter(item => ACTIVE_STATUSES.has(item.status));
  const completed = new Set(active.filter(item => COMPLETED_STATUSES.has(item.status)).map(item => item.code));
  const sameTerm = new Set(active.filter(item => item.status === "in_progress").map(item => item.code));

  const groups = [
    ...(rule.all || []).map((code, index) => ({ kind: "required", index, options: [code] })),
    ...(rule.any || []).map((options, index) => ({ kind: "one_of", index, options: [...options] }))
  ];
  const questions = groups.map(({ kind, index, options }) => {
    const statuses = options.map(code => ({ code, status: formCourseStatus(courses, code) }));
    if (statuses.some(item => COMPLETED_STATUSES.has(item.status))) return null;
    if (normalizedTargetStatus === "in_progress"
      && options.some(code => !completed.has(code) && allowedSameTerm(code, rule, sameTerm, completed))) return null;
    return {
      id: `prerequisite-${canonicalCourse.replace(/\s+/g, "-")}-${kind}-${index + 1}`,
      kind,
      course: canonicalCourse,
      targetStatus: normalizedTargetStatus,
      prerequisite: kind === "required" ? options[0] : null,
      options: [...options],
      statuses
    };
  }).filter(Boolean);

  return { course: canonicalCourse, targetStatus: normalizedTargetStatus, required: questions.length > 0, questions };
}

export function unansweredPrerequisiteQuestions(followUp = {}) {
  return (followUp.questions || []).filter(question => (
    !(question.kind === "one_of" && (question.statuses || []).some(item => ACTIVE_STATUSES.has(item.status)))
    &&
    (question.statuses || []).some(item => item.status === "not_started")
  ));
}
