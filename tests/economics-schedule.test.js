import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const schedule = JSON.parse(await readFile(new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url), "utf8"));

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
