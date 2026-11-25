import test from "node:test";
import assert from "node:assert/strict";
import { createPlanRanking } from "../lib/planning/planRanking.js";
import { compareCp5ReferenceCandidates } from "../lib/planning/economics.js";

function plan(coursesByYear, targetYearCounts) {
  return {
    distribution: { targetYearCounts },
    terms: coursesByYear.map((courses, yearIndex) => ({
      yearIndex,
      termKey: "Fall",
      slotId: `fall-${yearIndex}`,
      courses
    }))
  };
}

function course(code, source, requirementId = "eco-113") {
  return { course: code, source, requirementId };
}

function compare(left, right, strategy) {
  return compareCp5ReferenceCandidates(left, right, {
    planVariant: { strategy, rankingPreferences: {} },
    student: { academicStanding: "junior", courses: [] },
    prerequisites: {}
  });
}

for (const strategy of ["balanced", "explore-first"]) {
  test(`${strategy} puts better yearly fit before verified-course count`, () => {
    const targetFit = plan([
      [course("ECO 113", "projected-offering")],
      [course("ECO 114", "projected-offering", "eco-114")]
    ], [1, 1]);
    const moreVerified = plan([
      [course("ECO 113", "verified-offering"), course("ECO 114", "verified-offering", "eco-114")],
      []
    ], [1, 1]);
    assert.ok(compare(targetFit, moreVerified, strategy) < 0);
  });
}

test("one-year-early puts verified preferred finance before better yearly fit", () => {
  const preferredFinance = plan([
    [course("ECO 321", "verified-offering", "finance")], []
  ], [0, 1]);
  const targetFit = plan([
    [], [course("BUSN 323", "verified-offering", "finance")]
  ], [0, 1]);
  assert.ok(compare(preferredFinance, targetFit, "one-year-early") < 0);
});

test("equal yearly fit puts more verified courses first", () => {
  const verified = plan([[course("ECO 113", "verified-offering")]], [1]);
  const projected = plan([[course("ECO 113", "projected-offering")]], [1]);
  assert.ok(compare(verified, projected, "balanced") < 0);
});

test("approval type alone does not change the approval ranking weight", () => {
  const instructor = plan([[course("ECO 113", "verified-offering")]], [1]);
  instructor.feasibility = { requiredApprovals: [{ type: "instructor" }] };
  const department = structuredClone(instructor);
  department.feasibility.requiredApprovals[0].type = "department";
  const { planSafetyMetrics } = createPlanRanking({
    plannerTrackedTermLoad: term => term.courses.length,
    isEconomicCourse: code => code.startsWith("ECO "),
    semanticPlanSignature: () => "same-placement"
  });
  // Isolate this key: the final signature tie-breaker also records approval type.
  assert.equal(planSafetyMetrics(instructor).approvalWeight, 1);
  assert.equal(planSafetyMetrics(department).approvalWeight, 1);
  assert.equal(planSafetyMetrics(instructor).approvalWeight - planSafetyMetrics(department).approvalWeight, 0);
});
