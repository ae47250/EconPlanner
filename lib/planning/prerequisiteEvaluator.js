import { requirementOptions } from "../policy/requirement-choices.js";
import { normalizeStudentCourses } from "../requirements/normalize.js";
import { auditStudentHistory } from "../decision-engine/student-history.js";
import { evaluatePrerequisites } from "../decision-engine/prerequisites.js";
import { normalizeStudentFacts } from "../decision-engine/student-facts.js";
import { canonicalTermId } from "../decision-engine/placement.js";
import { runtimePolicyBundle } from "../policy/compat-normalized.js";
import { prerequisitesForCatalogYear } from "../catalog/policy-releases.js";

const ACTIVE_STATUSES = new Set(["completed", "transfer", "in_progress"]);
const COMPLETED_STATUSES = new Set(["completed", "transfer"]);
const STATISTICS_OPTIONS = new Set(requirementOptions(runtimePolicyBundle(), "statistics"));
const STATISTICS_PLACEHOLDER = "Statistics requirement";
const COGNATE_OPTIONS = new Set(requirementOptions(runtimePolicyBundle(), "cognate"));
const COGNATE_PLACEHOLDER = "Mathematics cognate";

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
  const sameText = (left, right) => String(left ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase() === String(right ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  const sameCourse = (left, right) => String(left ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase() === String(right ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .toUpperCase();
  return recorded.some(item => (
    item?.code === required.code
    && sameText(item?.type, required.type)
    && sameText(item?.authority, required.authority)
    && sameCourse(item?.course, required.course)
    && sameCourse(item?.prerequisite, required.prerequisite)
    && sameText(item?.term, required.term)
    && sameText(item?.reason, required.reason)
    && sameText(item?.policySource, required.policySource)
    && sameText(item?.sourceRef, required.sourceRef)
  ));
}

function groupSatisfied(group, available) {
  if (group.some(code => available.has(code))) return true;
  if (group.every(code => STATISTICS_OPTIONS.has(code)) && available.has(STATISTICS_PLACEHOLDER)) return true;
  return group.every(code => COGNATE_OPTIONS.has(code)) && available.has(COGNATE_PLACEHOLDER);
}

function policyFor(rule, options) {
  return (rule?.concurrentWithApproval || []).find(policy => (
    options.some(code => (policy.options || []).includes(code))
  ));
}

function assessConcurrency({ course, prerequisite, rule, sameTerm, beforeTerm, term }) {
  const policy = policyFor(rule, [prerequisite]);
  if (!policy || !sameTerm.has(prerequisite)) return null;
  const options = policy.options || [];
  const concurrentCount = options.filter(code => sameTerm.has(code)).length;
  const completedCount = options.filter(code => beforeTerm.has(code)).length;
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
  prerequisites = {}
}) {
  const catalogYear = String(term?.academicYear || term?.catalogYear || "").replace("/", "-");
  const applicablePrerequisites = prerequisitesForCatalogYear(prerequisites, catalogYear);
  const rule = applicablePrerequisites?.[code];
  if (!rule) return { valid: true, missing: [], requiredApprovals: [] };
  const missing = [];
  const requiredApprovals = [];

  for (const required of rule.all || []) {
    if (beforeTerm.has(required)) continue;
    const approval = assessConcurrency({ course: code, prerequisite: required, rule, sameTerm, beforeTerm, term });
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
      ? assessConcurrency({ course: code, prerequisite: concurrent, rule, sameTerm, beforeTerm, term })
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
  requireRecordedApprovals = true,
  policyBundle = runtimePolicyBundle()
} = {}) {
  const errors = [];
  const engineErrors = [];
  const warnings = [];
  const requiredApprovals = [];
  const reviewFindings = [];
  const { completed, inProgress } = studentCourseSets(student);
  const facts = normalizeStudentFacts(student);
  const available = new Set(completed);

  const placements = termPlacements(plan);
  for (const term of plan.terms || []) {
    // Normal generated horizons exclude a term that has begun. The explicit
    // false flag is retained for legacy/current-term validation fixtures.
    if (term.inProgressPrerequisitesAvailable !== false) {
      for (const code of inProgress) available.add(code);
    }
    const sameTerm = new Set((term.courses || []).map(course => String(course.course || "").toUpperCase()).filter(Boolean));
    const beforeTerm = new Set(available);
    for (const course of term.courses || []) {
      if (course.fixedInProgress === true) continue;
      const code = course.course;
      if (!code || code === "ECO elective" || code === STATISTICS_PLACEHOLDER) continue;
      if (code === "ECO 461") {
        if (term.termKey !== "Winter") errors.push("ECO 461 must be placed in Winter.");
        if ((term.absoluteStandingIndex ?? -1) < 3) errors.push("ECO 461 requires projected senior standing.");
        if (course.residency !== "hanover") errors.push("ECO 461 must be completed at Hanover College.");
      }
      const hasPrerequisiteClaims = Array.isArray(course.prerequisiteClaims) && course.prerequisiteClaims.length > 0;
      const assessment = assessCoursePrerequisites({
        code,
        term,
        beforeTerm,
        sameTerm,
        prerequisites
      });
      const standalonePermissionRule = policyBundle.rules.find(rule => (
        rule.ruleType === "permissionException"
        && rule.condition.course === code
        && rule.effect.required
      ));
      const standalonePermission = standalonePermissionRule ? {
        code: "DEPARTMENT_PERMISSION_REQUIRED",
        type: "department",
        authority: standalonePermissionRule.effect.approvalAuthority || "Economics Department",
        course: code,
        prerequisite: null,
        term: term.term || term.label || null,
        reason: "department_permission",
        policySource: "department-confirmed-local-policy",
        sourceRef: standalonePermissionRule.sourceRefs[0],
        message: `${code} requires documented Economics Department permission.`
      } : null;
      for (const item of assessment.missing) {
        if (!hasPrerequisiteClaims) errors.push(`${code} is missing prerequisites: ${item.options.join(" / ")}.`);
      }
      for (const approval of assessment.requiredApprovals) {
        requiredApprovals.push(approval);
        if (requireRecordedApprovals && !approvalMatches(recordedApprovals(course), approval)) {
          const error = `${code} is concurrent with ${approval.prerequisite} but is not marked as requiring approval from the ${approval.authority}.`;
          errors.push(error);
        }
      }
      if (standalonePermission) requiredApprovals.push(standalonePermission);
      const engineCourse = requireRecordedApprovals
        ? course
        : {
            ...course,
            approvalRequired: [
              ...recordedApprovals(course),
              ...assessment.requiredApprovals,
              ...(standalonePermission ? [standalonePermission] : [])
            ]
          };
      const decision = evaluatePrerequisites(engineCourse, { ...term, termId: canonicalTermId(term) }, facts, policyBundle, {
        availableCourses: beforeTerm,
        sameTermCourses: sameTerm,
        approvalInstances: facts.approvals,
        uncertainTiming: String(term.termKey || "").toUpperCase() === "TBC",
        evaluationDate: facts.planCreationDate
      });
      if (decision.status === "REVIEW_REQUIRED") {
        reviewFindings.push(decision);
      } else if (decision.status === "BLOCK") {
        engineErrors.push(`${code} is missing prerequisites or a required permission: ${decision.requiredEvidence.join(" / ") || decision.reasonCode}.`);
      }
    }
    for (const code of sameTerm) available.add(code);
  }

  const uniqueApprovals = [...new Map(requiredApprovals.map(item => [
    `${item.course}:${item.prerequisite}:${item.term}:${item.type}`,
    item
  ])).values()];
  return {
    valid: engineErrors.length === 0,
    status: reviewFindings.length ? "REVIEW_REQUIRED" : engineErrors.length ? "BLOCK" : "ALLOW",
    errors: engineErrors.length ? [...new Set([...errors, ...engineErrors])] : [],
    warnings: [...new Set(warnings)],
    reviewFindings,
    requiredApprovals: uniqueApprovals,
    placements
  };
}

export function buildPrerequisiteStatusNotices({ plan = {}, student = {}, prerequisites = {} } = {}) {
  const recorded = new Map(normalizeStudentCourses(student.courses).map(course => [course.code, course.status]));
  const placements = (plan.terms || []).flatMap((term, termIndex) => (
    (term.courses || []).map(course => ({code: course.course, term, termIndex}))
  ));
  const placementByCode = new Map(placements
    .filter(item => item.code && item.code !== "ECO elective")
    .map(item => [item.code, item]));
  const notices = [];

  function pendingEvidence(options, dependent) {
    if (options.some(code => ["completed", "transfer"].includes(recorded.get(code)))) return null;
    const inProgress = options.find(code => recorded.get(code) === "in_progress");
    if (inProgress) return {code: inProgress, status: "IN_PROGRESS", term: "Current term"};
    const planned = options
      .map(code => placementByCode.get(code))
      .filter(item => item && item.termIndex < dependent.termIndex)
      .sort((left, right) => left.termIndex - right.termIndex || left.code.localeCompare(right.code))[0];
    return planned ? {code: planned.code, status: "PLANNED_EARLIER", term: planned.term.term} : null;
  }

  for (const dependent of placements) {
    const year = String(dependent.term?.academicYear || dependent.term?.catalogYear || "").replace("/", "-");
    const rule = prerequisitesForCatalogYear(prerequisites, year)[dependent.code];
    if (!rule) continue;
    const groups = [...(rule.all || []).map(code => [code]), ...(rule.any || [])];
    for (const options of groups) {
      const evidence = pendingEvidence(options, dependent);
      if (!evidence) continue;
      const code = evidence.status === "IN_PROGRESS"
        ? "PREREQUISITE_IN_PROGRESS_SUCCESS_PENDING"
        : "PREREQUISITE_PLANNED_SUCCESS_PENDING";
      const message = evidence.status === "IN_PROGRESS"
        ? `${evidence.code} is in progress; ${dependent.code} in ${dependent.term.term} depends on successful completion.`
        : `${evidence.code} is planned for ${evidence.term}; ${dependent.code} in ${dependent.term.term} depends on successful completion.`;
      notices.push({
        code,
        status: "PENDING_SUCCESS",
        prerequisiteStatus: evidence.status,
        prerequisite: evidence.code,
        prerequisiteTerm: evidence.term,
        dependentCourse: dependent.code,
        dependentTerm: dependent.term.term,
        message
      });
    }
  }

  return [...new Map(notices.map(notice => [
    `${notice.code}:${notice.prerequisite}:${notice.dependentCourse}:${notice.dependentTerm}`,
    notice
  ])).values()].sort((left, right) => (
    `${left.dependentTerm}:${left.dependentCourse}:${left.prerequisite}`
      .localeCompare(`${right.dependentTerm}:${right.dependentCourse}:${right.prerequisite}`)
  ));
}

function evaluateStudentPrerequisitesLegacy(courses = [], prerequisites = {}) {
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

export function evaluateStudentPrerequisites(courses = [], prerequisites = {}, { policyBundle = runtimePolicyBundle(), currentCatalogYear = null } = {}) {
  const legacy = evaluateStudentPrerequisitesLegacy(courses, prerequisites);
  const history = auditStudentHistory({ courses }, policyBundle);
  const normalized = normalizeStudentCourses(courses).filter(course => ACTIVE_STATUSES.has(course.status));
  const facts = normalizeStudentFacts({ courses });
  const completed = new Set(normalized.filter(course => COMPLETED_STATUSES.has(course.status)).map(course => course.code));
  const inProgress = new Set(normalized.filter(course => course.status === "in_progress").map(course => course.code));
  const engineIssues = [];

  for (const selected of normalized.filter(course => course.status === "in_progress")) {
    const raw = (courses || []).find(course => String(course?.code || "").toUpperCase() === selected.code) || selected;
    const conditionalApprovals = legacy.conditionalApprovals.filter(approval => approval.course === selected.code);
    const engineCourse = conditionalApprovals.length
      ? { ...raw, approvalRequired: [...recordedApprovals(raw), ...conditionalApprovals] }
      : raw;
    const decision = evaluatePrerequisites(engineCourse, { term: "Current term", academicYear: currentCatalogYear }, facts, policyBundle, {
      availableCourses: completed,
      sameTermCourses: inProgress,
      approvalInstances: facts.approvals,
      evaluationDate: facts.planCreationDate
    });
    if (decision.status === "BLOCK") {
      const options = decision.requiredEvidence.filter(value => value !== "DEPARTMENT_PERMISSION");
      engineIssues.push({
        code: options.length > 1 ? "MISSING_PREREQUISITE_GROUP" : "MISSING_PREREQUISITE",
        course: selected.code,
        targetStatus: selected.status,
        prerequisite: options.length === 1 ? options[0] : null,
        options: decision.requiredEvidence,
        ruleIds: decision.ruleIds,
        message: `${selected.code} requires ${decision.requiredEvidence.join(" / ")} before it can be in progress.`
      });
    }
  }

  const issues = currentCatalogYear
    ? engineIssues
    : legacy.issues.filter(issue => issue.targetStatus === "in_progress");
  return {
    valid: issues.length === 0,
    status: history.reviewFindings.length ? "REVIEW_REQUIRED" : issues.length ? "BLOCK" : "ALLOW",
    issues,
    reviewFindings: history.reviewFindings,
    conditionalApprovals: legacy.conditionalApprovals,
    decisions: [...history.decisions]
  };
}

export function selectedCourseStatus(courses = [], code) {
  return normalizeStudentCourses(courses).find(course => course.code === code)?.status || "not_started";
}
