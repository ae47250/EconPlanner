import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import {
  EARLY_GRADUATION_VARIANT,
  PLAN_VARIANTS,
  buildEconomicsTermPlans,
  explorePreferredYearTargets,
  materialPlanDistance,
  planDifferentiationMetrics
} from "../lib/planning/economics.js";

const schedule = JSON.parse(await readFile(
  new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url),
  "utf8"
));
const prerequisites = JSON.parse(await readFile(
  new URL("../data/normalized/economics/prerequisites.json", import.meta.url),
  "utf8"
));
const requirements = JSON.parse(await readFile(
  new URL("../data/normalized/economics/requirements.json", import.meta.url),
  "utf8"
));

function generate(student) {
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  return buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });
}

function standardStudent(academicStanding, courses = []) {
  return {
    academicStanding,
    planCreationDate: "2026-07-30",
    courses: courses.map(code => ({ code, status: "completed" }))
  };
}

test("Balanced honors its yearly target for a sophomore with ECO 113 completed", () => {
  const student = {
    ...standardStudent("sophomore", ["ECO 113"]),
    planCreationDate: "2026-08-15"
  };
  const balanced = generate(student).plans.find(plan => plan.id === "balanced");
  assert.ok(balanced);
  assert.deepEqual(balanced.distribution.targetYearCounts, [3, 4, 4]);
  const actual = balanced.distribution.targetYearCounts.map((_, yearIndex) => (
    balanced.terms.filter(term => term.yearIndex === yearIndex)
      .flatMap(term => term.courses)
      .filter(course => course.requirementId).length
  ));
  assert.deepEqual(actual, [3, 4, 4]);
});

test("the planner exposes policy-backed Balanced and Explore the Major normal variants", () => {
  assert.deepEqual(PLAN_VARIANTS.map(item => item.id), ["balanced", "explore-first"]);
  assert.deepEqual(PLAN_VARIANTS.map(item => item.label), ["Balanced", "Explore the Major"]);
  assert.equal(EARLY_GRADUATION_VARIANT.id, "one-year-early");

  const freshman = generate(standardStudent("freshman"));
  assert.deepEqual(freshman.candidateOutcomes.map(item => item.id), ["balanced", "explore-first"]);
  assert.deepEqual(freshman.plans.map(item => item.id), ["balanced", "explore-first"]);

  const junior = generate(standardStudent("junior", ["ECO 113", "ECO 114", "MAT 113"]));
  assert.deepEqual(junior.candidateOutcomes.map(item => item.id), ["balanced"]);
  assert.ok(junior.plans.every(item => item.id === "balanced"));
});

test("Explore the Major is lighter than and materially distinct from its Balanced baseline", () => {
  const result = generate(standardStudent("freshman"));
  const balanced = result.plans.find(item => item.id === "balanced");
  const explore = result.plans.find(item => item.id === "explore-first");
  assert.ok(balanced);
  assert.ok(explore);

  const yearZeroLoad = plan => plan.terms.filter(term => term.yearIndex === 0)
    .flatMap(term => term.courses)
    .filter(course => course.requirementId).length;
  assert.ok(yearZeroLoad(explore) < yearZeroLoad(balanced));
  assert.equal(explore.planningContext.expectedGraduationTerm, balanced.planningContext.expectedGraduationTerm);
  assert.equal(materialPlanDistance(balanced, explore).materiallyDifferent, true);

  const assignedRequirements = explore.terms.flatMap(term => term.courses)
    .map(course => course.requirementId)
    .filter(Boolean);
  assert.equal(new Set(assignedRequirements).size, assignedRequirements.length);
});

test("Explore the Major preferred target backloads remainders without excluding stronger safe shapes", () => {
  assert.deepEqual(explorePreferredYearTargets(10, 4, 3), [2, 2, 3, 3]);
  assert.deepEqual(explorePreferredYearTargets(10, 4, 4), [2, 2, 3, 3]);
  assert.ok(PLAN_VARIANTS.find(item => item.id === "explore-first").rankingPreferences.strongerSafeBackloadingRemainsEligible);
});

test("Explore the Major is truthfully suppressed when Balanced has zero first-year tracked load", () => {
  const student = standardStudent("freshman", [
    "ECO 113", "ECO 114", "ECO 213", "ECO 214", "MAT 217", "ECO 321", "MAT 113",
    "ECO 221", "ECO 222", "ECO 260", "ECO 311"
  ]);
  const result = generate(student);
  const balanced = result.plans.find(plan => plan.id === "balanced");
  const explore = result.candidateOutcomes.find(outcome => outcome.id === "explore-first");
  assert.ok(balanced);
  assert.equal(balanced.terms.filter(term => term.yearIndex === 0).flatMap(term => term.courses).length, 0);
  assert.equal(explore.displayed, false);
  assert.equal(explore.suppressionReason.code, "EXPLORE_NO_LIGHTER_FIRST_YEAR");
});

test("One Year Early is a separate shortened comparison with deterministic material metrics", () => {
  const student = {
    ...standardStudent("sophomore", ["ECO 113", "ECO 114", "MAT 113"]),
    planningPace: "one_year_early"
  };
  const result = generate(student);
  const balanced = result.plans.find(item => item.id === "balanced");
  const early = result.plans.find(item => item.id === "one-year-early");
  assert.ok(balanced);
  assert.ok(early);
  assert.equal(balanced.planningContext.remainingYears, 3);
  assert.equal(early.planningContext.remainingYears, 2);
  assert.equal(early.planningContext.expectedGraduationTerm, "Spring/May 2028");

  assert.deepEqual(planDifferentiationMetrics(balanced, student), balanced.differentiationMetrics);
  assert.equal(materialPlanDistance(balanced, balanced).materiallyDifferent, false);
  assert.equal(materialPlanDistance(balanced, early).materiallyDifferent, true);
});
