import test from "node:test";
import assert from "node:assert/strict";

import {
  buildEconomicsPlanResult,
  ECONOMICS_PLAN_RESULT_CATEGORY
} from "../lib/planning/noPlanResult.js";

function diagnostics(strategyAttempts, searchAttempts = []) {
  return { strategyAttempts, searchAttempts };
}

test("returned plans are ready while preserving structured advisor actions", () => {
  const action = {
    actionId: "advisor-action-example",
    reasonCode: "ENROLLMENT_FULL",
    currentDisposition: "UNRESOLVED_REVIEW"
  };
  const result = buildEconomicsPlanResult({
    plans: [{ id: "balanced", advisorActions: [action] }],
    candidateOutcomes: [{ id: "balanced", displayed: true }]
  });

  assert.equal(result.category, ECONOMICS_PLAN_RESULT_CATEGORY.PLANS_READY);
  assert.equal(result.reason, "VALIDATED_PLANS_RETURNED");
  assert.deepEqual(result.actions, [action]);
  assert.deepEqual(result.evidence.candidateOutcomes, [{ id: "balanced", displayed: true }]);
});

test("blocked input preserves the exact questions and input-resolution evidence", () => {
  const questions = [{ field: "planningPace", prompt: "Choose a supported planning pace." }];
  const inputResolution = {
    status: "UNSUPPORTED_INPUT",
    issueCode: "INVALID_PLANNING_PACE",
    planningMustRemainBlocked: true,
    blockingFields: ["planningPace"],
    questions
  };
  const result = buildEconomicsPlanResult({ inputResolution });

  assert.equal(result.category, ECONOMICS_PLAN_RESULT_CATEGORY.INPUT_BLOCKED);
  assert.equal(result.reason, "INVALID_INPUT");
  assert.deepEqual(result.questions, questions);
  assert.equal(result.evidence.inputResolution, inputResolution);
});

test("a blocking flag without invalid or missing-input evidence is not called input blocked", () => {
  const result = buildEconomicsPlanResult({
    inputResolution: { planningMustRemainBlocked: true }
  });

  assert.equal(result.category, ECONOMICS_PLAN_RESULT_CATEGORY.NEEDS_ADVISOR_ATTENTION);
});

test("incomplete search evidence is never promoted to proven infeasibility", () => {
  const result = buildEconomicsPlanResult({
    metricsDiagnostics: diagnostics(
      [{ exhaustive: false, solutionFound: false }],
      [{ failure: "COUNT_CAPACITY", emptyDomains: ["eco-461"] }]
    )
  });

  assert.equal(result.category, ECONOMICS_PLAN_RESULT_CATEGORY.SEARCH_INCOMPLETE);
  assert.equal(result.conclusion, "UNKNOWN");
  assert.equal(result.reason, "SEARCH_INCOMPLETE");
});

test("candidate outcome evidence also preserves an incomplete-search result", () => {
  const candidateOutcomes = [{
    id: "balanced",
    status: "SEARCH_INCOMPLETE",
    suppressionReason: { code: "SEARCH_INCOMPLETE", message: "The bounded search did not finish." }
  }];
  const result = buildEconomicsPlanResult({ candidateOutcomes });

  assert.equal(result.category, ECONOMICS_PLAN_RESULT_CATEGORY.SEARCH_INCOMPLETE);
  assert.equal(result.evidence.candidateOutcomes, candidateOutcomes);
});

test("only exhaustive count, empty-domain, or no-assignment evidence proves infeasibility", () => {
  const cases = [
    [
      diagnostics([{ exhaustive: true, solutionFound: false }], [{ failure: "COUNT_CAPACITY" }]),
      "COUNT_CAPACITY"
    ],
    [
      diagnostics([{ exhaustive: true, solutionFound: false }], [{ failure: "OTHER", emptyDomains: ["eco-214"] }]),
      "EMPTY_DOMAIN"
    ],
    [
      diagnostics([{ exhaustive: true, solutionFound: false }], [{ failure: "OTHER" }]),
      "NO_COMPLETE_ASSIGNMENT"
    ]
  ];

  for (const [metricsDiagnostics, reason] of cases) {
    const result = buildEconomicsPlanResult({ metricsDiagnostics });
    assert.equal(result.category, ECONOMICS_PLAN_RESULT_CATEGORY.INFEASIBLE_PROVEN, reason);
    assert.equal(result.conclusion, "PROVEN_INFEASIBLE", reason);
    assert.equal(result.reason, reason);
  }

  const nonExhaustive = buildEconomicsPlanResult({
    metricsDiagnostics: diagnostics(
      [{ exhaustive: false, solutionFound: true }],
      [{ failure: "COUNT_CAPACITY" }]
    )
  });
  assert.equal(nonExhaustive.category, ECONOMICS_PLAN_RESULT_CATEGORY.NEEDS_ADVISOR_ATTENTION);
});

test("review-required and missing-offering evidence remain advisor-attention results", () => {
  const exhaustive = diagnostics([{ exhaustive: true, solutionFound: false }], [{ failure: "OTHER" }]);
  const review = buildEconomicsPlanResult({
    metricsDiagnostics: exhaustive,
    planningGaps: [{ code: "ADVISOR_REVIEW_REQUIRED" }]
  });
  const missingOffering = buildEconomicsPlanResult({
    metricsDiagnostics: exhaustive,
    planningGaps: [{ message: "No verified offering remains." }]
  });

  assert.equal(review.category, ECONOMICS_PLAN_RESULT_CATEGORY.NEEDS_ADVISOR_ATTENTION);
  assert.equal(review.reason, "POLICY_REVIEW_REQUIRED");
  assert.equal(missingOffering.category, ECONOMICS_PLAN_RESULT_CATEGORY.NEEDS_ADVISOR_ATTENTION);
  assert.equal(missingOffering.reason, "MISSING_OFFERING");
});
