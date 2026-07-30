import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("official catalog snapshot contains the full captured program inventory", async () => {
  const programs = JSON.parse(await readFile(new URL("data/normalized/catalogs/2025-2026/programs.json", root), "utf8"));
  assert.equal(programs.length, 37);
  assert.ok(programs.some(program => program.id === "economics"));
  assert.ok(programs.every(program => program.sourceStatus === "DRAFT_REVIEW_REQUIRED"));
});

test("catalog audit CSV has one header and one row per program", async () => {
  const csv = await readFile(new URL("data/review/hanover_catalog_2025-2026_audit.csv", root), "utf8");
  assert.ok(csv.trim().split(/\r?\n/).length >= 38);
});

test("normalized catalog preserves requirement text and explicit variants for review", async () => {
  const requirements = JSON.parse(await readFile(new URL("data/normalized/catalogs/2025-2026/requirements.json", root), "utf8"));
  const variants = JSON.parse(await readFile(new URL("data/normalized/catalogs/2025-2026/program-variants.json", root), "utf8"));
  const programs = JSON.parse(await readFile(new URL("data/normalized/catalogs/2025-2026/programs.json", root), "utf8"));
  const prerequisites = JSON.parse(await readFile(new URL("data/normalized/catalogs/2025-2026/prerequisites.json", root), "utf8"));
  const biology = requirements.find(item => item.programId === "biology");
  const genderStudies = requirements.find(item => item.programId === "genderstudies");
  const conflicts = await readFile(new URL("data/review/source_conflicts.csv", root), "utf8");
  assert.ok(biology.requirementSections.some(section => /Bachelor of Arts/i.test(section.text)));
  assert.ok(biology.cognateSections.length > 0);
  assert.ok(variants.some(item => item.programId === "biology" && item.degree === "BS"));
  assert.ok(variants.some(item => item.programId === "biology" && item.degree === "BA"));
  assert.ok(variants.some(item => item.programId === "computerscience" && item.degree === "BS"));
  assert.ok(variants.some(item => item.programId === "computerscience" && item.degree === "BA"));
  assert.ok(variants.some(item => item.programId === "genderstudies" && item.degree === "BA"));
  assert.ok(genderStudies.courseTables.some(table => table.rows.some(row => row.code === "GNDS 111")));
  assert.ok(requirements.every(item => item.reviewStatus));
  assert.ok(programs.every(program => typeof program.catalogBlockFound === "boolean" && program.variants.includes(`${program.id}-base`)));
  assert.equal(Object.keys(prerequisites).length, programs.length);
  assert.ok(Object.values(prerequisites).every(item => item.reviewStatus));
  assert.match(conflicts, /Physics and Astronomy/);
});

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
  const capstone = canonical.courses.find(course => course.code === "ECO 461");

  assert.equal(new Set(codes).size, codes.length);
  assert.equal(aliases.some(alias => codes.includes(alias)), false);
  assert.ok(canonical.courses.every(course => Number(course.units) > 0));
  assert.deepEqual(rationalChoices.aliases, ["PHI 234"]);
  assert.equal(capstone.residency, "hanover");
  assert.equal(capstone.studentSelectable, false);
  assert.deepEqual(finance.preferredOptions, ["BUSN 323", "ECO 321"]);
  assert.deepEqual(elective.conditionalCourses["ECO 321"], {
    slotId: "finance",
    assignedCode: "BUSN 323"
  });
  assert.equal(calendars.source, "https://www.hanover.edu/academics/calendar/");
  assert.ok(manifest.entries.some(entry => entry.role === "academic_calendar" && entry.approvalStatus === "OFFICIAL_HANOVER_SOURCE"));
  assert.ok(manifest.entries.some(entry => entry.role === "economics_canonical_courses"));
});
