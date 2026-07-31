import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildScheduleCourseSets, renderScheduleKnowledge } from "../lib/schedule/annual.js";
import { courseRules, normalizeCourseCode, validateCoursePlan } from "../lib/validateCoursePlan.js";

const schedule = JSON.parse(await readFile(new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url), "utf8"));
const historicalSchedule = JSON.parse(await readFile(new URL("./fixtures/schedules/schedule-2025-2026.json", import.meta.url), "utf8"));
const humanSchedule = await readFile(new URL("../knowledge/course-schedule-2026-2027.md", import.meta.url), "utf8");

function planWithPlacement(term, course) {
  return {
    years: [{
      label: "Senior Year",
      academicYear: "2026/2027",
      terms: { Fall: [], Winter: [], May: [], [term]: [course] }
    }]
  };
}

test("2026/2027 schedule preserves Fall, Winter, May, and Summer offerings", () => {
  assert.ok(schedule.terms.Fall.some(course => course.course === "ECO 234"));
  assert.ok(schedule.terms.Winter.some(course => course.course === "ECO 214"));
  assert.ok(schedule.terms.May.some(course => course.course === "ECO 222" && course.section === "S"));
  assert.ok(schedule.terms.May.some(course => course.course === "ECO 260" && course.section === "S"));
  assert.ok(schedule.terms.Summer.some(course => course.course === "ECO 113" && course.delivery === "online"));
  assert.equal(schedule.source.sectionCodeSMeans, "May");
  assert.match(schedule.source.summerOfferingNote, /last-resort/);
});

test("ECO 213 and ECO 214 are separated and neither is a May offering", () => {
  const terms = Object.entries(schedule.terms);
  assert.ok(!terms.some(([, courses]) => courses.some(course => course.course === "ECO 213") && courses.some(course => course.course === "ECO 214")));
  assert.ok(!schedule.terms.May.some(course => ["ECO 213", "ECO 214"].includes(course.course)));
});

test("validator schedule sets exactly match the canonical 2026/2027 schedule", () => {
  const canonical = buildScheduleCourseSets(schedule, ["Fall", "Winter", "May"]);
  for (const term of ["Fall", "Winter", "May"]) {
    assert.deepEqual([...courseRules.SCHEDULE_2026_2027[term]].sort(), [...canonical[term]].sort(), term);
  }
});

test("ECO 234 and PHI 234 are equivalent in Fall 2026", () => {
  assert.equal(normalizeCourseCode("PHI 234"), "ECO 234");
  for (const code of ["ECO 234", "PHI 234"]) {
    const result = validateCoursePlan(planWithPlacement("Fall", code));
    assert.equal(result.errors.some(error => /not listed in the 2026\/2027 schedule/.test(error)), false, code);
  }
});

test("ECO 234 and PHI 234 are rejected from incorrect 2026/2027 terms", () => {
  for (const term of ["Winter", "May"]) {
    const result = validateCoursePlan(planWithPlacement(term, "PHI 234"));
    assert.equal(result.errors.some(error => new RegExp(`not listed in ${term} 2026/2027\\.`).test(error)), true, term);
  }
});

test("Spring/May 2026 ECO 234 remains a separate 2025/2026 occurrence", () => {
  assert.equal(historicalSchedule.academicYear, "2025-2026");
  assert.ok(historicalSchedule.terms.May.some(course => course.course === "ECO 234"));
  assert.equal(schedule.terms.Fall.some(course => course.course === "ECO 234"), true);
  assert.equal(schedule.terms.May.some(course => course.course === "ECO 234"), false);
});

test("model schedule text is rendered from the canonical schedule", () => {
  const knowledge = renderScheduleKnowledge(schedule);
  assert.match(knowledge, /Fall:/);
  assert.match(knowledge, /ECO 234 \| A \| Rational Choices/);
  assert.match(knowledge, /ECO 234 and PHI 234 are cross-listed/);
});

test("human-readable schedule includes every canonical course and term", () => {
  for (const [term, courses] of Object.entries(schedule.terms)) {
    for (const course of new Set(courses.map(row => row.course))) {
      assert.match(humanSchedule, new RegExp(`\\| 2026/2027 \\| ${term} \\| ${course.replace(" ", "\\s+")} \\|`), `${term} ${course}`);
    }
  }
});
