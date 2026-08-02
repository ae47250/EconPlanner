const GENERIC_REQUIREMENT_COURSES = new Set([
  "ECO elective",
  "Statistics requirement"
]);

function isConcreteCourse(code) {
  return Boolean(code) && !GENERIC_REQUIREMENT_COURSES.has(code);
}

function matchesRequirementShape(requirement, code) {
  if (!requirement || !code) return false;
  if (code === "Statistics requirement") return requirement.id === "statistics";
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
  plan = {}
} = {}) {
  const requirementsById = new Map((requirements || []).map(requirement => [requirement.id, requirement]));
  const completedOrInProgress = normalizeExistingAssignments(existingAssignments);
  const planned = plannedAssignmentsFromPlan(plan);
  const assignments = [...completedOrInProgress, ...planned];
  const errors = [];
  const assignmentBySlot = new Map();
  const assignmentByCode = new Map();

  for (const assignment of assignments) {
    const requirement = requirementsById.get(assignment.slotId);
    if (!requirement) {
      allocationError(errors, `${assignment.code} is assigned to unknown requirement ${assignment.slotId}.`);
      continue;
    }
    if (!matchesRequirementShape(requirement, assignment.code)) {
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

  return {
    valid: errors.length === 0,
    errors,
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
  assignments = []
} = {}) {
  if (!matchesRequirementShape(requirement, code)) return false;
  return conditionIsSatisfied(conditionFor(requirement, code), assignments);
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
  requirements = []
} = {}) {
  if (!matchesRequirementShape(requirement, code)) return false;
  const condition = conditionFor(requirement, code);
  if (!condition || conditionIsSatisfied(condition, assignments)) return true;
  const requiredSlot = (requirements || []).find(item => item.id === condition.slotId);
  return Boolean(requiredSlot && (requiredSlot.options || []).includes(condition.assignedCode));
}

export function requirementAllocationSummary(allocation) {
  return {
    valid: Boolean(allocation?.valid),
    assignments: (allocation?.assignments || []).map(assignment => ({
      slotId: assignment.slotId,
      code: assignment.code,
      source: assignment.source,
      term: assignment.term || null
    })),
    errors: [...(allocation?.errors || [])]
  };
}
