export const ACCELERATED_PLANNING_STATUS = Object.freeze({
  POSSIBLE: "POSSIBLE",
  NOT_POSSIBLE: "NOT_POSSIBLE",
  MORE_INFORMATION_NEEDED: "MORE_INFORMATION_NEEDED"
});

function acceleratedLabel(standing) {
  return String(standing || "").toLowerCase() === "junior"
    ? "Graduate next year"
    : "Graduate one year early";
}

export function buildAcceleratedPlanningResult({
  planningContext,
  earlyGraduationContext,
  candidateOutcomes = [],
  metricsDiagnostics = null
} = {}) {
  if (!planningContext?.earlyComparisonRequested) return null;

  const outcome = candidateOutcomes.find(item => item.id === "one-year-early") || null;
  const attempts = (metricsDiagnostics?.strategyAttempts || [])
    .filter(attempt => attempt.strategyId === "one-year-early");
  const exhaustive = attempts.length > 0 && attempts.every(attempt => attempt.exhaustive === true);
  const incomplete = outcome?.status === "SEARCH_INCOMPLETE"
    || outcome?.suppressionReason?.code === "SEARCH_INCOMPLETE"
    || attempts.some(attempt => attempt.exhaustive === false);
  const status = outcome?.displayed
    ? ACCELERATED_PLANNING_STATUS.POSSIBLE
    : incomplete || !exhaustive
      ? ACCELERATED_PLANNING_STATUS.MORE_INFORMATION_NEEDED
      : ACCELERATED_PLANNING_STATUS.NOT_POSSIBLE;
  const label = acceleratedLabel(planningContext.effectiveStanding);
  const message = status === ACCELERATED_PLANNING_STATUS.POSSIBLE
    ? `${label} appears possible under the current requirements and planning evidence.`
    : status === ACCELERATED_PLANNING_STATUS.NOT_POSSIBLE
      ? `${label} is not possible under the current requirements, course timing, and selected term capacity.`
      : `More information is needed before EconPlanner can determine whether you can ${label.toLowerCase()}.`;

  return {
    schemaVersion: 1,
    requested: true,
    status,
    label,
    effectiveStanding: planningContext.effectiveStanding,
    standardTarget: planningContext.expectedGraduationTerm,
    acceleratedTarget: earlyGraduationContext?.expectedGraduationTerm || null,
    message,
    reasonCode: outcome?.suppressionReason?.code || outcome?.reasons?.[0]?.code || null,
    evidence: {
      candidateOutcome: outcome,
      exhaustive
    }
  };
}
