import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyNoPlan,
  noPlanCategory
} from "../scripts/run-economics-nightly-matrix.mjs";

const diagnostics = (strategyAttempts, searchAttempts = []) => ({
  plans: [],
  metricsDiagnostics: { strategyAttempts, searchAttempts },
  candidateOutcomes: [],
  planningGaps: []
});

test("the CP0 no-plan taxonomy gives every current reason one stable category", () => {
  const cases = [
    ["INVALID_INPUT", "UNKNOWN", "INPUT_BLOCKED"],
    ["SEARCH_INCOMPLETE", "UNKNOWN", "SEARCH_INCOMPLETE"],
    ["POLICY_REVIEW_REQUIRED", "UNKNOWN", "POLICY_REVIEW_REQUIRED"],
    ["MISSING_OFFERING", "UNKNOWN", "SCHEDULE_BLOCKED"],
    ["COUNT_CAPACITY", "PROVEN_INFEASIBLE", "INFEASIBLE_PROVEN"],
    ["EMPTY_DOMAIN", "PROVEN_INFEASIBLE", "INFEASIBLE_PROVEN"],
    ["NO_COMPLETE_ASSIGNMENT", "PROVEN_INFEASIBLE", "INFEASIBLE_PROVEN"],
    ["PRODUCTION_FALSE_NEGATIVE", "UNKNOWN", "PRODUCTION_FALSE_NEGATIVE"],
    ["OTHER_CLASSIFIED", "UNKNOWN", "OTHER"],
    ["UNEXPLAINED", "UNKNOWN", "OTHER"]
  ];

  for (const [reason, conclusion, expected] of cases) {
    assert.equal(noPlanCategory(reason, conclusion), expected, reason);
  }
});

test("an incomplete search is classified before any infeasibility-looking evidence", () => {
  const result = classifyNoPlan(diagnostics(
    [{ exhaustive: false, solutionFound: false }],
    [{ failure: "COUNT_CAPACITY", emptyDomains: ["ECO 214"] }]
  ));

  assert.deepEqual(
    { conclusion: result.conclusion, reason: result.reason, category: result.category },
    { conclusion: "UNKNOWN", reason: "SEARCH_INCOMPLETE", category: "SEARCH_INCOMPLETE" }
  );
});

test("current no-plan evidence paths remain classified without overclaiming proof", () => {
  const cases = [
    [
      { ...diagnostics([], []), metricsDiagnostics: { invalidInput: true, strategyAttempts: [], searchAttempts: [] } },
      ["UNKNOWN", "INVALID_INPUT", "INPUT_BLOCKED"]
    ],
    [
      { ...diagnostics([{ exhaustive: true, solutionFound: false }]), planningGaps: [{ code: "ADVISOR_REVIEW_REQUIRED" }] },
      ["UNKNOWN", "POLICY_REVIEW_REQUIRED", "POLICY_REVIEW_REQUIRED"]
    ],
    [
      diagnostics([{ exhaustive: true, solutionFound: false }], [{ failure: "COUNT_CAPACITY" }]),
      ["PROVEN_INFEASIBLE", "COUNT_CAPACITY", "INFEASIBLE_PROVEN"]
    ],
    [
      { ...diagnostics([{ exhaustive: true, solutionFound: false }], [{ failure: "OTHER" }]), planningGaps: [{ message: "No verified offering remains." }] },
      ["UNKNOWN", "MISSING_OFFERING", "SCHEDULE_BLOCKED"]
    ],
    [
      diagnostics([{ exhaustive: true, solutionFound: false }], [{ failure: "EMPTY_DOMAIN", emptyDomains: ["ECO 214"] }]),
      ["PROVEN_INFEASIBLE", "EMPTY_DOMAIN", "INFEASIBLE_PROVEN"]
    ],
    [
      diagnostics([{ exhaustive: true, solutionFound: false }], [{ failure: "OTHER" }]),
      ["PROVEN_INFEASIBLE", "NO_COMPLETE_ASSIGNMENT", "INFEASIBLE_PROVEN"]
    ],
    [
      diagnostics([{ exhaustive: false, solutionFound: true }], [{ failure: "OTHER" }]),
      ["UNKNOWN", "OTHER_CLASSIFIED", "OTHER"]
    ]
  ];

  for (const [bundle, expected] of cases) {
    const result = classifyNoPlan(bundle);
    assert.deepEqual([result.conclusion, result.reason, result.category], expected);
  }
});
