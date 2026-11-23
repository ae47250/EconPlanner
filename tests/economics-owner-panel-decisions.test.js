import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import { buildEconomicsTermPlans } from "../lib/planning/economics.js";

const requirements = JSON.parse(readFileSync(new URL("../data/normalized/economics/requirements.json", import.meta.url)));
const schedule = JSON.parse(readFileSync(new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url)));
const prerequisites = JSON.parse(readFileSync(new URL("../data/normalized/economics/prerequisites.json", import.meta.url)));

function plansFor(student) {
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  return buildEconomicsTermPlans({ student, mapping, schedule, prerequisites }).plans;
}

test("Explore uses verified ECO 321 when a valid plan can place it", () => {
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2026-11-22",
    courses: ["ECO 113", "ECO 114", "MAT 121"].map(code => ({ code, status: "completed", source: "ap_credit" }))
  };
  const explore = plansFor(student).find(plan => plan.id === "explore-first");
  assert.ok(explore?.validation.valid);
  const finance = explore.terms.flatMap(term => term.courses).find(course => course.requirementId === "finance");
  assert.equal(finance?.course, "ECO 321");
  assert.equal(finance?.source, "verified-offering");
});

test("Explore does not project ECO 257 in an unpublished future term", () => {
  const student = {
    academicStanding: "sophomore",
    planCreationDate: "2026-11-22",
    courses: ["ECO 113", "MAT 121"].map(code => ({ code, status: "completed", source: "ap_credit" }))
  };
  const explore = plansFor(student).find(plan => plan.id === "explore-first");
  assert.ok(explore?.validation.valid);
  assert.ok(explore.terms.flatMap(term => term.courses).every(course => course.course !== "ECO 257"));
});

test("Balanced avoids an unnecessary same-term ECO 461 approval", () => {
  const student = {
    academicStanding: "junior",
    planCreationDate: "2026-11-22",
    courses: ["ECO 113", "ECO 114", "MAT 121"].map(code => ({ code, status: "completed" }))
  };
  const balanced = plansFor(student).find(plan => plan.id === "balanced");
  assert.ok(balanced?.validation.valid);
  const capstoneTerm = balanced.terms.find(term => term.courses.some(course => course.course === "ECO 461"));
  assert.ok(capstoneTerm);
  assert.ok(capstoneTerm.courses.every(course => !["ECO 213", "ECO 214"].includes(course.course)));
  assert.ok(balanced.terms.every(term => term.courses.filter(course => course.course.startsWith("ECO ")).length <= 2));
});

test("Balanced moves a flexible elective to avoid three Economics courses in Winter", () => {
  const student = {
    academicStanding: "junior", planningPace: "one_year_early", planCreationDate: "2026-11-22",
    courses: ["ECO 113", "ECO 114", "MAT 121", "MAT 217"].map(code => ({ code, status: "completed" }))
  };
  const balanced = plansFor(student).find(plan => plan.id === "balanced");
  assert.ok(balanced?.validation.valid);
  assert.ok(balanced.terms.every(term => term.courses.filter(course => course.course.startsWith("ECO ")).length <= 2));
  const finance = balanced.terms.flatMap(term => term.courses).find(course => course.requirementId === "finance");
  assert.equal(finance?.course, "ECO 321");
  assert.equal(finance?.source, "verified-offering");
});
