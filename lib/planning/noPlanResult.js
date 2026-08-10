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
      ...additionalEvidence
    }
  };
}

export function buildEconomicsPlanResult({
  plans = [],
  inputResolution = null,
  candidateOutcomes = [],
  planningGaps = [],
  metricsDiagnostics = null
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
    searchAttempts
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
