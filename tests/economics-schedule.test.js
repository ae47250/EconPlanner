import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildScheduleCourseSets, renderScheduleKnowledge } from "../lib/schedule/annual.js";
import { evaluateOffering } from "../lib/decision-engine/index.js";
import { runtimePolicyBundle } from "../lib/policy/compat-normalized.js";

const schedule = JSON.parse(await readFile(new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url), "utf8"));
const historicalSchedule = JSON.parse(await readFile(new URL("./fixtures/schedules/schedule-2025-2026.json", import.meta.url), "utf8"));
const humanSchedule = await readFile(new URL("../knowledge/course-schedule-2026-2027.md", import.meta.url), "utf8");

const bundle = runtimePolicyBundle();
const offering = (termKey, course) => evaluateOffering(
  { course, source: "verified-offering" },
  { academicYear: "2026-2027", termKey },
  bundle.indexes.offeringByTerm,
  bundle,
  { traceId: "schedule-test" }
);

test("2026/2027 schedule preserves the August 8, 2026 verified Fall, Winter, and May offerings", () => {
  assert.ok(schedule.terms.Fall.some(course => course.course === "ECO 234"));
  assert.ok(schedule.terms.Fall.some(course => course.course === "MAT 121" && course.section === "B" && course.availability.rawStatus === "Open"));
  assert.ok(schedule.terms.Fall.some(course => course.course === "BUSN 323" && course.section === "A" && course.availability.rawStatus === "Full"));
  assert.ok(schedule.terms.Winter.some(course => course.course === "ECO 214"));
  assert.ok(schedule.terms.Winter.some(course => course.course === "MAT 217" && course.section === "M" && course.availability.rawStatus === "Open"));
  assert.ok(schedule.terms.May.some(course => course.course === "ECO 222" && course.section === "S"));
  assert.ok(schedule.terms.May.some(course => course.course === "ECO 260" && course.section === "S"));
  assert.ok(schedule.terms.May.some(course => course.course === "MAT 217" && course.section === "S" && course.availability.rawStatus === "Open"));
  assert.equal(schedule.terms.Summer.some(course => course.verificationStatus === "verified"), false);
  assert.equal(schedule.source.sectionCodeSMeans, "May");
  assert.equal(schedule.source.humanVerifiedOn, "2026-08-08");
  assert.equal(schedule.availabilityAsOf, "2026-08-08");
});

test("ECO 213 and ECO 214 are separated and neither is a May offering", () => {
  const terms = Object.entries(schedule.terms);
  assert.ok(!terms.some(([, courses]) => courses.some(course => course.course === "ECO 213") && courses.some(course => course.course === "ECO 214")));
  assert.ok(!schedule.terms.May.some(course => ["ECO 213", "ECO 214"].includes(course.course)));
});

test("Decision Engine schedule sets exactly match the canonical 2026/2027 schedule", () => {
  const canonical = buildScheduleCourseSets(schedule, ["Fall", "Winter", "May"]);
  for (const term of ["Fall", "Winter", "May"]) {
    const year = term === "Fall" ? "2026" : "2027";
    const courses = new Set(bundle.indexes.offeringByTerm[`${year}-${term.toUpperCase()}`].sections.map(section => section.course));
    assert.deepEqual([...courses].sort(), [...canonical[term]].sort(), term);
  }
});

test("ECO 234 and PHI 234 are equivalent in Fall 2026", () => {
  for (const code of ["ECO 234", "PHI 234"]) {
    const result = offering("Fall", code);
    assert.equal(result.status, "ALLOW", code);
    assert.equal(result.offeringEvidence.sectionId, offering("Fall", "ECO 234").offeringEvidence.sectionId);
  }
});

test("ECO 234 and PHI 234 are rejected from incorrect 2026/2027 terms", () => {
  for (const term of ["Winter", "May"]) {
    for (const code of ["ECO 234", "PHI 234"]) {
      const result = offering(term, code);
      assert.equal(result.status, "BLOCK", `${term}: ${code}`);
      assert.equal(result.reasonCode, "NOT_OFFERED_IN_COMPLETE_SCHEDULE");
    }
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
