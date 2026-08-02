export const GENERATED_PLANNER_SESSION_VERSION = 4;

export const PLANNER_VIEWS = Object.freeze({
  INPUT: "input",
  COMPARE: "compare",
  PLAN: "plan"
});

export function economicsResultFromReport(report) {
  return report?.programs?.find(result => (
    result.economicsPlan
    || result.program?.name === "Economics"
  )) || null;
}

export function plannerViewFromSearch(search = "") {
  const params = new URLSearchParams(search);
  const view = params.get("view");
  if (view === PLANNER_VIEWS.COMPARE || view === PLANNER_VIEWS.PLAN) return view;
  return PLANNER_VIEWS.INPUT;
}

export function createGeneratedPlannerSession({
  report,
  inputSignature,
  selectedPlanId,
  view,
  planEditUndo = null
}) {
  return {
    schemaVersion: GENERATED_PLANNER_SESSION_VERSION,
    report,
    inputSignature,
    selectedPlanId,
    view,
    planEditUndo
  };
}

export function restoreGeneratedPlannerSession(rawValue, currentInputSignature) {
  try {
    const saved = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
    if (saved?.schemaVersion !== GENERATED_PLANNER_SESSION_VERSION) return null;
    if (!saved.report || saved.inputSignature !== currentInputSignature) return null;

    const plans = economicsResultFromReport(saved.report)?.economicsPlans || [];
    if (!plans.length) return null;

    const selectedPlanId = plans.some(plan => plan.id === saved.selectedPlanId)
      ? saved.selectedPlanId
      : plans[0].id;
    const view = saved.view === PLANNER_VIEWS.PLAN
      ? PLANNER_VIEWS.PLAN
      : PLANNER_VIEWS.COMPARE;

    return {
      report: saved.report,
      inputSignature: saved.inputSignature,
      selectedPlanId,
      view,
      planEditUndo: saved.planEditUndo || null
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
