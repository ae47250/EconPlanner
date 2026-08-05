import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { characterizeDisplayedPlan } from "../scripts/run-economics-nightly-matrix.mjs";

const readJson = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));

function plan(overrides = {}) {
  return {
    id: "balanced",
    label: "Balanced",
    feasibilityStatus: "PRELIMINARY_ONLY",
    unscheduled: [],
    distribution: { strategy: "equal" },
    validation: {
      valid: true,
      distribution: {
        applicable: true,
        valid: true,
        exact: true,
        annualDistance: 0,
        warnings: [],
        errors: []
      }
    },
    ...overrides
  };
}

test("CP0 labels current completion and release results as proxies", () => {
  const result = characterizeDisplayedPlan(plan());

  assert.equal(result.targetCompletionStatus, null);
  assert.equal(result.targetCompletionAvailability, "NOT_MEASURED");
  assert.equal(result.legacyValidatedDisplayedPlan, true);
  assert.equal(result.legacyValidationProxyAvailability, "PROXY");
  assert.equal(result.targetEvidenceStatus, null);
  assert.equal(result.targetEvidenceAvailability, "NOT_MEASURED");
  assert.equal(result.legacyFeasibilityStatus, "PRELIMINARY_ONLY");
  assert.equal(result.strategy, "BALANCED");
  assert.equal(result.strategyFit, "EXACT");
  assert.equal(result.strategyFitAvailability, "PROXY");
});

test("CP0 records unavailable future contracts with null values", () => {
  const result = characterizeDisplayedPlan(plan());

  assert.deepEqual(result.productionDecisionEngine, {
    availability: "NOT_MEASURED",
    reasonCode: "PRODUCTION_DECISION_ENGINE_NOT_IMPLEMENTED_UNTIL_CP3",
    status: null
  });
  assert.deepEqual(result.validatedSnapshot, {
    availability: "NOT_MEASURED",
    reasonCode: "SIGNED_VALIDATED_PLAN_SNAPSHOT_NOT_IMPLEMENTED_UNTIL_CP6",
    issued: null
  });
  assert.deepEqual(result.reportReadiness, {
    availability: "NOT_MEASURED",
    reasonCode: "REPORT_AND_PDF_NOT_EXECUTED_FOR_EVERY_GENERATED_PROFILE",
    ready: null
  });
});

test("search-incomplete plans are never counted as legacy validated displayed plans", () => {
  const result = characterizeDisplayedPlan(plan({
    feasibilityStatus: "SEARCH_INCOMPLETE",
    validation: { valid: false, distribution: { applicable: true, valid: false, exact: false, annualDistance: 2, warnings: [], errors: ["incomplete"] } }
  }));

  assert.equal(result.legacyValidatedDisplayedPlan, false);
  assert.equal(result.targetEvidenceStatus, null);
  assert.equal(result.legacyFeasibilityStatus, "SEARCH_INCOMPLETE");
  assert.equal(result.strategyFit, "MISMATCH");
  assert.equal(result.strategyDeviation, 2);
});

test("missing legacy fields never become successful or zero-valued measurements", () => {
  const result = characterizeDisplayedPlan(plan({
    unscheduled: undefined,
    validation: {
      valid: true,
      distribution: { applicable: true, valid: true, exact: false, annualDistance: null }
    }
  }));

  assert.equal(result.legacyValidatedDisplayedPlan, false);
  assert.equal(result.strategyDeviation, null);
  assert.deepEqual(result.deviationReasons, []);
});

test("the CP0 fixture freezes exact-main measurements without inventing B_COMPLETE", async () => {
  const baseline = await readJson("./fixtures/econplanner-architecture-baseline.v2.json");

  assert.equal(baseline.checkpoint, "CP0");
  assert.equal(baseline.status, "PENDING_OWNER_APPROVAL");
  assert.equal(baseline.source.plannerBehaviorCommitSha, "011a624f13f2cb1b62c1acf550ea91c67c6e71b3");
  assert.equal(baseline.source.originMainSha, baseline.source.plannerBehaviorCommitSha);
  assert.equal(baseline.source.runtimeBehaviorChanged, false);
  assert.equal(baseline.cohort.profiles, 368);
  assert.equal(baseline.metrics.profiles.failures, 0);
  assert.equal(baseline.metrics.profiles.withDisplayedPlans, 186);
  assert.equal(baseline.metrics.profiles.withoutDisplayedPlans, 182);
  assert.equal(baseline.metrics.noPlan.explained, 182);
  assert.equal(baseline.metrics.noPlan.unexplained, 0);
  assert.equal(baseline.metrics.primaryProductCoverage.availability, "NOT_MEASURED");
  assert.equal(baseline.metrics.primaryProductCoverage.numerator, null);
  assert.equal(baseline.metrics.primaryProductCoverage.percentage, null);
  assert.equal(baseline.metrics.legacyValidationProxy.availability, "PROXY");
  assert.equal(baseline.governance.nextCheckpointAuthorized, false);
});
