import test from "node:test";
import assert from "node:assert/strict";
import {
  createGeneratedPlannerSession,
  GENERATED_PLANNER_SESSION_VERSION,
  PLANNER_VIEWS,
  plannerViewFromSearch,
  replaceEconomicsPlan,
  restoreGeneratedPlannerSession
} from "../lib/planning/uiState.js";

function sampleReport() {
  const plans = ["plan-1", "plan-2", "plan-3"].map((id, index) => ({
    id,
    label: `Plan ${index + 1}`,
    terms: [{ term: "Fall", courses: [{ course: `ECO ${index + 1}` }] }]
  }));
  return {
    programs: [{
      program: { name: "Economics" },
      economicsPlan: plans[0],
      economicsPlans: plans,
      economicsPlanValidation: { valid: true }
    }]
  };
}

test("generated planner session restores the exact selected plan for matching inputs", () => {
  const report = sampleReport();
  const saved = createGeneratedPlannerSession({
    report,
    inputSignature: "student-input-v1",
    selectedPlanId: "plan-2",
    view: PLANNER_VIEWS.PLAN
  });

  const restored = restoreGeneratedPlannerSession(JSON.stringify(saved), "student-input-v1");

  assert.deepEqual(restored.report, report);
  assert.equal(restored.selectedPlanId, "plan-2");
  assert.equal(restored.view, PLANNER_VIEWS.PLAN);
});

test("generated planner session is rejected after an earlier answer changes", () => {
  const saved = createGeneratedPlannerSession({
    report: sampleReport(),
    inputSignature: "before-change",
    selectedPlanId: "plan-1",
    view: PLANNER_VIEWS.COMPARE
  });

  assert.equal(restoreGeneratedPlannerSession(saved, "after-change"), null);
});

test("generated planner sessions from before distribution validation regenerate", () => {
  const saved = createGeneratedPlannerSession({
    report: sampleReport(),
    inputSignature: "student-input-v1",
    selectedPlanId: "plan-1",
    view: PLANNER_VIEWS.COMPARE
  });

  assert.equal(GENERATED_PLANNER_SESSION_VERSION, 5);
  assert.equal(restoreGeneratedPlannerSession({ ...saved, schemaVersion: 4 }, "student-input-v1"), null);
});

test("replacing one generated plan leaves the other plan objects untouched", () => {
  const report = sampleReport();
  const originalPlans = report.programs[0].economicsPlans;
  const replacement = { ...originalPlans[1], terms: [] };
  const nextReport = replaceEconomicsPlan(
    report,
    "plan-2",
    replacement,
    { valid: false, uniquePlanCount: 3 }
  );
  const nextPlans = nextReport.programs[0].economicsPlans;

  assert.notEqual(nextReport, report);
  assert.equal(nextPlans[0], originalPlans[0]);
  assert.equal(nextPlans[1], replacement);
  assert.equal(nextPlans[2], originalPlans[2]);
  assert.equal(nextReport.programs[0].economicsPlan, originalPlans[0]);
  assert.equal(nextReport.programs[0].economicsPlanValidation.valid, false);
});

test("planner view query accepts only supported generated-plan views", () => {
  assert.equal(plannerViewFromSearch("?view=compare"), PLANNER_VIEWS.COMPARE);
  assert.equal(plannerViewFromSearch("?view=plan&plan=plan-3"), PLANNER_VIEWS.PLAN);
  assert.equal(plannerViewFromSearch("?view=unknown"), PLANNER_VIEWS.INPUT);
});
