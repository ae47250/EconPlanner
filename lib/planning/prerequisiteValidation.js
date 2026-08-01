const COMPLETED_STATUSES = new Set(["completed", "transfer"]);
const ACTIVE_STATUSES = new Set([...COMPLETED_STATUSES, "in_progress"]);

function courseStatusMap(courses = []) {
  const statuses = new Map();
  for (const course of courses) {
    if (!course?.code || !ACTIVE_STATUSES.has(course.status)) continue;
    statuses.set(course.code, course.status);
  }
  return statuses;
}

function completed(statuses, code) {
  return COMPLETED_STATUSES.has(statuses.get(code));
}

function concurrentPolicyFor(rule, options) {
  return (rule?.concurrentWithApproval || []).find(policy => (
    options.some(code => (policy.options || []).includes(code))
  ));
}

function approvalCode(policy) {
  return policy?.reason === "concurrent_intermediate_with_capstone"
    ? "CONCURRENT_INTERMEDIATE_DEPARTMENT_APPROVAL"
    : "CONCURRENT_MATH_INSTRUCTOR_APPROVAL";
}

function conditionalApproval(course, prerequisite, policy) {
  const approval = policy.approval || "instructor";
  const authority = approval === "department"
    ? "Economics Department"
    : `${course} instructor`;
  return {
    code: approvalCode(policy),
    course,
    prerequisite,
    approval,
    reason: policy.reason || "concurrent_math",
    policySource: policy.policySource || "department-approved",
    message: `${course} and ${prerequisite} are both in progress. Concurrent enrollment requires approval from the ${authority}.`
  };
}

function allPrerequisiteConcurrency(rule, required, statuses, targetStatus) {
  if (targetStatus !== "in_progress" || statuses.get(required) !== "in_progress") return null;
  const policy = (rule?.concurrentWithApproval || []).find(item => (item.options || []).includes(required));
  if (!policy) return null;
  const options = policy.options || [];
  const concurrentCount = options.filter(code => statuses.get(code) === "in_progress").length;
  const completedCount = options.filter(code => completed(statuses, code)).length;
  if (policy.maxConcurrent && concurrentCount > policy.maxConcurrent) return null;
  if (policy.requiresCompletedFromOptions && completedCount < policy.requiresCompletedFromOptions) return null;
  return policy;
}

function prerequisiteIssue(course, targetStatus, prerequisite, options = []) {
  const choices = options.length ? options : [prerequisite];
  const label = choices.join(" / ");
  const action = targetStatus === "in_progress" ? "before it can be in progress" : "before it can be marked taken";
  return {
    code: options.length ? "MISSING_PREREQUISITE_GROUP" : "MISSING_PREREQUISITE",
    course,
    targetStatus,
    prerequisite: options.length ? null : prerequisite,
    options: choices,
    message: `${course} requires ${label} to be taken ${action}.`
  };
}

export function validateCoursePrerequisites({
  course,
  targetStatus,
  courses = [],
  prerequisites = {}
}) {
  const rule = prerequisites?.[course];
  if (!rule || !ACTIVE_STATUSES.has(targetStatus)) {
    return { valid: true, issues: [], conditionalApprovals: [] };
  }

  const statuses = courseStatusMap(courses);
  statuses.set(course, targetStatus);
  const issues = [];
  const conditionalApprovals = [];

  for (const required of rule.all || []) {
    if (completed(statuses, required)) continue;
    const policy = allPrerequisiteConcurrency(rule, required, statuses, targetStatus);
    if (policy) {
      conditionalApprovals.push(conditionalApproval(course, required, policy));
      continue;
    }
    issues.push(prerequisiteIssue(course, targetStatus, required));
  }

  for (const group of rule.any || []) {
    if (group.some(option => completed(statuses, option))) continue;

    const policy = targetStatus === "in_progress"
      ? concurrentPolicyFor(rule, group)
      : null;
    const concurrentCode = policy
      ? group.find(option => statuses.get(option) === "in_progress" && (policy.options || []).includes(option))
      : null;

    if (concurrentCode) {
      conditionalApprovals.push(conditionalApproval(course, concurrentCode, policy));
      continue;
    }

    issues.push(prerequisiteIssue(course, targetStatus, null, group));
  }

  return {
    valid: issues.length === 0,
    issues,
    conditionalApprovals
  };
}

export function validateStudentPrerequisites(courses = [], prerequisites = {}) {
  const issues = [];
  const conditionalApprovals = [];

  for (const selectedCourse of courses) {
    if (!ACTIVE_STATUSES.has(selectedCourse?.status) || !prerequisites?.[selectedCourse.code]) continue;
    const result = validateCoursePrerequisites({
      course: selectedCourse.code,
      targetStatus: selectedCourse.status,
      courses,
      prerequisites
    });
    issues.push(...result.issues);
    conditionalApprovals.push(...result.conditionalApprovals);
  }

  const uniqueIssues = [...new Map(issues.map(issue => [
    `${issue.code}:${issue.course}:${issue.prerequisite || issue.options.join("|")}`,
    issue
  ])).values()];
  const uniqueApprovals = [...new Map(conditionalApprovals.map(approval => [
    `${approval.course}:${approval.prerequisite}`,
    approval
  ])).values()];

  return {
    valid: uniqueIssues.length === 0,
    issues: uniqueIssues,
    conditionalApprovals: uniqueApprovals
  };
}

export function selectedStatus(courses = [], code) {
  return courseStatusMap(courses).get(code) || "not_started";
}
