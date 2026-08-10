import planningFlexibilityBundle from "../../data/compiled/policy/planning-flexibility/econ-planning-flexibility.4/bundle.json" with { type: "json" };

export const ONE_YEAR_EARLY_STRATEGY_ID = "one-year-early";
export const ONE_YEAR_EARLY_PLANNING_PACE = "one_year_early";
export const STANDARD_PLANNING_PACE = "standard";

const strategyContract = planningFlexibilityBundle?.policy?.economicsPlanningStrategies;
if (strategyContract?.classification !== "NONACADEMIC_PLANNING_AND_RANKING_PREFERENCES") {
  throw new Error("The compiled nonacademic Economics planning-strategy contract is unavailable.");
}

export const ECONOMICS_PLANNING_STRATEGY_ELIGIBILITY = Object.freeze(Object.fromEntries(
  strategyContract.strategies.map(strategy => [
    strategy.id,
    Object.freeze({
      ...(strategy.eligibility || {}),
      effectiveStandings: Object.freeze([...(strategy.eligibility?.effectiveStandings || [])])
    })
  ])
));

function normalizedStanding(value) {
  return String(value || "").trim().toLowerCase();
}

export function isPlanningStrategyEligible(strategyId, standing) {
  const eligibility = ECONOMICS_PLANNING_STRATEGY_ELIGIBILITY[strategyId];
  if (!eligibility) return false;
  if (!eligibility.effectiveStandings.length) return true;
  return eligibility.effectiveStandings.includes(normalizedStanding(standing));
}

export function isOneYearEarlyEligible(standing) {
  return isPlanningStrategyEligible(ONE_YEAR_EARLY_STRATEGY_ID, standing);
}

export function normalizePlanningPaceForEligibility({ planningPace, effectiveStanding } = {}) {
  const oneYearEarlyEligible = isOneYearEarlyEligible(effectiveStanding);
  if (planningPace !== ONE_YEAR_EARLY_PLANNING_PACE || oneYearEarlyEligible) {
    return {
      planningPace,
      oneYearEarlyEligible,
      planningPaceNormalization: null
    };
  }

  return {
    planningPace: STANDARD_PLANNING_PACE,
    oneYearEarlyEligible,
    planningPaceNormalization: Object.freeze({
      code: "ONE_YEAR_EARLY_NORMALIZED_TO_STANDARD",
      field: "planningPace",
      submittedValue: ONE_YEAR_EARLY_PLANNING_PACE,
      normalizedValue: STANDARD_PLANNING_PACE,
      reasonCode: "ONE_YEAR_EARLY_EFFECTIVE_STANDING_INELIGIBLE",
      effectiveStanding: normalizedStanding(effectiveStanding) || null,
      message: "One Year Early is available through junior standing. This senior request will use the standard graduation timeline."
    })
  };
}
