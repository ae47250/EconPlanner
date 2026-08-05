import {
  EVIDENCE_STATUSES,
  isActiveCourse,
  isInProgressCourse,
  isLevel100,
  isProvisionalCourse,
  normalizeStudentCourses
} from "../requirements/normalize.js";
import { normalizeRequirementConfig } from "../requirements/dsl.js";
import { evaluateRequirementAllocation } from "../decision-engine/requirements.js";
import { auditStudentHistory } from "../decision-engine/student-history.js";
import { runtimePolicyBundle } from "../policy/compat-normalized.js";

function isElectiveSlot(slot) {
  return slot.kind === "elective";
}

function optionMatchesCourse(slot, course) {
  if (!course.code) return false;

  if (slot.milestone) return false;
  if (slot.subject && !course.code.startsWith(`${slot.subject} `)) return false;
  if (slot.minLevel && Number(course.code.slice(-3)) < Number(slot.minLevel)) return false;
  if (slot.maxLevel && Number(course.code.slice(-3)) > Number(slot.maxLevel)) return false;
  if ((slot.excludedCourses || []).includes(course.code)) return false;

  if (slot.kind === "exact" || slot.kind === "choice") {
    return slot.options.includes(course.code);
  }

  if (slot.kind === "elective") {
    return true;
  }

  if (slot.kind === "course_set") {
    return (slot.options || []).includes(course.code);
  }

  return false;
}

function evidenceFor(slot, course) {
  if (!optionMatchesCourse(slot, course)) return EVIDENCE_STATUSES.NOT_APPLICABLE;
  if (!course.code || !course.source || /title_only/i.test(course.source)) return EVIDENCE_STATUSES.INFERRED;
  if (slot.provisionalOptions?.includes(course.code) || isProvisionalCourse(course)) {
    return EVIDENCE_STATUSES.PROVISIONAL;
  }
  return EVIDENCE_STATUSES.VERIFIED;
}

function candidateFor(slot, course, { allowProvisional, includeInProgress, policyBundle = null }) {
  if (!isActiveCourse(course)) return null;
  if (!includeInProgress && isInProgressCourse(course)) return null;
  if (includeInProgress && course.status === "in_progress") {
    // In-progress courses are projected, not current, but may satisfy a future slot.
  }
  if (!includeInProgress && !["completed", "transfer", "uncertain"].includes(course.status)) return null;

  const evidenceStatus = evidenceFor(slot, course);
  if (![EVIDENCE_STATUSES.VERIFIED, EVIDENCE_STATUSES.PROVISIONAL].includes(evidenceStatus)) return null;
  if (!allowProvisional && evidenceStatus !== EVIDENCE_STATUSES.VERIFIED) return null;
  if (slot.residency === "hanover" && (
    ["transfer", "uncertain"].includes(course.status) ||
    /ap|transfer|equivalency|outside/i.test(course.source || "")
  )) return null;
  if (policyBundle) {
    const decision = evaluateRequirementAllocation(course.code, slot.id, null, policyBundle);
    if (decision.status === "BLOCK" && decision.reasonCode !== "ECO_321_REQUIRES_BUSN_323_FINANCE_ALLOCATION") return null;
  }

  return {
    slotId: slot.id,
    label: slot.label,
    kind: slot.kind,
    courseId: course.id,
    code: course.code,
    unitsApplied: Math.min(slot.units || 1, course.units || 1),
    evidenceStatus,
    status: course.status,
    condition: slot.conditionalCourses?.[course.code] || null
  };
}

function compareScores(a, b) {
  const keys = ["satisfied", "verifiedUnits", "verifiedCount", "units", "preferenceScore", "negativeProvisional"];
  for (const key of keys) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return a.tieKey < b.tieKey ? 1 : a.tieKey > b.tieKey ? -1 : 0;
}

function scoreAssignments(assignments, slots) {
  const bySlot = new Map(assignments.map(item => [item.slotId, item]));
  const satisfied = assignments.length;
  const verifiedUnits = assignments
    .filter(item => item.evidenceStatus === EVIDENCE_STATUSES.VERIFIED)
    .reduce((sum, item) => sum + item.unitsApplied, 0);
  const verifiedCount = assignments.filter(item => item.evidenceStatus === EVIDENCE_STATUSES.VERIFIED).length;
  const units = assignments.reduce((sum, item) => sum + item.unitsApplied, 0);
  const preferenceScore = assignments.reduce((sum, item) => {
    const slot = slots.find(candidate => candidate.id === item.slotId);
    const preferredOptions = slot?.preferredOptions || [];
    const optionIndex = preferredOptions.indexOf(item.code);
    return sum + (optionIndex === -1 ? 0 : preferredOptions.length - optionIndex);
  }, 0);
  const provisionalCount = assignments.filter(item => item.evidenceStatus === EVIDENCE_STATUSES.PROVISIONAL).length;
  const tieKey = slots.map(slot => bySlot.get(slot.id)?.courseId || "~").join("|");

  return { satisfied, verifiedUnits, verifiedCount, units, preferenceScore, negativeProvisional: -provisionalCount, tieKey };
}

function orderedSlots(slots, courses, options) {
  return [...slots]
    .map(slot => ({
      slot,
      candidates: courses
        .map(course => candidateFor(slot, course, options))
        .filter(Boolean)
        .sort((a, b) => `${a.evidenceStatus}-${a.courseId}`.localeCompare(`${b.evidenceStatus}-${b.courseId}`))
    }))
    .sort((a, b) => {
      const aSpecificity = isElectiveSlot(a.slot) ? 1 : 0;
      const bSpecificity = isElectiveSlot(b.slot) ? 1 : 0;
      return aSpecificity - bSpecificity || a.candidates.length - b.candidates.length || a.slot.id.localeCompare(b.slot.id);
    });
}

function searchAssignments(slots, courses, options) {
  const ordered = orderedSlots(slots, courses, options);
  let best = { assignments: [], score: scoreAssignments([], ordered.map(item => item.slot)) };

  function visit(index, assignments, usedCourseIds, level100Electives) {
    if (index >= ordered.length) {
      const score = scoreAssignments(assignments, ordered.map(item => item.slot));
      if (compareScores(score, best.score) > 0) best = { assignments: [...assignments], score };
      return;
    }

    const { slot, candidates } = ordered[index];
    visit(index + 1, assignments, usedCourseIds, level100Electives);

    for (const candidate of candidates) {
      if (usedCourseIds.has(candidate.courseId) && !slot.allowOverlap) continue;
      if (isElectiveSlot(slot) && isLevel100(candidate.code) && level100Electives >= 1) continue;
      if (candidate.condition && !assignments.some(item => (
        item.slotId === candidate.condition.slotId && item.code === candidate.condition.assignedCode
      ))) continue;

      const { condition: _condition, ...assignment } = candidate;
      assignments.push(assignment);
      if (!slot.allowOverlap) usedCourseIds.add(candidate.courseId);
      visit(index + 1, assignments, usedCourseIds, level100Electives + (isElectiveSlot(slot) && isLevel100(candidate.code) ? 1 : 0));
      if (!slot.allowOverlap) usedCourseIds.delete(candidate.courseId);
      assignments.pop();
    }
  }

  visit(0, [], new Set(), 0);
  return { assignments: best.assignments, score: best.score, orderedSlots: ordered };
}

function scenarioResult(requirementConfig, studentCourses, options) {
  const slots = requirementConfig.requirementSlots || [];
  const solved = searchAssignments(slots, studentCourses, options);
  const assignments = solved.assignments.sort((a, b) => a.slotId.localeCompare(b.slotId));
  const assignedSlotIds = new Set(assignments.map(item => item.slotId));
  const totalUnits = slots.reduce((sum, slot) => sum + (slot.units || 0), 0);
  const appliedUnits = assignments.reduce((sum, item) => sum + item.unitsApplied, 0);

  return {
    remainingUnits: Math.max(0, totalUnits - appliedUnits),
    totalUnits,
    appliedUnits,
    satisfiedRequirements: assignments.map(item => item.slotId),
    assignments,
    unresolved: slots
      .filter(slot => !assignedSlotIds.has(slot.id))
      .map(slot => ({
        requirementId: slot.id,
        label: slot.label,
        options: slot.options || [],
        reason: "No eligible course assignment"
      })),
    score: solved.score
  };
}

function scenarioForPlans(requirementConfig, studentCourses, options) {
  const plans = requirementConfig.requirementPlans?.length
    ? requirementConfig.requirementPlans
    : [requirementConfig.requirementSlots || []];
  const results = plans.map(plan => scenarioResult({ ...requirementConfig, requirementSlots: plan }, studentCourses, options));
  let best = results[0];
  for (const result of results.slice(1)) {
    if (compareScores(result.score, best.score) > 0) best = result;
  }
  best ||= scenarioResult({ ...requirementConfig, requirementSlots: [] }, studentCourses, options);
  const { score: _score, ...publicResult } = best;
  return publicResult;
}

function buildProgramWithoutData(program) {
  const unresolved = [{
    type: "program_requirements",
    reason: "CATALOG_MAPPING_UNRESOLVED",
    message: "This catalog requirement tree has been captured but not approved for runtime mapping."
  }];
  return {
    program,
    sourceStatus: program.sourceStatus || "DRAFT_REVIEW_REQUIRED",
    strict: { remainingUnits: null, satisfiedRequirements: [], unresolved },
    optimistic: { remainingUnits: null, satisfiedRequirements: [], unresolved },
    projectedAfterInProgress: { strict: null, optimistic: null },
    assignments: [],
    requirements: [],
    unusedCourses: [],
    unresolved,
    missingPrerequisites: [],
    minimumRegularTerms: null,
    risk: { class: "INSUFFICIENT_INFORMATION", reasons: ["CATALOG_MAPPING_UNRESOLVED"] },
    sourceEvidence: program.sourceUrl ? [{ url: program.sourceUrl, status: program.sourceStatus }] : []
  };
}

export function mapStudentToProgram(program, requirementConfig, student = {}, { policyBundle = null } = {}) {
  const normalizedConfig = normalizeRequirementConfig(requirementConfig || {});
  if (!normalizedConfig.requirementPlans?.length) return buildProgramWithoutData(program);

  const courses = normalizeStudentCourses(student.courses);
  const authoritativeBundle = program.id === "economics" ? (policyBundle || runtimePolicyBundle()) : null;
  const historyAudit = authoritativeBundle ? auditStudentHistory(student, authoritativeBundle) : null;
  const strict = scenarioForPlans(normalizedConfig, courses, { allowProvisional: false, includeInProgress: false, policyBundle: authoritativeBundle });
  const optimistic = scenarioForPlans(normalizedConfig, courses, { allowProvisional: true, includeInProgress: false, policyBundle: authoritativeBundle });
  const strictProjected = scenarioForPlans(normalizedConfig, courses, { allowProvisional: false, includeInProgress: true, policyBundle: authoritativeBundle });
  const optimisticProjected = scenarioForPlans(normalizedConfig, courses, { allowProvisional: true, includeInProgress: true, policyBundle: authoritativeBundle });
  const slots = normalizedConfig.requirementSlots || normalizedConfig.requirementPlans[0] || [];
  const usedIds = new Set(optimisticProjected.assignments.map(item => item.courseId));

  return {
    program,
    sourceStatus: normalizedConfig.sourceStatus || program.sourceStatus || "DRAFT_REVIEW_REQUIRED",
    strict,
    optimistic,
    projectedAfterInProgress: {
      strict: strictProjected,
      optimistic: optimisticProjected
    },
    requirements: slots,
    assignments: optimisticProjected.assignments,
    unusedCourses: courses
      .filter(course => !usedIds.has(course.id))
      .map(course => ({ ...course, evidenceStatus: EVIDENCE_STATUSES.DUPLICATE_OR_UNUSED })),
    unresolved: optimisticProjected.unresolved,
    missingPrerequisites: [],
    minimumRegularTerms: 0,
    risk: {
      class: optimisticProjected.unresolved.length || historyAudit?.reviewFindings.length
        ? "FEASIBLE_WITH_ASSUMPTIONS"
        : "FEASIBLE",
      reasons: [
        ...(optimisticProjected.unresolved.length ? ["REQUIREMENTS_REMAIN"] : []),
        ...(historyAudit?.reviewFindings.length ? ["ACADEMIC_HISTORY_REVIEW_REQUIRED"] : [])
      ]
    },
    reviewFindings: historyAudit?.reviewFindings || [],
    sourceEvidence: normalizedConfig.sourceRefs?.map(ref => ({ ref, status: "VERIFIED" })) || [],
    policyAuthority: authoritativeBundle ? {
      bundleVersion: authoritativeBundle.bundleVersion,
      bundleHash: authoritativeBundle.contentHash,
      status: "PRODUCTION_DECISION_ENGINE"
    } : null
  };
}
