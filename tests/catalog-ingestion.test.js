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
