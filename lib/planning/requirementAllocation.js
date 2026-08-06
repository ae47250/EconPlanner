import { createHash } from "node:crypto";
import { evaluateRequirementAllocation } from "../decision-engine/requirements.js";
import { runtimePolicyBundle } from "../policy/compat-normalized.js";
import { canonicalJson } from "../policy/canonical-json.js";

const GENERIC_REQUIREMENT_COURSES = new Set([
  "ECO elective",
  "Statistics requirement",
  "Mathematics cognate",
  "Finance requirement"
]);
const allocationEligibilityCache = new Map();

function isConcreteCourse(code) {
  return Boolean(code) && !GENERIC_REQUIREMENT_COURSES.has(code);
}

function matchesRequirementShape(requirement, code) {
  if (!requirement || !code) return false;
  if (code === "Statistics requirement") return requirement.id === "statistics";
  if (code === "Mathematics cognate") return requirement.id === "cognate";
  if (code === "Finance requirement") return requirement.id === "finance";
  if (code === "ECO elective") return requirement.kind === "elective";

  if (requirement.kind === "elective") {
    if (!String(code).startsWith(`${requirement.subject || "ECO"} `)) return false;
    if ((requirement.excludedCourses || []).includes(code)) return false;
    return true;
  }

  return (requirement.options || []).includes(code);
}

function conditionFor(requirement, code) {
  return requirement?.conditionalCourses?.[code] || null;
}

function conditionIsSatisfied(condition, assignments) {
  if (!condition) return true;
  return assignments.some(assignment => (
    assignment.slotId === condition.slotId
    && assignment.code === condition.assignedCode
  ));
}

function normalizeExistingAssignments(assignments = []) {
  return assignments
    .filter(item => item?.slotId && item?.code)
    .map(item => ({
      slotId: item.slotId,
      code: item.code,
      source: "completed_or_in_progress",
      status: item.status || null,
      courseId: item.courseId || null
    }));
}

function plannedAssignmentsFromPlan(plan = {}) {
  return (plan.terms || []).flatMap((term, termIndex) => (
    (term.courses || [])
      .filter(course => course?.requirementId && course?.course)
      .map((course, courseIndex) => ({
        slotId: course.requirementId,
        code: course.course,
        minimumLevel: course.minimumLevel ?? null,
        source: "planned",
        term: term.term || term.label || term.termKey || null,
        termIndex,
        courseIndex
      }))
  ));
}

function allocationError(errors, message) {
  if (!errors.includes(message)) errors.push(message);
}

/**
 * The requirement allocation is the one source of truth for both what the
 * student already has and what a candidate plan proposes. It deliberately
 * keeps requirement choices separate from prerequisite timing; the shared
 * prerequisite evaluator handles timing term by term.
 */
export function buildRequirementAllocation({
  requirements = [],
  existingAssignments = [],
  plan = {},
  policyBundle = runtimePolicyBundle(),
  catalogApplicability = plan?.catalogApplicability || null
} = {}) {
  const requirementsById = new Map((requirements || []).map(requirement => [requirement.id, requirement]));
  const completedOrInProgress = normalizeExistingAssignments(existingAssignments);
  const planned = plannedAssignmentsFromPlan(plan);
  const assignments = [...completedOrInProgress, ...planned];
  const errors = [];
  const assignmentBySlot = new Map();
  const assignmentByCode = new Map();
  let level100Electives = 0;

  for (const assignment of assignments) {
    const requirement = requirementsById.get(assignment.slotId);
    if (!requirement) {
      allocationError(errors, `${assignment.code} is assigned to unknown requirement ${assignment.slotId}.`);
      continue;
    }
    const allocationDecision = evaluateRequirementAllocation({ course: assignment.code, minimumLevel: assignment.minimumLevel }, assignment.slotId, null, policyBundle, {
      assignments,
      level100Electives
    });
    if (!matchesRequirementShape(requirement, assignment.code) || allocationDecision.status === "BLOCK") {
      allocationError(errors, `${assignment.code} is not a valid course for requirement ${assignment.slotId}.`);
    }

    const existingForSlot = assignmentBySlot.get(assignment.slotId);
    if (existingForSlot) {
      allocationError(errors, `Requirement ${assignment.slotId} is assigned more than once.`);
    } else {
      assignmentBySlot.set(assignment.slotId, assignment);
    }

    if (isConcreteCourse(assignment.code)) {
      const existingForCode = assignmentByCode.get(assignment.code);
      if (existingForCode && existingForCode.slotId !== assignment.slotId) {
        allocationError(errors, `${assignment.code} is assigned to both ${existingForCode.slotId} and ${assignment.slotId}.`);
      } else if (!existingForCode) {
        assignmentByCode.set(assignment.code, assignment);
      }
    }
    if (String(assignment.slotId).startsWith("eco-elective") && /^ECO 1\d\d$/i.test(assignment.code)) level100Electives += 1;
  }

  for (const assignment of assignments) {
    const requirement = requirementsById.get(assignment.slotId);
    const condition = conditionFor(requirement, assignment.code);
    if (condition && !conditionIsSatisfied(condition, assignments)) {
      allocationError(
        errors,
        `${assignment.code} may satisfy ${assignment.slotId} only when ${condition.assignedCode} is assigned to ${condition.slotId}.`
      );
    }
  }

  const canonical = assignments.map(assignment => ({
    slotId: assignment.slotId,
    code: assignment.code,
    source: assignment.source,
    status: assignment.status || null,
    courseId: assignment.courseId || null,
    term: assignment.term || null
  })).sort((left, right) => `${left.slotId}|${left.code}|${left.courseId || ""}`.localeCompare(`${right.slotId}|${right.code}|${right.courseId || ""}`));
  const allocationIdentity = {
    governingPolicyRelease: policyBundle.bundleVersion,
    assignments: canonical,
    unresolvedOrReviewStates: [...errors].sort(),
    catalogApplicability
  };
  const allocationId = `allocation-${createHash("sha256").update(canonicalJson(allocationIdentity), "utf8").digest("hex")}`;
  return {
    valid: errors.length === 0,
    errors,
    allocationId,
    governingPolicyRelease: policyBundle.bundleVersion,
    catalogApplicability,
    assignments,
    existingAssignments: completedOrInProgress,
    plannedAssignments: planned,
    assignmentBySlot,
    assignmentByCode
  };
}

/**
 * Returns whether a concrete course can be placed in a requirement slot with
 * the assignments that already exist in this partial candidate schedule.
 */
export function canAllocateCourseToRequirement({
  requirement,
  code,
  minimumLevel = null,
  assignments = [],
  policyBundle = runtimePolicyBundle()
} = {}) {
  if (!matchesRequirementShape(requirement, code)) return false;
  if (!conditionIsSatisfied(conditionFor(requirement, code), assignments)) return false;
  const level100Electives = assignments.filter(item => String(item.slotId).startsWith("eco-elective") && /^ECO 1\d\d$/i.test(item.code)).length;
  const financeCourse = assignments.find(item => item.slotId === "finance")?.code || "";
  const cacheKey = [policyBundle.contentHash, requirement.id, code, minimumLevel ?? "", level100Electives, financeCourse].join("|");
  if (!allocationEligibilityCache.has(cacheKey)) {
    allocationEligibilityCache.set(cacheKey, evaluateRequirementAllocation(
      { course: code, minimumLevel },
      requirement.id,
      null,
      policyBundle,
      { traceId: "planning-domain", assignments, level100Electives }
    ).status !== "BLOCK");
  }
  return allocationEligibilityCache.get(cacheKey);
}

/**
 * Domain construction may include a conditional option only when its required
 * companion assignment is already present or remains possible in this plan.
 * The final legality check uses canAllocateCourseToRequirement above.
 */
export function mayAllocateCourseToRequirement({
  requirement,
  code,
  assignments = [],
  requirements = [],
  policyBundle = runtimePolicyBundle()
} = {}) {
  if (!matchesRequirementShape(requirement, code)) return false;
  const decision = evaluateRequirementAllocation(code, requirement.id, null, policyBundle, { assignments });
  if (decision.status === "BLOCK" && decision.reasonCode !== "ECO_321_REQUIRES_BUSN_323_FINANCE_ALLOCATION") return false;
  const condition = conditionFor(requirement, code);
  if (!condition || conditionIsSatisfied(condition, assignments)) return true;
  const requiredSlot = (requirements || []).find(item => item.id === condition.slotId);
  return Boolean(requiredSlot && (requiredSlot.options || []).includes(condition.assignedCode));
}

export function requirementAllocationSummary(allocation) {
  return {
    valid: Boolean(allocation?.valid),
    allocationId: allocation?.allocationId || null,
    governingPolicyRelease: allocation?.governingPolicyRelease || null,
    catalogApplicability: allocation?.catalogApplicability || null,
    assignments: (allocation?.assignments || []).map(assignment => ({
      slotId: assignment.slotId,
      code: assignment.code,
      source: assignment.source,
      term: assignment.term || null
    })),
    errors: [...(allocation?.errors || [])]
  };
}
