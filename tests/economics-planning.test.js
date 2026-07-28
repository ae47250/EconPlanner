import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildEconomicsTermPlan } from "../lib/planning/economics.js";
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
