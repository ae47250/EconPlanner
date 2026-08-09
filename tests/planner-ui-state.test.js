import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createGeneratedPlannerSession,
  GENERATED_PLANNER_SESSION_VERSION,
  PLANNER_VIEWS,
  plannerViewFromSearch,
  replaceEconomicsPlan,
  restoreGeneratedPlannerSession
} from "../lib/planning/uiState.js";

function sampleReport() {
  const plans = ["balanced", "explore-first", "one-year-early"].map((id, index) => ({
    id,
    label: ["Balanced", "Explore the Major", "One Year Early"][index],
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

test("comparison badges use the policy-backed generated plan label", async () => {
  const source = await readFile(new URL("../app/page.js", import.meta.url), "utf8");
  assert.match(source, /return plan\.label \|\| "Validated"/);
  assert.doesNotMatch(source, /"explore-first":\s*"Explore/);
});

test("generated planner session restores the exact selected plan for matching inputs", () => {
  const report = sampleReport();
  const saved = createGeneratedPlannerSession({
    report,
    inputSignature: "student-input-v1",
    selectedPlanId: "explore-first",
    view: PLANNER_VIEWS.PLAN
  });

  const restored = restoreGeneratedPlannerSession(JSON.stringify(saved), "student-input-v1");

  assert.deepEqual(restored.report, report);
  assert.equal(restored.selectedPlanId, "explore-first");
  assert.equal(restored.view, PLANNER_VIEWS.PLAN);
});

test("generated planner session is rejected after an earlier answer changes", () => {
  const saved = createGeneratedPlannerSession({
    report: sampleReport(),
    inputSignature: "before-change",
    selectedPlanId: "balanced",
    view: PLANNER_VIEWS.COMPARE
  });

  assert.equal(restoreGeneratedPlannerSession(saved, "after-change"), null);
});

test("generated planner sessions from before distribution validation regenerate", () => {
  const saved = createGeneratedPlannerSession({
    report: sampleReport(),
    inputSignature: "student-input-v1",
    selectedPlanId: "balanced",
    view: PLANNER_VIEWS.COMPARE
  });

  assert.equal(GENERATED_PLANNER_SESSION_VERSION, 6);
  assert.equal(restoreGeneratedPlannerSession({ ...saved, schemaVersion: 4 }, "student-input-v1"), null);
});

test("replacing one generated plan leaves the other plan objects untouched", () => {
  const report = sampleReport();
  const originalPlans = report.programs[0].economicsPlans;
  const replacement = { ...originalPlans[1], terms: [] };
  const nextReport = replaceEconomicsPlan(
    report,
    "explore-first",
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
  assert.equal(plannerViewFromSearch("?view=plan&plan=one-year-early"), PLANNER_VIEWS.PLAN);
  assert.equal(plannerViewFromSearch("?view=unknown"), PLANNER_VIEWS.INPUT);
});
