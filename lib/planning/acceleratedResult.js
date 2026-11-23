import { electiveCompletionBlockers, hasCompleteScheduleCoverage, pendingOverloadEvidence, statisticsTimingBlockers, unpublishedElectiveNeed } from "./completion-blockers.js";
import { policyMessage } from "../policy/term-load.js";
import { majorCourseCapacityBlocker } from "./noPlanResult.js";
import { studentTermLabel } from "./student-language.js";
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
  const capacityBlocker = majorCourseCapacityBlocker(mapping, earlyGraduationContext, student, policyBundle);
  const missingRequiredCoverage = coverageIncomplete && !chronologyBlockers.length;
  const blockingReasons = capacityBlocker ? [capacityBlocker]
    : exhaustive && !incomplete && !missingRequiredCoverage ? [...chronologyBlockers, ...electiveCompletionBlockers({mapping, student, planningContext: earlyGraduationContext, policyBundle})] : [];
  const pending = pendingOverloadEvidence(earlyGraduationContext, policyBundle, student, mapping);
  const extraElectives = unpublishedElectiveNeed({ mapping, student, planningContext: earlyGraduationContext, policyBundle });
  const overloadUnresolved = !capacityBlocker && !blockingReasons.length && pending.length > 0;
  const status = outcome?.displayed
    ? ACCELERATED_PLANNING_STATUS.POSSIBLE
    : !capacityBlocker && (extraElectives.length || incomplete || !exhaustive || missingRequiredCoverage || overloadUnresolved)
      ? ACCELERATED_PLANNING_STATUS.MORE_INFORMATION_NEEDED
      : ACCELERATED_PLANNING_STATUS.NOT_POSSIBLE;
  const label = acceleratedLabel(planningContext.effectiveStanding);
  const message = capacityBlocker ? capacityBlocker.message
    : !outcome?.displayed && extraElectives.length ? extraElectives.map(reason => reason.message).join(" ") : blockingReasons.length ? blockingReasons.map(reason => reason.message).join(" ") : !outcome?.displayed && overloadUnresolved && exhaustive && !incomplete && !missingRequiredCoverage
    ? policyMessage(policyBundle, "termLoad.pending", {terms: pending.map(item => item.term).join(", ")}) : status === ACCELERATED_PLANNING_STATUS.POSSIBLE
    ? `${label} appears possible under the current requirements and planning evidence.`
    : status === ACCELERATED_PLANNING_STATUS.NOT_POSSIBLE
      ? `Your remaining courses do not fit by ${studentTermLabel(earlyGraduationContext?.expectedGraduationTerm)}.`
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
      pendingOverloadEvidence: pending,
      extraElectiveNeeds: extraElectives
    }
  };
}
