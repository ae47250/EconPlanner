import { buildPlanningSlots } from "./horizon.js";

// Explain a proven chronology obstruction, without treating missing offerings or
// an unfinished search as proof. Requirement meaning comes from the pinned rules.
function statisticsTimingBlockers(mapping, context, bundle) {
  if (!mapping || !context || !bundle) return [];
  const unresolved = mapping.projectedAfterInProgress?.optimistic?.unresolved || mapping.optimistic?.unresolved || [];
  if (!["statistics", "eco-461"].every(id => unresolved.some(item => item.requirementId === id))) return [];
  const priorRule = bundle.indexes.byRuleId["PREREQ-ECO-461"];
  const termRule = bundle.indexes.byRuleId["CAPSTONE-WINTER-ONLY"];
  if (priorRule?.effect.statisticsMustBePrior !== true || !termRule) return [];
  const slots = buildPlanningSlots(context).filter(slot => slot.newCoursesAllowed !== false);
  const capstoneSlots = slots.filter(slot => termRule.effect.allowedCanonicalTerms.includes(slot.canonicalTerm));
  if (capstoneSlots.length !== 1 || slots.indexOf(capstoneSlots[0]) !== 0) return [];
  return [{
    code: "STATISTICS_BEFORE_CAPSTONE_NO_EARLIER_TERM",
    course: priorRule.condition.course,
    missingOptions: priorRule.effect.oneOfGroups[0],
    ruleIds: [priorRule.ruleId, termRule.ruleId],
    sourceRefs: [...new Set([...priorRule.sourceRefs, ...termRule.sourceRefs])],
    planningStart: slots[0].label,
    graduationTarget: context.expectedGraduationTerm,
    message: `Your available planning terms start in ${slots[0].label}. ${priorRule.condition.course} must be taken in ${capstoneSlots[0].label} to finish by ${context.expectedGraduationTerm}, and statistics (${priorRule.effect.oneOfGroups[0].join(" / ")}) must be completed before that term. Your answers do not satisfy statistics, and there is no earlier planning term in this horizon. Review your statistics answer or discuss a later graduation target with your advisor.`
  }];
}

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

export function buildEconomicsPlanResult({
  plans = [],
  inputResolution = null,
  candidateOutcomes = [],
  planningGaps = [],
  metricsDiagnostics = null,
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
    blockingReasons: statisticsTimingBlockers(mapping, planningContext, policyBundle)
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

  if (incompleteSearchEvidence(strategyAttempts, exactCandidateOutcomes)) {
    return result({
      ...shared,
      category: ECONOMICS_PLAN_RESULT_CATEGORY.SEARCH_INCOMPLETE,
      conclusion: "UNKNOWN",
      reason: "SEARCH_INCOMPLETE"
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
  if (allCountCapacity) {
    return result({
      ...shared,
      category: ECONOMICS_PLAN_RESULT_CATEGORY.INFEASIBLE_PROVEN,
      conclusion: "PROVEN_INFEASIBLE",
      reason: "COUNT_CAPACITY"
    });
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
