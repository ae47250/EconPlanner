import {
  normalizeCourseCode,
  normalizeStudentCourses
} from "../requirements/normalize.js";

const ACTIVE_STATUSES = new Set(["completed", "transfer", "in_progress"]);
const COMPLETED_STATUSES = new Set(["completed", "transfer"]);
const FORM_TARGET_STATUSES = new Set(["completed", "transfer", "in_progress"]);
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

function groupSatisfied(group, available) {
  return group.some(code => available.has(code));
}

function concurrencyApproval(course, prerequisite, rule, sameTerm, completed) {
  const policy = (rule?.concurrentWithApproval || []).find(candidate => (
    (candidate.options || []).includes(prerequisite) && sameTerm.has(prerequisite)
  ));
  if (!policy) return null;
  const options = policy.options || [];
  if (policy.maxConcurrent && options.filter(code => sameTerm.has(code)).length > policy.maxConcurrent) return null;
  if (policy.requiresCompletedFromOptions
    && options.filter(code => completed.has(code)).length < policy.requiresCompletedFromOptions) return null;
  const type = policy.approval || "instructor";
  const authority = type === "department" ? "Economics Department" : `${course} instructor`;
  return {
    code: policy.reason === "concurrent_intermediate_with_capstone"
      ? "CONCURRENT_INTERMEDIATE_DEPARTMENT_APPROVAL"
      : "CONCURRENT_MATH_INSTRUCTOR_APPROVAL",
    type,
    approval: type,
    authority,
    course,
    prerequisite,
    reason: policy.reason || "concurrent_math",
    sourceRef: policy.sourceRef || null,
    message: type === "department"
      ? `${prerequisite} may be taken with ${course} only with Economics Department approval.`
      : `${prerequisite} may be taken with ${course} only with approval from the ${course} instructor.`
  };
}

export function validateStudentPrerequisites(courses = [], prerequisites = {}) {
  const normalized = normalizeStudentCourses(courses).filter(course => ACTIVE_STATUSES.has(course.status));
  const completed = new Set(normalized.filter(course => COMPLETED_STATUSES.has(course.status)).map(course => course.code));
  const inProgress = new Set(normalized.filter(course => course.status === "in_progress").map(course => course.code));
  const issues = [];
  const conditionalApprovals = [];

  for (const selected of normalized.filter(course => course.status === "in_progress")) {
    const rule = prerequisites[selected.code];
    if (!rule) continue;
    for (const prerequisite of rule.all || []) {
      if (completed.has(prerequisite)) continue;
      const approval = concurrencyApproval(selected.code, prerequisite, rule, inProgress, completed);
      if (approval) conditionalApprovals.push(approval);
      else issues.push({
        code: "MISSING_PREREQUISITE",
        course: selected.code,
        targetStatus: selected.status,
        prerequisite,
        options: [prerequisite],
        message: `${selected.code} requires ${prerequisite} before it can be in progress.`
      });
    }
    for (const group of rule.any || []) {
      if (groupSatisfied(group, completed)) continue;
      const concurrent = group.find(prerequisite => concurrencyApproval(
        selected.code,
        prerequisite,
        rule,
        inProgress,
        completed
      ));
      if (concurrent) conditionalApprovals.push(concurrencyApproval(
        selected.code,
        concurrent,
        rule,
        inProgress,
        completed
      ));
      else issues.push({
        code: "MISSING_PREREQUISITE_GROUP",
        course: selected.code,
        targetStatus: selected.status,
        prerequisite: null,
        options: [...group],
        message: `${selected.code} requires ${group.join(" / ")} before it can be in progress.`
      });
    }
  }

  return {
    valid: issues.length === 0,
    status: issues.length ? "BLOCK" : "ALLOW",
    issues,
    reviewFindings: [],
    conditionalApprovals
  };
}

export function validateCoursePrerequisites({ course, targetStatus, courses = [], prerequisites = {} }) {
  const nextCourses = courses.filter(item => item?.code !== course);
  nextCourses.push({ code: course, status: targetStatus });
  const result = validateStudentPrerequisites(nextCourses, prerequisites);
  const issues = result.issues.filter(issue => issue.course === course);
  const conditionalApprovals = result.conditionalApprovals.filter(approval => approval.course === course);
  return { valid: issues.length === 0, status: issues.length ? "BLOCK" : "ALLOW", issues, reviewFindings: [], conditionalApprovals };
}

function sameOptions(left = [], right = []) {
  return left.length === right.length && left.every((code, index) => code === right[index]);
}

function issueForGroup(issues, options) {
  return issues.find(issue => (
    sameOptions(issue.options || (issue.prerequisite ? [issue.prerequisite] : []), options)
  )) || null;
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

function prerequisiteQuestion({
  course,
  targetStatus,
  kind,
  index,
  options,
  courses,
  validation
}) {
  const statuses = options.map(code => ({
    code,
    status: formCourseStatus(courses, code)
  }));
  const completedOption = statuses.find(item => COMPLETED_STATUSES.has(item.status));
  const conditionalApproval = targetStatus === "in_progress"
    ? validation.conditionalApprovals.find(approval => options.includes(approval.prerequisite)) || null
    : null;
  if (completedOption || conditionalApproval) return null;

  const issue = issueForGroup(validation.issues, options);
  const blocking = Boolean(issue);
  const id = `prerequisite-${normalizeCourseCode(course).replace(/\s+/g, "-")}-${kind}-${index + 1}`;
  return {
    id,
    kind,
    course,
    targetStatus,
    prerequisite: kind === "required" ? options[0] : null,
    options: [...options],
    statuses,
    blocking,
    issueCode: issue?.code || null,
    issueMessage: issue?.message || null
  };
}

/**
 * Builds the form questions needed to explain a selected course's prerequisites.
 * The prerequisite groups and their order come only from the supplied canonical
 * prerequisite data. Blocking and conditional results come from the existing
 * form validator so this projection cannot introduce a new validation rule.
 */
export function buildPrerequisiteFollowUp({
  course,
  targetStatus,
  courses = [],
  prerequisites = {}
} = {}) {
  const canonicalCourse = normalizeCourseCode(course);
  const normalizedTargetStatus = String(targetStatus || "").trim().toLowerCase();
  const emptyResult = {
    course: canonicalCourse,
    targetStatus: normalizedTargetStatus,
    required: false,
    valid: true,
    status: "ALLOW",
    questions: [],
    conflicts: [],
    issues: [],
    reviewFindings: [],
    conditionalApprovals: []
  };
  if (!canonicalCourse || !FORM_TARGET_STATUSES.has(normalizedTargetStatus)) return emptyResult;

  const rule = prerequisites[canonicalCourse];
  if (!rule) return emptyResult;

  const validation = validateCoursePrerequisites({
    course: canonicalCourse,
    targetStatus: normalizedTargetStatus,
    courses,
    prerequisites
  });
  const groups = [
    ...(rule.all || []).map((code, index) => ({ kind: "required", index, options: [code] })),
    ...(rule.any || []).map((options, index) => ({ kind: "one_of", index, options: [...options] }))
  ];
  const questions = groups
    .map(group => prerequisiteQuestion({
      ...group,
      course: canonicalCourse,
      targetStatus: normalizedTargetStatus,
      courses,
      validation
    }))
    .filter(Boolean);
  const conflicts = questions.filter(question => question.blocking).map(question => ({
    code: "PREREQUISITE_STATUS_CONFLICT",
    dependentCourse: canonicalCourse,
    dependentStatus: normalizedTargetStatus,
    prerequisite: question.prerequisite,
    options: [...question.options],
    statuses: question.statuses.map(item => ({ ...item })),
    blocking: question.blocking,
    issueCode: question.issueCode,
    message: question.issueMessage
  }));

  return {
    course: canonicalCourse,
    targetStatus: normalizedTargetStatus,
    required: questions.length > 0,
    valid: validation.valid,
    status: validation.status,
    questions,
    conflicts,
    issues: validation.issues,
    reviewFindings: validation.reviewFindings,
    conditionalApprovals: validation.conditionalApprovals
  };
}

export function unansweredPrerequisiteQuestions(followUp = {}) {
  return (followUp.questions || []).filter(question => (
    !(question.kind === "one_of" && (question.statuses || []).some(item => ACTIVE_STATUSES.has(item.status)))
    &&
    (question.statuses || []).some(item => item.status === "not_started")
  ));
}

export function selectedStatus(courses = [], code) {
  return formCourseStatus(courses, code);
}
