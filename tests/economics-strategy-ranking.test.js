import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import {
  EARLY_GRADUATION_VARIANT,
  PLAN_VARIANTS,
  buildEconomicsTermPlans,
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

test("the planner exposes only Balanced and Explore First as normal strategy variants", () => {
  assert.deepEqual(PLAN_VARIANTS.map(item => item.id), ["balanced", "explore-first"]);
  assert.equal(EARLY_GRADUATION_VARIANT.id, "one-year-early");

  const freshman = generate(standardStudent("freshman"));
  assert.deepEqual(freshman.candidateOutcomes.map(item => item.id), ["balanced", "explore-first"]);
  assert.deepEqual(freshman.plans.map(item => item.id), ["balanced", "explore-first"]);

  const junior = generate(standardStudent("junior", ["ECO 113", "ECO 114", "MAT 113"]));
  assert.deepEqual(junior.candidateOutcomes.map(item => item.id), ["balanced"]);
  assert.ok(junior.plans.every(item => item.id === "balanced"));
});

test("Explore First keeps a feasible discovery sequence without duplicating requirements", () => {
  const result = generate(standardStudent("freshman"));
  const explore = result.plans.find(item => item.id === "explore-first");
  assert.ok(explore);

  const firstYear = explore.terms.filter(term => term.yearIndex === 0);
  const introductions = firstYear.flatMap(term => term.courses)
    .filter(course => ["ECO 113", "ECO 114"].includes(course.course));
  assert.equal(introductions.length, 1);

  const secondYearFallWinter = explore.terms
    .filter(term => term.yearIndex === 1 && ["Fall", "Winter"].includes(term.termKey));
  const intermediates = secondYearFallWinter.flatMap(term => term.courses)
    .filter(course => ["ECO 213", "ECO 214"].includes(course.course));
  assert.equal(intermediates.length, 1);

  const assignedRequirements = explore.terms.flatMap(term => term.courses)
    .map(course => course.requirementId)
    .filter(Boolean);
  assert.equal(new Set(assignedRequirements).size, assignedRequirements.length);
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
