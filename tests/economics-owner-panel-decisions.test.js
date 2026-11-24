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

test("Explore keeps a lighter first year when verified ECO 321 would erase it", () => {
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2026-11-22",
    courses: ["ECO 113", "ECO 114", "ECO 213", "MAT 121"].map(code => ({ code, status: "completed", source: "ap_credit" }))
  };
  const plans = plansFor(student);
  const explore = plans.find(plan => plan.id === "explore-first");
  const balanced = plans.find(plan => plan.id === "balanced");
  assert.ok(explore?.validation.valid);
  assert.equal(balanced.terms.flatMap(term => term.courses).find(course => course.requirementId === "finance")?.course,
    "ECO 321");
  const finance = explore.terms.flatMap(term => term.courses).find(course => course.requirementId === "finance");
  assert.equal(finance?.course, "BUSN 323");
  assert.ok(explore.terms.find(term => term.courses.includes(finance)).yearIndex > 0);
  assert.ok(explore.terms.filter(term => term.yearIndex === 0).flatMap(term => term.courses).length
    < balanced.terms.filter(term => term.yearIndex === 0).flatMap(term => term.courses).length);
});

test("Explore keeps its lighter yearly target ahead of verified ECO 321", () => {
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2026-11-22",
    courses: ["ECO 113", "ECO 114", "MAT 121"].map(code => ({ code, status: "completed", source: "ap_credit" }))
  };
  const plans = plansFor(student);
  const explore = plans.find(plan => plan.id === "explore-first");
  const balanced = plans.find(plan => plan.id === "balanced");
  assert.ok(explore?.validation.valid);
  const finance = explore.terms.flatMap(term => term.courses).find(course => course.requirementId === "finance");
  assert.equal(finance?.course, "BUSN 323");
  assert.equal(finance?.source, "projected-offering");
  assert.ok(explore.terms.filter(term => term.yearIndex === 0).flatMap(term => term.courses).length
    < balanced.terms.filter(term => term.yearIndex === 0).flatMap(term => term.courses).length);
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

for (const [studentId, standing, courses, pace] of [
  ["11", "junior", ["ECO 113", "MAT 217"], "one_year_early"],
  ["13", "junior", ["ECO 114", "MAT 121"], "standard"]
]) {
  test(`panel student ${studentId} uses at most two Economics courses per term`, () => {
    const balanced = plansFor({
      academicStanding: standing, planningPace: pace, planCreationDate: "2026-11-22",
      courses: courses.map(code => ({ code, status: "completed", source: "manual_code" }))
    }).find(plan => plan.id === "balanced");
    assert.ok(balanced?.validation.valid);
    assert.ok(balanced.terms.every(term => term.courses.filter(course => course.course.startsWith("ECO ")).length <= 2));
  });
}

test("panel student 47 Explore prefers MAT 217 over projected ECO 257", () => {
  const explore = plansFor({
    academicStanding: "sophomore", planCreationDate: "2026-11-22",
    courses: ["ECO 113", "MAT 121", "ECO 114"].map(code => ({
      code, status: ["ECO 113", "MAT 121"].includes(code) ? "transfer" : "completed",
      source: ["ECO 113", "MAT 121"].includes(code) ? "transfer_credit" : "manual_code"
    }))
  }).find(plan => plan.id === "explore-first");
  assert.ok(explore?.validation.valid);
  const statistics = explore.terms.flatMap(term => term.courses).find(course => course.requirementId === "statistics");
  assert.equal(statistics?.course, "MAT 217");
});
