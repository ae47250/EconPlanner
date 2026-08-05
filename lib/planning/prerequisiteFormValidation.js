import { normalizeStudentCourses } from "../requirements/normalize.js";

const ACTIVE_STATUSES = new Set(["completed", "transfer", "in_progress"]);
const COMPLETED_STATUSES = new Set(["completed", "transfer"]);

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
  return {
    code: policy.reason === "concurrent_intermediate_with_capstone"
      ? "CONCURRENT_INTERMEDIATE_DEPARTMENT_APPROVAL"
      : "CONCURRENT_MATH_INSTRUCTOR_APPROVAL",
    type,
    approval: type,
    authority: type === "department" ? "Economics Department" : `${course} instructor`,
    course,
    prerequisite,
    reason: policy.reason || "concurrent_math",
    sourceRef: policy.sourceRef || null
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

export function selectedStatus(courses = [], code) {
  return normalizeStudentCourses(courses).find(course => course.code === code)?.status || "not_started";
}
