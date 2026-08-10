import test from "node:test";
import assert from "node:assert/strict";
import { buildAcceleratedPlanningResult } from "../lib/planning/acceleratedResult.js";

const context = {
  earlyComparisonRequested: true,
  effectiveStanding: "junior",
  expectedGraduationTerm: "Spring/May 2028"
};
const earlyContext = {expectedGraduationTerm: "Spring/May 2027"};

test("accelerated result reports possible from the displayed backend candidate", () => {
  const result = buildAcceleratedPlanningResult({
    planningContext: context,
    earlyGraduationContext: earlyContext,
    candidateOutcomes: [{id: "one-year-early", displayed: true, status: "VERIFIED_FEASIBLE"}],
    metricsDiagnostics: {strategyAttempts: [{strategyId: "one-year-early", exhaustive: true}]}
  });

  assert.equal(result.status, "POSSIBLE");
  assert.equal(result.label, "Graduate next year");
  assert.equal(result.standardTarget, "Spring/May 2028");
  assert.equal(result.acceleratedTarget, "Spring/May 2027");
});

test("accelerated result distinguishes proven not possible from incomplete search", () => {
  const notPossible = buildAcceleratedPlanningResult({
    planningContext: context,
    earlyGraduationContext: earlyContext,
    candidateOutcomes: [{id: "one-year-early", displayed: false, status: "NOT_FEASIBLE", suppressionReason: {code: "NOT_FEASIBLE"}}],
    metricsDiagnostics: {strategyAttempts: [{strategyId: "one-year-early", exhaustive: true}]}
  });
  const incomplete = buildAcceleratedPlanningResult({
    planningContext: context,
    earlyGraduationContext: earlyContext,
    candidateOutcomes: [{id: "one-year-early", displayed: false, status: "SEARCH_INCOMPLETE", suppressionReason: {code: "SEARCH_INCOMPLETE"}}],
    metricsDiagnostics: {strategyAttempts: [{strategyId: "one-year-early", exhaustive: false}]}
  });

  assert.equal(notPossible.status, "NOT_POSSIBLE");
  assert.equal(incomplete.status, "MORE_INFORMATION_NEEDED");
});

test("accelerated result is absent when the student did not request it", () => {
  assert.equal(buildAcceleratedPlanningResult({
    planningContext: {...context, earlyComparisonRequested: false}
  }), null);
});
