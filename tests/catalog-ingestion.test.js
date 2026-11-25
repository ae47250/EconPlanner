import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("canonical Economics data has unique courses, aliases, units, and source metadata", async () => {
  const canonical = JSON.parse(await readFile(new URL("data/normalized/economics/courses.json", root), "utf8"));
  const requirements = JSON.parse(await readFile(new URL("data/normalized/economics/requirements.json", root), "utf8"));
  const calendars = JSON.parse(await readFile(new URL("data/normalized/academic-calendars.json", root), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("data/manifests/source-manifest.json", root), "utf8"));
  const codes = canonical.courses.map(course => course.code);
  const aliases = canonical.courses.flatMap(course => course.aliases || []);
  const finance = requirements.requirementSlots.find(slot => slot.id === "finance");
  const elective = requirements.requirementSlots.find(slot => slot.id === "eco-elective-1");
  const rationalChoices = canonical.courses.find(course => course.code === "ECO 234");
  const intermediateMicro = canonical.courses.find(course => course.code === "ECO 213");
  const capstone = canonical.courses.find(course => course.code === "ECO 461");

  assert.equal(new Set(codes).size, codes.length);
  assert.equal(aliases.some(alias => codes.includes(alias)), false);
  assert.ok(canonical.courses.every(course => Number(course.units) > 0));
  assert.deepEqual(rationalChoices.aliases, ["PHI 234"]);
  assert.deepEqual(intermediateMicro.prerequisites.concurrentWithApproval[0], {
    options: ["MAT 113", "MAT 121"],
    approval: "instructor",
    policySource: "department-approved",
    lastResortOnly: true
  });
  assert.equal(capstone.residency, "hanover");
  assert.equal(capstone.studentSelectable, false);
  assert.deepEqual(finance.preferredOptions, ["ECO 321", "BUSN 323"]);
  assert.equal(elective.conditionalCourses["ECO 321"], undefined);
  assert.ok(elective.excludedCourses.includes("ECO 321"));
  assert.ok(elective.excludedCourses.includes("BUSN 323"));
  assert.equal(calendars.source, "https://www.hanover.edu/academics/calendar/");
  assert.ok(manifest.entries.some(entry => entry.role === "academic_calendar" && entry.approvalStatus === "OFFICIAL_HANOVER_SOURCE"));
  assert.ok(manifest.entries.some(entry => entry.role === "economics_canonical_courses"));
});
