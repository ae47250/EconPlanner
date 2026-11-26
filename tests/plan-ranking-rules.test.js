import test from "node:test";
import assert from "node:assert/strict";
import { createPlanRanking } from "../lib/planning/planRanking.js";
import { classifyFeasibility, compareCp5ReferenceCandidates, FEASIBILITY_STATUS } from "../lib/planning/economics.js";
import { buildCoursePlacement } from "../lib/planning/termSolver.js";

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

// owner-eco321-petition-2026-11-26: on an older catalog, BUSN 323 for finance needs a petition,
// so a confirmed ECO 321 comes before yearly fit; on a current catalog yearly fit still decides.
for (const strategy of ["balanced", "explore-first"]) {
  for (const [catalog, eco321First] of [["2024-2025", true], ["2025-2026", false]]) {
    test(`${strategy}, ${catalog} catalog: confirmed ECO 321 ${eco321First ? "beats" : "does not beat"} better yearly fit with BUSN 323`, () => {
      const context = { entryCatalogYear: catalog };
      const preferredFinance = { ...plan([[course("ECO 321", "verified-offering", "finance")], []], [0, 1]), planningContext: context };
      const targetFit = { ...plan([[], [course("BUSN 323", "verified-offering", "finance")]], [0, 1]), planningContext: context };
      const result = compare(preferredFinance, targetFit, strategy);
      assert.ok(eco321First ? result < 0 : result > 0);
    });
  }
}

// The full planner must offer the ECO 321 plan to the ranking in the first place (search step).
test("full planner: older-catalog student gets confirmed ECO 321, current-catalog student keeps yearly fit", async () => {
  const { POST } = await import("../app/api/majors/map/route.js");
  const financeOf = async majorDeclarationCatalogYear => {
    const student = { academicStanding: "sophomore", majorDeclarationCatalogYear, planCreationDate: "2026-08-15", courses: [{ code: "ECO 113", status: "completed" }] };
    const response = await POST(new Request("http://localhost/api/majors/map", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ student }) }));
    const balanced = (await response.json()).programs.find(item => item.economicsPlans).economicsPlans.find(plan => plan.id === "balanced");
    return balanced.terms.flatMap(term => term.courses.filter(item => item.requirementId === "finance").map(item => `${item.course} ${term.term}`))[0];
  };
  assert.equal(await financeOf("2024-2025"), "ECO 321 Winter 2027");
  assert.equal(await financeOf("2025-2026"), "BUSN 323 Fall 2028");
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

function isolatedRanking() {
  return createPlanRanking({
    plannerTrackedTermLoad: term => term.courses.length,
    isEconomicCourse: code => code.startsWith("ECO "),
    capstoneYearIndex: () => 0,
    semanticPlanSignature: () => "same-placement"
  });
}

test("May use alone does not break an otherwise equal plan-ranking tie", () => {
  const ranking = isolatedRanking();
  const withMay = {
    terms: ["Fall", "Winter", "May"].map((termKey, index) => ({
      termKey, yearIndex: 0,
      courses: index === 1 ? [] : [course(index === 0 ? "ECO 113" : "ECO 114", "verified-offering")]
    }))
  };
  const withWinter = structuredClone(withMay);
  withWinter.terms[1].courses = withWinter.terms[2].courses;
  withWinter.terms[2].courses = [];
  const mayMetrics = ranking.planSafetyMetrics(withMay);
  const winterMetrics = ranking.planSafetyMetrics(withWinter);
  for (const key of ["verifiedCount", "loadSquares", "imbalance", "annualOverFour", "fourCoursePatternPenalty", "maxEco"]) {
    assert.equal(mayMetrics[key], winterMetrics[key], key);
  }
  assert.equal(ranking.compareEconomicsPlans(withMay, withWinter), 0);
  assert.equal(ranking.compareEconomicsPlans(withWinter, withMay), 0);
});

test("a Summer course counts as one fewer verified course than a verified Fall section", () => {
  const ranking = isolatedRanking();
  const fall = plan([[course("ECO 113", "verified-offering")]], [1]);
  const summer = structuredClone(fall);
  summer.terms[0].termKey = "Summer";
  summer.terms[0].courses[0].source = "summer-last-resort";
  assert.equal(ranking.planSafetyMetrics(fall).verifiedCount, 1);
  assert.equal(ranking.planSafetyMetrics(summer).verifiedCount, 0);
  assert.equal(ranking.planSafetyMetrics(fall).verifiedCount - ranking.planSafetyMetrics(summer).verifiedCount, 1);
});

test("Summer placements are enrollment dependent and make a valid plan conditional", () => {
  const requirement = { id: "eco-113", label: "ECO 113" };
  const summer = buildCoursePlacement({
    requirement,
    code: "ECO 113",
    slot: { id: "summer-2028", termKey: "Summer" },
    offering: { course: "ECO 113", section: "S1", title: "Principles", verificationStatus: "verified", availability: { status: "open", asOf: "2026-11-24" }, meeting: { days: ["M"], startMinutes: 540, endMinutes: 590 } },
    source: "summer-last-resort"
  });
  const fall = buildCoursePlacement({
    requirement,
    code: "ECO 113",
    slot: { id: "fall-2028", termKey: "Fall" },
    offering: { course: "ECO 113", section: "F1", title: "Principles", verificationStatus: "verified", availability: { status: "open", asOf: "2026-11-24" }, meeting: { days: ["M"], startMinutes: 540, endMinutes: 590 } },
    source: "verified-offering"
  });
  const validPlan = course => ({
    validation: { valid: true, conditions: [] },
    terms: [{ term: course.source === "summer-last-resort" ? "Summer" : "Fall", courses: [course] }]
  });

  assert.equal(summer.offeringStatus, "enrollment_dependent");
  assert.equal(classifyFeasibility(validPlan(summer), { planCreationDate: "2026-11-24" }), FEASIBILITY_STATUS.CONDITIONAL);
  assert.equal(fall.offeringStatus, "verified");
  assert.equal(classifyFeasibility(validPlan(fall), { planCreationDate: "2026-11-24" }), FEASIBILITY_STATUS.VERIFIED);
});
