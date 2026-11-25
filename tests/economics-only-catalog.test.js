import test from "node:test";
import assert from "node:assert/strict";
import { loadCatalog } from "../lib/catalog/load.js";

test("the catalog loader holds only the Economics program", async () => {
  const catalog = await loadCatalog("2025-2026");
  assert.deepEqual(catalog.programs.map(program => program.id), ["economics"]);
  assert.deepEqual(catalog.variants.map(variant => variant.id), ["economics-base"]);
  assert.deepEqual([...catalog.requirementsByProgram.keys()], ["economics"]);
  assert.deepEqual([...catalog.prerequisitesByProgram.keys()], ["economics"]);
  assert.equal("courses" in catalog, false);
  assert.equal("globalRules" in catalog, false);
});
