import { electiveCapacityBlockers, electiveCompletionBlockers, hasCompleteScheduleCoverage, independentlyProvenRequiredOffering, pendingOverloadEvidence, seniorStandingTimingBlockers, statisticsTimingBlockers, unpublishedElectiveNeed } from "./completion-blockers.js";
import { policyMessage } from "../policy/term-load.js";
import { buildPlanningSlots } from "./horizon.js";
import { termLoadCapacity, termLoadEvidenceForSlot } from "../policy/term-load.js";
import { pluralize, studentTermLabel } from "./student-language.js";
import { studyAbroadTermIds } from "./study-abroad.js";
import { historicalPrerequisiteCourseMessage, unmarkedPrerequisites } from "./historical-prerequisites.js";

export const ECONOMICS_PLAN_RESULT_CATEGORY = Object.freeze({
  PLANS_READY: "PLANS_READY",
  INPUT_BLOCKED: "INPUT_BLOCKED",
  SEARCH_INCOMPLETE: "SEARCH_INCOMPLETE",
  INFEASIBLE_PROVEN: "INFEASIBLE_PROVEN",
  NEEDS_ADVISOR_ATTENTION: "NEEDS_ADVISOR_ATTENTION"
});

const PROVEN_INFEASIBILITY_REASONS = new Set([
  "COUNT_CAPACITY",
  "EMPTY_DOMAIN",
  "NO_COMPLETE_ASSIGNMENT"
]);

function array(value) {
  return Array.isArray(value) ? value : [];
}

function inputIsBlocked(inputResolution, diagnostics) {
  if (diagnostics?.invalidInput) return true;
  if (!inputResolution?.planningMustRemainBlocked) return false;
  return Boolean(
    inputResolution.issueCode
    || array(inputResolution.blockingFields).length
    || array(inputResolution.questions).length
  );
}

function incompleteSearchEvidence(strategyAttempts, candidateOutcomes) {
  return strategyAttempts.some(attempt => !attempt?.exhaustive && !attempt?.solutionFound)
    || candidateOutcomes.some(outcome => (
      outcome?.status === "SEARCH_INCOMPLETE"
      || outcome?.suppressionReason?.code === "SEARCH_INCOMPLETE"
      || array(outcome?.reasons).some(reason => reason?.code === "SEARCH_INCOMPLETE")
    ));
}

function advisorReviewEvidence(planningGaps) {
  return planningGaps.some(gap => (
    /REVIEW|APPROVAL|POLICY/iu.test(`${gap?.code || ""} ${gap?.reason || ""} ${gap?.message || ""}`)
  ));
}

function missingOfferingEvidence(planningGaps) {
  return planningGaps.some(gap => (
    /missing offering|no (?:verified )?offering|not offered/iu.test(
      `${gap?.code || ""} ${gap?.reason || ""} ${gap?.message || ""}`
    )
  ));
}

function planActions(plans) {
  return plans.flatMap(plan => array(plan?.advisorActions));
}

export function majorCourseCapacityBlocker(mapping, planningContext, student, policyBundle) {
  if (!mapping || !planningContext || !policyBundle) return null;
  const unresolved = new Set((mapping.projectedAfterInProgress?.optimistic?.unresolved
    || mapping.optimistic?.unresolved || []).map(item => item.requirementId));
  const requiredCourses = (mapping.requirements || []).filter(item => unresolved.has(item.id));
  const slots = buildPlanningSlots(planningContext).filter(slot => !slot.isSummer && slot.newCoursesAllowed !== false);
  const totalCapacity = slots.reduce((sum, slot) => {
    const evidence = termLoadEvidenceForSlot(student, slot);
    const capacity = termLoadCapacity(policyBundle, { ...slot, termLoadEvidence: evidence });
    if (slot.studyAbroad || slot.isStudyAbroad) return sum;
    const reserved = Number(student.reservedCourseUnits?.[slot.id] ?? student.reservedCourseUnits?.[slot.label]
      ?? slot.reservedCourseUnits ?? 0);
    const available = Math.max(0, (capacity.overloadApproved
      ? capacity.conditionalMaximumCourseUnits : capacity.normalCourseUnits) - reserved);
    return sum + Math.floor(available);
  }, 0);
  if (requiredCourses.length <= totalCapacity) return null;
  return {
    code: "MAJOR_COURSE_CAPACITY_EXCEEDED",
    remainingRequiredCourses: requiredCourses.length,
    remainingTerms: slots.length,
    totalCourseCapacity: totalCapacity,
    message: policyMessage(policyBundle, "infeasibility.courseCapacity", { requiredCourses: requiredCourses.length, remainingTerms: slots.length, termNoun: pluralize(slots.length, "term"), term: studentTermLabel(planningContext.expectedGraduationTerm) })
  };
}

function result({
  category,
  conclusion,
  reason,
  plans,
  inputResolution,
  candidateOutcomes,
  planningGaps,
  strategyAttempts,
  searchAttempts,
  blockingReasons = [],
  additionalEvidence = {}
}) {
  return {
    schemaVersion: 1,
    category,
    conclusion,
    reason,
    questions: array(inputResolution?.questions),
    actions: planActions(plans),
    evidence: {
      inputResolution: inputResolution || null,
      candidateOutcomes,
      planningGaps,
      strategyAttempts,
      searchAttempts,
      blockingReasons,
      ...additionalEvidence
    }
  };
}

// Owner request 2026-11-26: "Not possible" must not rest on a missing answer. A course marked Completed
// whose prerequisite is not marked means the student has very likely taken that prerequisite; until it is
// marked, the planner counts it as still to do, which can make the result look impossible.
function unmarkedPrerequisiteBlocker(student = {}, policyBundle = null) {
  const rules = policyBundle?.rules || [];
  const courses = Array.isArray(student.courses) ? student.courses : [];
  const unmarked = unmarkedPrerequisites(courses, rules);
  if (!unmarked.length) return null;
  const affected = [...new Set(unmarked.map(item => item.course))];
  const names = [...new Set(unmarked.map(item => item.name))];
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
  return {
    code: "UNMARKED_PREREQUISITE",
    courses: affected,
    question: policyMessage(policyBundle, "infeasibility.unmarkedPrerequisiteQuestion", { courses: list }),
    message: [
      ...affected.map(course => historicalPrerequisiteCourseMessage(course, courses, rules, policyBundle?.messages)),
      policyMessage(policyBundle, names.length > 1 ? "infeasibility.unmarkedPrerequisiteMany" : "infeasibility.unmarkedPrerequisite", {})
    ].filter(Boolean).join(" ")
  };
}

export function buildEconomicsPlanResult(input = {}) {
  const outcome = buildEconomicsPlanResultBeforeHistoryCheck(input);
  if (outcome.category !== ECONOMICS_PLAN_RESULT_CATEGORY.INFEASIBLE_PROVEN) return outcome;
  // Switch only when the planner, re-run with the unmarked prerequisites counted as done, found a plan.
  if (input.metricsDiagnostics?.markedPrerequisiteSearchFoundPlan !== true) return outcome;
  const blocker = unmarkedPrerequisiteBlocker(input.student, input.policyBundle);
  if (!blocker) return outcome;
  return {
    ...outcome,
    category: ECONOMICS_PLAN_RESULT_CATEGORY.NEEDS_ADVISOR_ATTENTION,
    conclusion: "UNKNOWN",
    reason: blocker.code,
    // The re-run found a plan, so every earlier reason is resolved by marking; they are kept for the record only.
    evidence: { ...outcome.evidence, provenReasonWithCurrentAnswers: outcome.reason,
      reasonsWithCurrentAnswers: outcome.evidence?.blockingReasons || [], blockingReasons: [blocker] }
  };
}

function buildEconomicsPlanResultBeforeHistoryCheck({
  plans = [],
  inputResolution = null,
  candidateOutcomes = [],
  planningGaps = [],
  metricsDiagnostics = null,
  student = {},
  mapping = null,
  planningContext = null,
  policyBundle = null
} = {}) {
  const exactPlans = array(plans);
  const exactCandidateOutcomes = array(candidateOutcomes);
  const exactPlanningGaps = array(planningGaps);
  const diagnostics = metricsDiagnostics || {};
  const strategyAttempts = array(diagnostics.strategyAttempts);
  const searchAttempts = array(diagnostics.searchAttempts);
  const shared = {
    plans: exactPlans,
    inputResolution,
    candidateOutcomes: exactCandidateOutcomes,
    planningGaps: exactPlanningGaps,
    strategyAttempts,
    searchAttempts,
    blockingReasons: (() => {
      const springElectives = electiveCompletionBlockers({mapping, planningContext, policyBundle, student});
      return [...seniorStandingTimingBlockers(mapping, planningContext, policyBundle), ...statisticsTimingBlockers(mapping, planningContext, policyBundle),
        ...springElectives,
        // OD4: the "courses left vs terms left" explanation takes precedence; the elective count is the specific reason otherwise.
        // Skip when the planner's own approved-overload search found a plan.
        ...(springElectives.length || exactPlans.length || majorCourseCapacityBlocker(mapping, planningContext, student, policyBundle)
          || diagnostics.approvedOverloadSearchFoundPlan === true
          ? [] : electiveCapacityBlockers({mapping, planningContext, policyBundle, student}))];
    })()
  };

  if (exactPlans.length) {
    return result({
      ...shared,
      strategyAttempts: [],
      searchAttempts: [],
      category: ECONOMICS_PLAN_RESULT_CATEGORY.PLANS_READY,
      conclusion: "PLAN_AVAILABLE",
      reason: "VALIDATED_PLANS_RETURNED"
    });
  }

  if (inputIsBlocked(inputResolution, diagnostics)) {
    return result({
      ...shared,
      category: ECONOMICS_PLAN_RESULT_CATEGORY.INPUT_BLOCKED,
      conclusion: "UNKNOWN",
      reason: "INVALID_INPUT",
      additionalEvidence: diagnostics.invalidInput ? { invalidInput: diagnostics.invalidInput } : {}
    });
  }

  if (diagnostics.reservedRoomSearchFoundPlan === true) {
    const reservedSlots = buildPlanningSlots(planningContext).map(slot => ({ label: studentTermLabel(slot.label),
      count: Number(student.reservedCourseUnits?.[slot.id] ?? student.reservedCourseUnits?.[slot.label] ?? 0) }))
      .filter(slot => slot.count > 0);
    const reservedTerms = reservedSlots.map(slot => slot.label);
    const abroadTerms = studyAbroadTermIds(student, buildPlanningSlots(planningContext));
    const message = abroadTerms.length
      ? `Study abroad leaves no room for major courses in ${reservedTerms.join(" and ")}. Change your graduation term or study-abroad choice and try again.`
      : `${reservedSlots.length === 1
        ? `You saved room for ${reservedSlots[0].count} other ${pluralize(reservedSlots[0].count, "course")} in ${reservedSlots[0].label}.`
        : `You saved room for ${reservedSlots.reduce((sum, slot) => sum + slot.count, 0)} other courses across ${reservedSlots.length} terms.`} That leaves too little room for the major. Save room for fewer courses and try again.`;
    return result({ ...shared, category: ECONOMICS_PLAN_RESULT_CATEGORY.NEEDS_ADVISOR_ATTENTION,
      conclusion: "UNKNOWN", reason: "RESERVED_ROOM_BLOCKS_PLAN", additionalEvidence: { message, reservedTerms, abroadTerms } });
  }

  const capacityBlocker = majorCourseCapacityBlocker(mapping, planningContext, student, policyBundle);
  if (capacityBlocker) {
    shared.blockingReasons.unshift(capacityBlocker);
    return result({ ...shared, category: ECONOMICS_PLAN_RESULT_CATEGORY.INFEASIBLE_PROVEN,
      conclusion: "PROVEN_INFEASIBLE", reason: capacityBlocker.code });
  }

  const requiredOfferingBlocker = independentlyProvenRequiredOffering(mapping, planningContext, policyBundle, student);
  if (requiredOfferingBlocker) {
    shared.blockingReasons.unshift(requiredOfferingBlocker);
    return result({ ...shared, category: ECONOMICS_PLAN_RESULT_CATEGORY.INFEASIBLE_PROVEN,
      conclusion: "PROVEN_INFEASIBLE", reason: requiredOfferingBlocker.code });
  }

  const extraElectives = unpublishedElectiveNeed({ mapping, planningContext, policyBundle, student });
  const financePending = (mapping?.projectedAfterInProgress?.optimistic?.unresolved || mapping?.optimistic?.unresolved || [])
    .some(item => item.requirementId === "finance");
  if (financePending && !shared.blockingReasons.length && policyBundle?.planningAdvice) shared.blockingReasons.push({
    code: "FINANCE_REQUIREMENT_UNMET", message: `Finance and the other required courses do not fit by ${planningContext?.graduationTermLabel || "your graduation target"}. Bring this page to your advisor.`
  });
  if (extraElectives.length) return result({ ...shared,
    blockingReasons: [...shared.blockingReasons, ...extraElectives],
    category: ECONOMICS_PLAN_RESULT_CATEGORY.NEEDS_ADVISOR_ATTENTION,
    conclusion: "UNKNOWN", reason: "EXTRA_ELECTIVE_OFFERING_REVIEW_REQUIRED" });

  if (incompleteSearchEvidence(strategyAttempts, exactCandidateOutcomes)) {
    return result({
      ...shared,
      category: ECONOMICS_PLAN_RESULT_CATEGORY.SEARCH_INCOMPLETE,
      conclusion: "UNKNOWN",
      reason: "SEARCH_INCOMPLETE"
    });
  }

  // A rule finding is a proof by itself: no search attempt is needed to explain it.
  if (shared.blockingReasons.some(item => item.code === "CAPSTONE_SENIOR_STANDING_NO_ELIGIBLE_WINTER")) {
    return result({
      ...shared,
      category: ECONOMICS_PLAN_RESULT_CATEGORY.INFEASIBLE_PROVEN,
      conclusion: "PROVEN_INFEASIBLE",
      reason: "CAPSTONE_SENIOR_STANDING_NO_ELIGIBLE_WINTER"
    });
  }

  if (!strategyAttempts.length) {
    return result({
      ...shared,
      category: ECONOMICS_PLAN_RESULT_CATEGORY.NEEDS_ADVISOR_ATTENTION,
      conclusion: "UNKNOWN",
      reason: "UNEXPLAINED"
    });
  }

  if (advisorReviewEvidence(exactPlanningGaps)) {
    return result({
      ...shared,
      category: ECONOMICS_PLAN_RESULT_CATEGORY.NEEDS_ADVISOR_ATTENTION,
      conclusion: "UNKNOWN",
      reason: "POLICY_REVIEW_REQUIRED"
    });
  }

  const exhaustive = strategyAttempts.every(attempt => attempt?.exhaustive === true);
  if (!exhaustive) {
    return result({
      ...shared,
      category: ECONOMICS_PLAN_RESULT_CATEGORY.NEEDS_ADVISOR_ATTENTION,
      conclusion: "UNKNOWN",
      reason: "OTHER_CLASSIFIED"
    });
  }

  const allCountCapacity = searchAttempts.length > 0
    && searchAttempts.every(attempt => attempt?.failure === "COUNT_CAPACITY");
  const pending = pendingOverloadEvidence(planningContext, policyBundle, student, mapping);
  if (!shared.blockingReasons.some(reason => reason.code !== "FINANCE_REQUIREMENT_UNMET") && pending.length
    && diagnostics.approvedOverloadSearchFoundPlan === true) {
    return result({...shared, category: ECONOMICS_PLAN_RESULT_CATEGORY.NEEDS_ADVISOR_ATTENTION,
      conclusion: "UNKNOWN", reason: "TERM_OVERLOAD_EVIDENCE_REQUIRED", additionalEvidence: {
        pendingOverloadEvidence: pending,
        message: policyMessage(policyBundle, "termLoad.pending", {terms: pending.map(item => item.term).join(", ")})
      }});
  }

  if (allCountCapacity) {
    return result({
      ...shared,
      category: ECONOMICS_PLAN_RESULT_CATEGORY.INFEASIBLE_PROVEN,
      conclusion: "PROVEN_INFEASIBLE",
      reason: "COUNT_CAPACITY"
    });
  }

  if (policyBundle && planningContext && !statisticsTimingBlockers(mapping, planningContext, policyBundle).length
    && !hasCompleteScheduleCoverage(planningContext, policyBundle, {mapping, student})) {
    return result({ ...shared, category: ECONOMICS_PLAN_RESULT_CATEGORY.NEEDS_ADVISOR_ATTENTION, conclusion: "UNKNOWN", reason: "MISSING_OFFERING" });
  }

  if (missingOfferingEvidence(exactPlanningGaps)) {
    return result({
      ...shared,
      category: ECONOMICS_PLAN_RESULT_CATEGORY.NEEDS_ADVISOR_ATTENTION,
      conclusion: "UNKNOWN",
      reason: "MISSING_OFFERING"
    });
  }

  const emptyDomains = [...new Set(searchAttempts.flatMap(attempt => array(attempt?.emptyDomains)))];
  if (emptyDomains.length) {
    return result({
      ...shared,
      category: ECONOMICS_PLAN_RESULT_CATEGORY.INFEASIBLE_PROVEN,
      conclusion: "PROVEN_INFEASIBLE",
      reason: "EMPTY_DOMAIN",
      additionalEvidence: { emptyDomains }
    });
  }

  const reason = "NO_COMPLETE_ASSIGNMENT";
  return result({
    ...shared,
    category: PROVEN_INFEASIBILITY_REASONS.has(reason)
      ? ECONOMICS_PLAN_RESULT_CATEGORY.INFEASIBLE_PROVEN
      : ECONOMICS_PLAN_RESULT_CATEGORY.NEEDS_ADVISOR_ATTENTION,
    conclusion: "PROVEN_INFEASIBLE",
    reason
  });
}
