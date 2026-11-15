import { normalizePlanningPaceForEligibility } from "./strategyEligibility.js";

// Earlier sessions do not bind saved decisions and undo to policy/report context.
export const GENERATED_PLANNER_SESSION_VERSION = 10;
export const PLANNER_INPUT_STATE_VERSION = 8;

export const PLANNER_VIEWS = Object.freeze({
  INPUT: "input",
  COMPARE: "compare",
  PLAN: "plan"
});

export function migratePlannerInputState(formData = {}) {
  const paceEligibility = normalizePlanningPaceForEligibility({
    planningPace: formData.planningPace,
    effectiveStanding: formData.academicStanding
  });
  if (!paceEligibility.planningPaceNormalization) {
    return { formData, notices: [] };
  }

  return {
    formData: {
      ...formData,
      planningPace: paceEligibility.planningPace
    },
    notices: [{
      ...paceEligibility.planningPaceNormalization,
      code: "SAVED_ONE_YEAR_EARLY_NORMALIZED_TO_STANDARD",
      sourceCode: paceEligibility.planningPaceNormalization.code,
      message: "One Year Early is available through junior standing. We kept your saved answers and changed this senior plan to the standard graduation timeline."
    }]
  };
}

export function economicsResultFromReport(report) {
  return report?.programs?.find(result => (
    result.economicsPlan
    || result.program?.name === "Economics"
  )) || null;
}

export function plannerViewFromSearch(search = "") {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  if (view === PLANNER_VIEWS.COMPARE || view === PLANNER_VIEWS.PLAN) return PLANNER_VIEWS.COMPARE;
  return PLANNER_VIEWS.INPUT;
}

export function createGeneratedPlannerSession({
  report = null,
  inputBlock = null,
  inputSignature,
  selectedPlanId,
  view,
  planEditUndo = null,
  reportContextId = null
}) {
  return {
    schemaVersion: GENERATED_PLANNER_SESSION_VERSION,
    plannerFingerprint: report?.plannerFingerprint || inputBlock?.plannerFingerprint || null,
    reportContextId,
    report,
    inputBlock,
    inputSignature,
    selectedPlanId,
    view,
    planEditUndo
  };
}

export function restoreGeneratedPlannerSession(rawValue, currentInputSignature, activeFingerprint) {
  try {
    const saved = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
    if (saved?.schemaVersion !== GENERATED_PLANNER_SESSION_VERSION) return null;
    if (typeof activeFingerprint !== "string" || !activeFingerprint
      || saved.plannerFingerprint !== activeFingerprint) return null;
    const resultFingerprint = saved.report?.plannerFingerprint || saved.inputBlock?.plannerFingerprint;
    if (resultFingerprint !== activeFingerprint) return null;
    if ((!saved.report && !saved.inputBlock) || saved.inputSignature !== currentInputSignature) return null;

    const plans = economicsResultFromReport(saved.report)?.economicsPlans || [];
    const selectedPlanId = plans.some(plan => plan.id === saved.selectedPlanId)
      ? saved.selectedPlanId
      : plans[0]?.id || "";
    const view = PLANNER_VIEWS.COMPARE;

    return {
      report: saved.report,
      inputBlock: saved.inputBlock || null,
      inputSignature: saved.inputSignature,
      selectedPlanId,
      view,
      reportContextId: saved.reportContextId || null,
      planEditUndo: saved.reportContextId
        && saved.planEditUndo?.reportContextId === saved.reportContextId
        && saved.planEditUndo?.inputSignature === currentInputSignature
        && plans.some(plan => plan.id === saved.planEditUndo?.planId)
        && saved.planEditUndo?.plan?.id === saved.planEditUndo.planId
        ? saved.planEditUndo : null
    };
  } catch {
    return null;
  }
}

export function replaceEconomicsPlan(report, planId, nextPlan, planSetValidation) {
  if (!report || !planId || !nextPlan) return report;

  let replaced = false;
  const programs = (report.programs || []).map(program => {
    const plans = program.economicsPlans || [];
    if (!plans.some(plan => plan.id === planId)) return program;

    replaced = true;
    const economicsPlans = plans.map(plan => plan.id === planId ? nextPlan : plan);
    return {
      ...program,
      economicsPlan: economicsPlans[0] || null,
      economicsPlans,
      economicsPlanValidation: planSetValidation || program.economicsPlanValidation
    };
  });

  return replaced ? { ...report, programs } : report;
}
