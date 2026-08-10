import test from "node:test";
import assert from "node:assert/strict";
import {
  ECONOMICS_PLANNING_STRATEGY_ELIGIBILITY,
  isOneYearEarlyEligible,
  isPlanningStrategyEligible,
  normalizePlanningPaceForEligibility
} from "../lib/planning/strategyEligibility.js";

test("the client-safe eligibility projection preserves the compiled strategy boundaries", () => {
  assert.deepEqual(
    ECONOMICS_PLANNING_STRATEGY_ELIGIBILITY["one-year-early"].effectiveStandings,
    ["freshman", "sophomore"]
  );
  assert.equal(isPlanningStrategyEligible("balanced", "senior"), true);
  assert.equal(isPlanningStrategyEligible("explore-first", "junior"), false);
  assert.equal(isPlanningStrategyEligible("unknown", "freshman"), false);
});

test("One Year Early is eligible only for effective freshmen and sophomores", () => {
  assert.equal(isOneYearEarlyEligible("freshman"), true);
  assert.equal(isOneYearEarlyEligible("Sophomore"), true);
  assert.equal(isOneYearEarlyEligible("junior"), false);
  assert.equal(isOneYearEarlyEligible("senior"), false);
});

test("ineligible One Year Early pace requests normalize with a structured plain-language notice", () => {
  const normalized = normalizePlanningPaceForEligibility({
    planningPace: "one_year_early",
    effectiveStanding: "junior"
  });
  assert.equal(normalized.planningPace, "standard");
  assert.equal(normalized.oneYearEarlyEligible, false);
  assert.deepEqual(
    {
      code: normalized.planningPaceNormalization.code,
      field: normalized.planningPaceNormalization.field,
      submittedValue: normalized.planningPaceNormalization.submittedValue,
      normalizedValue: normalized.planningPaceNormalization.normalizedValue,
      effectiveStanding: normalized.planningPaceNormalization.effectiveStanding
    },
    {
      code: "ONE_YEAR_EARLY_NORMALIZED_TO_STANDARD",
      field: "planningPace",
      submittedValue: "one_year_early",
      normalizedValue: "standard",
      effectiveStanding: "junior"
    }
  );
  assert.match(normalized.planningPaceNormalization.message, /standard graduation timeline/i);
});
