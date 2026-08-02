import { normalizeStudentCourses } from "../requirements/normalize.js";

const ACTIVE_STATUSES = new Set(["completed", "transfer", "in_progress"]);
const COMPLETED_STATUSES = new Set(["completed", "transfer"]);
const STATISTICS_OPTIONS = new Set(["ECO 257", "MAT 217", "PSY 217"]);
const STATISTICS_PLACEHOLDER = "Statistics requirement";

function recordedApprovals(course = {}) {
  if (Array.isArray(course.approvalRequired)) return course.approvalRequired;
  return course.approvalRequired ? [course.approvalRequired] : [];
}

function approvalCode(policy = {}) {
  return policy.reason === "concurrent_intermediate_with_capstone"
    ? "CONCURRENT_INTERMEDIATE_DEPARTMENT_APPROVAL"
    : "CONCURRENT_MATH_INSTRUCTOR_APPROVAL";
}

function approvalFor(course, prerequisite, policy, term) {
  const type = policy.approval || "instructor";
  const authority = type === "department" ? "Economics Department" : `${course} instructor`;
  return {
    code: approvalCode(policy),
    type,
    authority,
    course,
    prerequisite,
    term: term?.term || term?.label || term?.termKey || null,
    reason: policy.reason || "concurrent_math",
    policySource: policy.policySource || "department-confirmed-local-policy",
    sourceRef: policy.sourceRef || "data/raw/economics/Department_Confirmed_Planning_Policies.md",
    message: type === "department"
      ? `${prerequisite} is planned concurrently with ${course}. Economics Department approval is required.`
      : `${prerequisite} is planned concurrently with ${course}. Approval from the ${course} instructor is required.`
  };
}

function approvalMatches(recorded, required) {
  return recorded.some(item => (
    item?.type === required.type
    && item?.reason === required.reason
    && item?.prerequisite === required.prerequisite
  ));
}

function groupSatisfied(group, available) {
  if (group.some(code => available.has(code))) return true;
  return group.every(code => STATISTICS_OPTIONS.has(code)) && available.has(STATISTICS_PLACEHOLDER);
}

function policyFor(rule, options) {
  return (rule?.concurrentWithApproval || []).find(policy => (
    options.some(code => (policy.options || []).includes(code))
  ));
}

function assessConcurrency({ course, prerequisite, rule, sameTerm, beforeTerm, completedBeforePlan = beforeTerm, term }) {
  const policy = policyFor(rule, [prerequisite]);
  if (!policy || !sameTerm.has(prerequisite)) return null;
  const options = policy.options || [];
  const concurrentCount = options.filter(code => sameTerm.has(code)).length;
  const completedCount = options.filter(code => completedBeforePlan.has(code)).length;
  if (policy.maxConcurrent && concurrentCount > policy.maxConcurrent) return null;
  if (policy.requiresCompletedFromOptions && completedCount < policy.requiresCompletedFromOptions) return null;
  return approvalFor(course, prerequisite, policy, term);
}

function termPlacements(plan = {}) {
  const placements = [];
  for (const [position, term] of (plan.terms || []).entries()) {
    for (const course of term.courses || []) {
      if (!course?.course || course.course === "ECO elective") continue;
      placements.push({ course, code: course.course, term, position });
    }
  }
  return placements;
}

function studentCourseSets(student = {}) {
  const completed = new Set();
  const inProgress = new Set();
  for (const course of normalizeStudentCourses(student.courses)) {
    if (COMPLETED_STATUSES.has(course.status)) completed.add(course.code);
    if (course.status === "in_progress") inProgress.add(course.code);
  }
  return { completed, inProgress };
}

export function prerequisiteClosure(code, prerequisites = {}, seen = new Set()) {
  if (!code || seen.has(code)) return new Set();
  const nextSeen = new Set(seen).add(code);
  const closure = new Set();
  const rule = prerequisites?.[code];
  for (const required of rule?.all || []) {
    closure.add(required);
    for (const nested of prerequisiteClosure(required, prerequisites, nextSeen)) closure.add(nested);
  }
  for (const group of rule?.any || []) {
    for (const option of group) {
      closure.add(option);
      for (const nested of prerequisiteClosure(option, prerequisites, nextSeen)) closure.add(nested);
    }
  }
  return closure;
}

export function assessCoursePrerequisites({
  code,
  term,
  beforeTerm = new Set(),
  sameTerm = new Set(),
  completedBeforePlan = beforeTerm,
  prerequisites = {}
}) {
  const rule = prerequisites?.[code];
  if (!rule) return { valid: true, missing: [], requiredApprovals: [] };
  const missing = [];
  const requiredApprovals = [];

  for (const required of rule.all || []) {
    if (beforeTerm.has(required)) continue;
    const approval = assessConcurrency({ course: code, prerequisite: required, rule, sameTerm, beforeTerm, completedBeforePlan, term });
    if (approval) requiredApprovals.push(approval);
    else missing.push({ prerequisite: required, options: [required] });
  }

  for (const group of rule.any || []) {
    if (groupSatisfied(group, beforeTerm)) continue;
    const policy = policyFor(rule, group);
    const concurrent = policy
      ? group.find(option => sameTerm.has(option) && (policy.options || []).includes(option))
      : null;
    const approval = concurrent
      ? assessConcurrency({ course: code, prerequisite: concurrent, rule, sameTerm, beforeTerm, completedBeforePlan, term })
      : null;
    if (approval) requiredApprovals.push(approval);
    else missing.push({ prerequisite: null, options: [...group] });
  }

  return { valid: missing.length === 0, missing, requiredApprovals };
}

export function evaluatePlanPrerequisites({
  plan = {},
  student = {},
  prerequisites = {},
  context: _context = null,
  requireRecordedApprovals = true
} = {}) {
  const errors = [];
  const warnings = [];
  const requiredApprovals = [];
  const { completed, inProgress } = studentCourseSets(student);
  const available = new Set(completed);

  const placements = termPlacements(plan);
  for (const term of plan.terms || []) {
    // Normal generated horizons exclude a term that has begun. The explicit
    // false flag is retained for legacy/current-term validation fixtures.
    if (term.inProgressPrerequisitesAvailable !== false) {
      for (const code of inProgress) available.add(code);
    }
    const sameTerm = new Set((term.courses || []).map(course => course.course).filter(Boolean));
    const beforeTerm = new Set(available);
    for (const course of term.courses || []) {
      const code = course.course;
      if (!code || code === "ECO elective" || code === STATISTICS_PLACEHOLDER) continue;
      if (code === "ECO 461") {
        if (term.termKey !== "Winter") errors.push("ECO 461 must be placed in Winter.");
        if ((term.absoluteStandingIndex ?? -1) < 3) errors.push("ECO 461 requires projected senior standing.");
        if (course.residency !== "hanover") errors.push("ECO 461 must be completed at Hanover College.");
      }
      const assessment = assessCoursePrerequisites({
        code,
        term,
        beforeTerm,
        sameTerm,
        completedBeforePlan: completed,
        prerequisites
      });
      for (const item of assessment.missing) {
        errors.push(`${code} is missing prerequisites: ${item.options.join(" / ")}.`);
      }
      for (const approval of assessment.requiredApprovals) {
        requiredApprovals.push(approval);
        if (requireRecordedApprovals && !approvalMatches(recordedApprovals(course), approval)) {
          errors.push(`${code} is concurrent with ${approval.prerequisite} but is not marked as requiring approval from the ${approval.authority}.`);
        }
      }
    }
    for (const code of sameTerm) available.add(code);
  }

  const uniqueApprovals = [...new Map(requiredApprovals.map(item => [
    `${item.course}:${item.prerequisite}:${item.term}:${item.type}`,
    item
  ])).values()];
  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    requiredApprovals: uniqueApprovals,
    placements
  };
}

export function evaluateStudentPrerequisites(courses = [], prerequisites = {}) {
  const normalized = normalizeStudentCourses(courses).filter(course => ACTIVE_STATUSES.has(course.status));
  const completed = new Set(normalized.filter(course => COMPLETED_STATUSES.has(course.status)).map(course => course.code));
  const inProgress = new Set(normalized.filter(course => course.status === "in_progress").map(course => course.code));
  const issues = [];
  const conditionalApprovals = [];

  for (const selected of normalized) {
    const beforeTerm = selected.status === "in_progress"
      ? completed
      : new Set([...completed].filter(code => code !== selected.code));
    const sameTerm = selected.status === "in_progress" ? inProgress : new Set();
    const assessment = assessCoursePrerequisites({
      code: selected.code,
      term: { term: "Current term" },
      beforeTerm,
      sameTerm,
      completedBeforePlan: completed,
      prerequisites
    });
    for (const missing of assessment.missing) {
      const choices = missing.options;
      issues.push({
        code: choices.length > 1 ? "MISSING_PREREQUISITE_GROUP" : "MISSING_PREREQUISITE",
        course: selected.code,
        targetStatus: selected.status,
        prerequisite: choices.length === 1 ? choices[0] : null,
        options: choices,
        message: `${selected.code} requires ${choices.join(" / ")} before it can be ${selected.status === "in_progress" ? "in progress" : "marked taken"}.`
      });
    }
    conditionalApprovals.push(...assessment.requiredApprovals.map(approval => ({
      ...approval,
      approval: approval.type
    })));
  }

  return {
    valid: issues.length === 0,
    issues: [...new Map(issues.map(item => [
      `${item.code}:${item.course}:${item.options.join("|")}`,
      item
    ])).values()],
    conditionalApprovals: [...new Map(conditionalApprovals.map(item => [
      `${item.course}:${item.prerequisite}`,
      item
    ])).values()]
  };
}

export function selectedCourseStatus(courses = [], code) {
  return normalizeStudentCourses(courses).find(course => course.code === code)?.status || "not_started";
}
