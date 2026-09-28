import { electiveCompletionBlockers, hasCompleteScheduleCoverage, pendingOverloadEvidence, statisticsTimingBlockers } from "./completion-blockers.js";
import { policyMessage } from "../policy/term-load.js";
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
  metricsDiagnostics = null,
  mapping = null, student = {}, policyBundle = null
} = {}) {
  if (!planningContext?.earlyComparisonRequested) return null;

  const outcome = candidateOutcomes.find(item => item.id === "one-year-early") || null;
  const attempts = (metricsDiagnostics?.strategyAttempts || [])
    .filter(attempt => attempt.strategyId === "one-year-early");
  const exhaustive = attempts.length > 0 && attempts.every(attempt => attempt.exhaustive === true);
  const incomplete = outcome?.status === "SEARCH_INCOMPLETE"
    || outcome?.suppressionReason?.code === "SEARCH_INCOMPLETE"
    || attempts.some(attempt => attempt.exhaustive === false);
  const coverageIncomplete = policyBundle && !hasCompleteScheduleCoverage(earlyGraduationContext, policyBundle, {mapping, student});
  const chronologyBlockers = statisticsTimingBlockers(mapping, earlyGraduationContext, policyBundle);
  const missingRequiredCoverage = coverageIncomplete && !chronologyBlockers.length;
  const blockingReasons = exhaustive && !incomplete && !missingRequiredCoverage ? [...chronologyBlockers, ...electiveCompletionBlockers({mapping, student, planningContext: earlyGraduationContext, policyBundle})] : [];
  const pending = pendingOverloadEvidence(earlyGraduationContext, policyBundle, student, mapping);
  const overloadUnresolved = !blockingReasons.length && pending.length > 0;
  const status = outcome?.displayed
    ? ACCELERATED_PLANNING_STATUS.POSSIBLE
    : incomplete || !exhaustive || missingRequiredCoverage || overloadUnresolved
      ? ACCELERATED_PLANNING_STATUS.MORE_INFORMATION_NEEDED
      : ACCELERATED_PLANNING_STATUS.NOT_POSSIBLE;
  const label = acceleratedLabel(planningContext.effectiveStanding);
  const message = blockingReasons.length ? blockingReasons.map(reason => reason.message).join(" ") : !outcome?.displayed && overloadUnresolved && exhaustive && !incomplete && !missingRequiredCoverage
    ? policyMessage(policyBundle, "termLoad.pending", {terms: pending.map(item => item.term).join(", ")}) : status === ACCELERATED_PLANNING_STATUS.POSSIBLE
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
      strategyAttempts: attempts,
      exhaustive,
      coverageIncomplete: Boolean(coverageIncomplete),
      blockingReasons,
      pendingOverloadEvidence: pending
    }
  };
}
