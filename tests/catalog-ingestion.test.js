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
  assert.equal(csv.trim().split(/\r?\n/).length, 38);
});
