import { createDecision } from "./contracts.js";

function approvalMatches(approval, dependentCourse, prerequisite, type) {
  const approvalType = String(approval?.type || approval?.authority || "").toUpperCase();
  return String(approval?.course || dependentCourse).toUpperCase() === dependentCourse
    && String(approval?.prerequisite || "").toUpperCase() === prerequisite
    && approvalType.includes(type);
}

export function evaluatePermission(rule, approvalInstances = [], { dependentCourse, prerequisite } = {}) {
  const expectedType = rule.ruleId.includes("MATH") ? "INSTRUCTOR" : "DEPARTMENT";
  return approvalInstances.some(approval => approvalMatches(approval, dependentCourse, prerequisite, expectedType));
}

export function evaluatePrerequisites(course, term, facts, bundle, {
  traceId,
  objectPath = "$",
  availableCourses = new Set(),
  sameTermCourses = new Set(),
  approvalInstances = []
} = {}) {
  const code = String(course?.course || course || "").toUpperCase();
  const rule = bundle.rules.find(candidate => candidate.ruleType === "coursePrerequisite" && candidate.condition.course === code);
  if (!rule) return createDecision({ bundle, traceId, status: "ALLOW", classification: "HARD", ruleIds: [], reasonCode: "NO_DECLARED_PREREQUISITE", subject: { course: code, termId: term?.termId || null }, objectPath });

  const approvals = [...approvalInstances, ...(course?.approvalRequired || [])];
  const unresolved = [];
  const concurrentApprovalCovers = prerequisite => {
    const permissionRule = bundle.rules.find(candidate => candidate.ruleType === "permissionException"
      && candidate.condition.dependentCourse === code
      && (candidate.condition.concurrentOptions || []).includes(prerequisite));
    return Boolean(permissionRule && sameTermCourses.has(prerequisite)
      && evaluatePermission(permissionRule, approvals, { dependentCourse: code, prerequisite }));
  };
  for (const prerequisite of rule.effect.allOf || []) {
    if (!availableCourses.has(prerequisite) && !concurrentApprovalCovers(prerequisite)) unresolved.push(prerequisite);
  }
  for (const group of rule.effect.oneOfGroups || []) {
    if (!group.some(prerequisite => availableCourses.has(prerequisite) || concurrentApprovalCovers(prerequisite))) unresolved.push(...group);
  }
  const permission = bundle.indexes.byRuleId[`PERMISSION-${code.replace(" ", "-")}`];
  if (permission?.effect.required && !approvals.some(approval => String(approval?.type || approval?.authority || "").toUpperCase().includes("DEPARTMENT"))) {
    unresolved.push("DEPARTMENT_PERMISSION");
  }
  return createDecision({
    bundle,
    traceId,
    status: unresolved.length ? "BLOCK" : "ALLOW",
    classification: "HARD",
    ruleIds: [rule.ruleId, ...(permission ? [permission.ruleId] : [])],
    reasonCode: unresolved.length ? "PREREQUISITE_NOT_SATISFIED" : "PREREQUISITES_SATISFIED",
    subject: { course: code, termId: term?.termId || null },
    objectPath,
    messageKeys: rule.messageKeys,
    messageParams: { missing: unresolved },
    sourceRefs: rule.sourceRefs,
    requiredEvidence: unresolved,
    requiredApproval: unresolved.includes("DEPARTMENT_PERMISSION") ? "ECONOMICS_DEPARTMENT" : null
  });
}
