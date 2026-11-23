import { createHash } from "node:crypto";
import {
  EVIDENCE_STATUSES,
  isActiveCourse,
  isInProgressCourse,
  isLevel100,
  isProvisionalCourse,
  normalizeStudentCourse,
  normalizeStudentCourses
} from "../requirements/normalize.js";
import { normalizeRequirementConfig } from "../requirements/dsl.js";
import { evaluateRequirementAllocation, financeElectivePetitionNotices } from "../decision-engine/requirements.js";
import { auditStudentHistory } from "../decision-engine/student-history.js";
import { runtimePolicyBundle } from "../policy/compat-normalized.js";
import { canonicalJson } from "../policy/canonical-json.js";

const DEFAULT_ALLOCATION_PAGE_LIMIT = 64;
const REVIEW_ONLY_SOURCE = /ap|transfer|equivalency|outside|substitution|waiver|uncertain/i;

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
  if (REVIEW_ONLY_SOURCE.test(course.source)) return EVIDENCE_STATUSES.PROVISIONAL;
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
    ["transfer", "uncertain"].includes(course.status)
    || evidenceStatus !== EVIDENCE_STATUSES.VERIFIED
  )) return null;
  if (policyBundle) {
    const decision = evaluateRequirementAllocation(course.code, slot.id, null, policyBundle);
    if (decision.status === "BLOCK" && !slot.conditionalCourses?.[course.code]) return null;
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
  const tieKey = slots.map(slot => bySlot.get(slot.id)?.code || "~").join("|");

  return { satisfied, verifiedUnits, verifiedCount, units, preferenceScore, negativeProvisional: -provisionalCount, tieKey };
}

function canonicalAssignments(assignments) {
  return assignments.map(item => ({ ...item })).sort((left, right) => (
    left.slotId.localeCompare(right.slotId)
    || left.courseId.localeCompare(right.courseId)
    || left.code.localeCompare(right.code)
  ));
}

function unresolvedFor(slots, assignments) {
  const assignedSlotIds = new Set(assignments.map(item => item.slotId));
  return slots
    .filter(slot => !assignedSlotIds.has(slot.id))
    .map(slot => ({
      requirementId: slot.id,
      label: slot.label,
      options: [...(slot.options || [])].sort(),
      reason: "No eligible course assignment"
    }))
    .sort((left, right) => left.requirementId.localeCompare(right.requirementId));
}

function allocationAlternative(assignments, slots, score, identity = {}) {
  const canonical = canonicalAssignments(assignments);
  const unresolved = unresolvedFor(slots, canonical);
  const idInput = {
    governingPolicyRelease: identity.governingPolicyRelease || null,
    catalogApplicability: identity.catalogApplicability || null,
    assignments: canonical.map(item => ({
      slotId: item.slotId,
      courseId: item.courseId,
      code: item.code,
      status: item.status,
      evidenceStatus: item.evidenceStatus,
      unitsApplied: item.unitsApplied
    })),
    unresolved: unresolved.map(item => item.requirementId),
    reviewStates: canonical.filter(item => item.evidenceStatus !== EVIDENCE_STATUSES.VERIFIED)
      .map(item => ({ slotId: item.slotId, courseId: item.courseId, evidenceStatus: item.evidenceStatus }))
  };
  const digest = createHash("sha256").update(canonicalJson(idInput), "utf8").digest("hex");
  return {
    allocationId: `allocation-${digest}`,
    governingPolicyRelease: idInput.governingPolicyRelease,
    catalogApplicability: idInput.catalogApplicability,
    assignments: canonical,
    unresolved,
    reviewStates: idInput.reviewStates,
    score
  };
}

function compareAlternatives(left, right) {
  const score = compareScores(left.score, right.score);
  return score === 0 ? left.allocationId.localeCompare(right.allocationId) : -score;
}

function allocationPage(alternatives, { pageLimit = DEFAULT_ALLOCATION_PAGE_LIMIT, continuationAfterSignature = null } = {}) {
  const limit = Math.max(1, Math.min(DEFAULT_ALLOCATION_PAGE_LIMIT, Number(pageLimit) || DEFAULT_ALLOCATION_PAGE_LIMIT));
  const ordered = [...alternatives].sort(compareAlternatives);
  const continuationIndex = continuationAfterSignature
    ? ordered.findIndex(item => item.allocationId === continuationAfterSignature)
    : -1;
  const start = continuationAfterSignature ? continuationIndex + 1 : 0;
  const page = continuationAfterSignature && continuationIndex < 0 ? [] : ordered.slice(start, start + limit);
  const complete = start + page.length >= ordered.length;
  return {
    allocationAlternatives: page.map(({ score: _score, ...alternative }) => alternative),
    allocationSearch: {
      pageLimit: limit,
      returned: page.length,
      complete,
      terminationReason: complete ? "EXHAUSTED" : "ALTERNATIVE_LIMIT",
      continuationAfterSignature: complete ? null : page.at(-1)?.allocationId || null
    }
  };
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
  let maximalSatisfied = -1;
  const alternatives = new Map();

  function visit(index, assignments, usedCourseIds, level100Electives) {
    if (index >= ordered.length) {
      const score = scoreAssignments(assignments, ordered.map(item => item.slot));
      if (compareScores(score, best.score) > 0) best = { assignments: [...assignments], score };
      if (score.satisfied > maximalSatisfied) {
        maximalSatisfied = score.satisfied;
        alternatives.clear();
      }
      if (score.satisfied === maximalSatisfied) {
        const alternative = allocationAlternative(assignments, slots, score, options.allocationIdentity);
        alternatives.set(alternative.allocationId, alternative);
      }
      return;
    }

    const { slot, candidates } = ordered[index];
    visit(index + 1, assignments, usedCourseIds, level100Electives);

    for (const candidate of candidates) {
      if (usedCourseIds.has(candidate.courseId) && !slot.allowOverlap) continue;
      if (isElectiveSlot(slot) && isLevel100(candidate.code) && level100Electives >= slot.maxLevel100) continue;
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
  return { assignments: best.assignments, score: best.score, orderedSlots: ordered, alternatives: [...alternatives.values()] };
}

function scenarioResult(requirementConfig, studentCourses, options) {
  const slots = requirementConfig.requirementSlots || [];
  const solved = searchAssignments(slots, studentCourses, options);
  const assignments = solved.assignments.sort((a, b) => a.slotId.localeCompare(b.slotId));
  const totalUnits = slots.reduce((sum, slot) => sum + (slot.units || 0), 0);
  const appliedUnits = assignments.reduce((sum, item) => sum + item.unitsApplied, 0);

  return {
    remainingUnits: Math.max(0, totalUnits - appliedUnits),
    totalUnits,
    appliedUnits,
    satisfiedRequirements: assignments.map(item => item.slotId),
    assignments,
    unresolved: unresolvedFor(slots, assignments),
    score: solved.score,
    alternatives: solved.alternatives
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
  const maximalSatisfied = Math.max(0, ...results.flatMap(result => result.alternatives).map(item => item.score.satisfied));
  const alternatives = [...new Map(results
    .flatMap(result => result.alternatives)
    .filter(item => item.score.satisfied === maximalSatisfied)
    .map(item => [item.allocationId, item])).values()];
  const { score: _score, alternatives: _alternatives, ...publicResult } = best;
  return { ...publicResult, ...allocationPage(alternatives, options.allocationSearch) };
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
    strict: {
      remainingUnits: null,
      satisfiedRequirements: [],
      unresolved,
      allocationAlternatives: [],
      allocationSearch: { pageLimit: DEFAULT_ALLOCATION_PAGE_LIMIT, returned: 0, complete: true, terminationReason: "EXHAUSTED", continuationAfterSignature: null }
    },
    optimistic: {
      remainingUnits: null,
      satisfiedRequirements: [],
      unresolved,
      allocationAlternatives: [],
      allocationSearch: { pageLimit: DEFAULT_ALLOCATION_PAGE_LIMIT, returned: 0, complete: true, terminationReason: "EXHAUSTED", continuationAfterSignature: null }
    },
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

export function mapStudentToProgram(program, requirementConfig, student = {}, {
  policyBundle = null,
  allocationPageLimit = DEFAULT_ALLOCATION_PAGE_LIMIT,
  allocationContinuationAfterSignature = null,
  catalogApplicability = null
} = {}) {
  const normalizedConfig = normalizeRequirementConfig(requirementConfig || {});
  if (!normalizedConfig.requirementPlans?.length) return buildProgramWithoutData(program);

  const authoritativeBundle = program.id === "economics" ? (policyBundle || runtimePolicyBundle()) : null;
  const noticeBundle = authoritativeBundle || (program.programId === "economics" ? (policyBundle || runtimePolicyBundle()) : null);
  const slots = normalizedConfig.requirementSlots || normalizedConfig.requirementPlans[0] || [];
  const financeSlot = slots.find(slot => slot.id === "finance");
  const minimumUnits = noticeBundle?.indexes.byRuleId["ELECTIVE-ECO-321-FINANCE-ONLY"]?.effect.petitionNotice.minimumUnits;
  // Keep verified full-unit completion intact when other records for the same
  // finance course are pending or provisional. Never combine their evidence.
  const verifiedFinance = new Map((Array.isArray(student.courses) ? student.courses : [])
    .map(normalizeStudentCourse).filter(course => financeSlot
      && course.status === "completed" && course.units >= minimumUnits
      && evidenceFor(financeSlot, course) === EVIDENCE_STATUSES.VERIFIED)
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
    .map(course => [course.code, course]));
  const courses = normalizeStudentCourses(student.courses)
    .map(course => verifiedFinance.has(course.code) ? { ...course, ...verifiedFinance.get(course.code), id: course.id } : course)
    .map(course => ({
      ...course,
      id: /^course-\d+$/.test(course.id)
        ? `course-${createHash("sha256").update(canonicalJson({ code: course.code, status: course.status, source: course.source, units: course.units }), "utf8").digest("hex").slice(0, 16)}`
        : course.id
    }))
    .sort((left, right) => `${left.code}|${left.status}|${left.id}`.localeCompare(`${right.code}|${right.status}|${right.id}`));
  const historyAudit = authoritativeBundle ? auditStudentHistory(student, authoritativeBundle) : null;
  const allocationContract = {
    allocationIdentity: {
      governingPolicyRelease: authoritativeBundle?.bundleVersion || program.catalogYear || null,
      catalogApplicability
    },
    allocationSearch: {
      pageLimit: allocationPageLimit,
      continuationAfterSignature: allocationContinuationAfterSignature
    }
  };
  const strict = scenarioForPlans(normalizedConfig, courses, { allowProvisional: false, includeInProgress: false, policyBundle: authoritativeBundle, ...allocationContract });
  const optimistic = scenarioForPlans(normalizedConfig, courses, { allowProvisional: true, includeInProgress: false, policyBundle: authoritativeBundle, ...allocationContract });
  const strictProjected = scenarioForPlans(normalizedConfig, courses, { allowProvisional: false, includeInProgress: true, policyBundle: authoritativeBundle, ...allocationContract });
  const optimisticProjected = scenarioForPlans(normalizedConfig, courses, { allowProvisional: true, includeInProgress: true, policyBundle: authoritativeBundle, ...allocationContract });
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
    advisorNotifications: noticeBundle ? financeElectivePetitionNotices(new Set(verifiedFinance.keys()), noticeBundle) : [],
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
