import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildEconomicsTermPlan, buildEconomicsTermPlans } from "../lib/planning/economics.js";
import { mapStudentToProgram } from "../lib/assignment/solve.js";

const schedule = JSON.parse(await readFile(new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url), "utf8"));
const prerequisites = JSON.parse(await readFile(new URL("../data/normalized/economics/prerequisites.json", import.meta.url), "utf8"));
const requirements = JSON.parse(await readFile(new URL("../data/normalized/economics/requirements.json", import.meta.url), "utf8"));

test("Economics term planner keeps prerequisite courses in earlier terms", () => {
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, {
    academicStanding: "senior",
    courses: [
      { code: "ECO 113", status: "completed" },
      { code: "ECO 114", status: "completed" },
      { code: "MAT 113", status: "completed" }
    ]
  });
  const plan = buildEconomicsTermPlan({
    student: { academicStanding: "senior", courses: [{ code: "ECO 113", status: "completed" }, { code: "ECO 114", status: "completed" }, { code: "MAT 113", status: "completed" }] },
    mapping,
    schedule,
    prerequisites
  });
  const fall = plan.terms.find(term => term.term === "Fall").courses.map(course => course.course);
  const winter = plan.terms.find(term => term.term === "Winter").courses.map(course => course.course);

  assert.ok(fall.includes("ECO 213"));
  assert.ok(winter.includes("ECO 214"));
  assert.ok(!fall.includes("ECO 214"));
  assert.ok(!fall.includes("ECO 461") && !winter.includes("ECO 461"));
  assert.ok(plan.unscheduled.some(item => item.course === "ECO elective"));
});

test("dated Economics planning returns three differently weighted plans", () => {
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2026-09-01",
    courses: []
  };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const result = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });

  assert.equal(result.plans.length, 3);
  assert.deepEqual(result.plans.map(plan => plan.label), ["Plan 1", "Plan 2", "Plan 3"]);
  assert.equal(result.context.expectedGraduationTerm, "Spring/May 2030");
  assert.ok(result.plans.every(plan => plan.terms.some(term => term.term === "Spring/May 2030")));
  assert.equal(result.plans[0].terms[0].displayTerm, "Fall");
  assert.equal(result.plans[0].terms[0].academicYear, "2026/2027");
  assert.ok(result.plans.every(plan => plan.terms.every(term => !term.isSummer)));
  assert.ok(result.plans.every(plan => plan.terms.every(term => term.courses.length <= (term.term.startsWith("Spring/May") ? 1 : 4))));

  const electiveCountInYear = (plan, year) => plan.terms
    .filter(term => term.term.endsWith(String(year)))
    .reduce((count, term) => count + term.courses.filter(course => course.course === "ECO elective").length, 0);
  const plan2 = result.plans.find(plan => plan.id === "plan-2");
  const plan3 = result.plans.find(plan => plan.id === "plan-3");

  assert.ok(electiveCountInYear(plan2, 2028) >= electiveCountInYear(plan2, 2029));
  assert.ok(electiveCountInYear(plan3, 2029) > electiveCountInYear(plan3, 2028));
});

test("ECO 113 uses the verified online Summer offering only as a last resort", () => {
  const student = {
    academicStanding: "freshman",
    planCreationDate: "2026-09-01",
    courses: []
  };
  const noRegularECO113Schedule = structuredClone(schedule);
  noRegularECO113Schedule.terms.Fall = noRegularECO113Schedule.terms.Fall.filter(course => course.course !== "ECO 113");
  noRegularECO113Schedule.terms.Winter = noRegularECO113Schedule.terms.Winter.filter(course => course.course !== "ECO 113");
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const result = buildEconomicsTermPlans({
    student,
    mapping,
    schedule: noRegularECO113Schedule,
    prerequisites
  });
  const summerTerm = result.plans[0].terms.find(term => term.isSummer);

  assert.equal(summerTerm.term, "Summer 2027");
  assert.equal(summerTerm.courses[0].course, "ECO 113");
  assert.equal(summerTerm.courses[0].source, "summer-last-resort");
  assert.deepEqual(result.plans[0].summerFallbacks, [{
    course: "ECO 113",
    term: "Summer 2027",
    reason: "Regular-term placement was not sufficient under the current prerequisites, schedule, and planning horizon."
  }]);
});

test("ECO 307 does not satisfy one of the four full-unit elective slots", () => {
  const mapping = mapStudentToProgram(
    { id: "economics", name: "Economics" },
    requirements,
    { courses: [{ code: "ECO 307", status: "completed", units: 0.5 }] }
  );

  assert.equal(mapping.strict.assignments.some(item => item.code === "ECO 307"), false);
  assert.equal(mapping.strict.remainingUnits, 12);
});

test("ECO 461 remains required and Hanover-only in the normalized requirements", () => {
  const capstone = requirements.requirementSlots.find(slot => slot.id === "eco-461");

  assert.equal(capstone.options[0], "ECO 461");
  assert.equal(capstone.residency, "hanover");
});

test("a legacy non-Hanover ECO 461 record does not suppress the required senior-Winter placement", () => {
  const student = {
    academicStanding: "senior",
    courses: [
      { code: "ECO 213", status: "completed" },
      { code: "ECO 214", status: "completed" },
      { code: "ECO 257", status: "completed" },
      { code: "ECO 461", status: "transfer", source: "transfer" }
    ]
  };
  const mapping = mapStudentToProgram({ id: "economics", name: "Economics" }, requirements, student);
  const plan = buildEconomicsTermPlan({ student, mapping, schedule, prerequisites });
  const winter = plan.terms.find(term => term.term === "Winter");

  assert.ok(winter.courses.some(course => course.course === "ECO 461"));
});
