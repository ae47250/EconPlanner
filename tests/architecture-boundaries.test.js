import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);

async function files(directory, suffix = ".js") {
  const entries = await readdir(new URL(directory, root), { withFileTypes: true });
  return entries.filter(entry => entry.isFile() && entry.name.endsWith(suffix)).map(entry => `${directory}${entry.name}`);
}

test("the Production Decision Engine imports no planner, production validator, or test Oracle", async () => {
  for (const file of await files("lib/decision-engine/")) {
    const source = await readFile(new URL(file, root), "utf8");
    assert.doesNotMatch(source, /planning\/economics|prerequisiteEvaluator|prerequisiteValidation|assignment\/solve|tests\/oracle/iu, file);
  }
});

test("the independent canonical-policy Oracle imports no production engine, planner, or validators", async () => {
  const source = await readFile(new URL("tests/oracle/load-canonical-policy.js", root), "utf8");
  assert.doesNotMatch(source, /lib\/decision-engine|lib\/planning|lib\/assignment|validateGeneratedPlan|loadPolicyBundle/iu);
});

test("the UI does not directly import authoritative server policy evaluators", async () => {
  const source = await readFile(new URL("app/page.js", root), "utf8");
  for (const [, importedPath] of source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)) {
    assert.doesNotMatch(importedPath, /lib\/decision-engine|lib\/policy|data\/compiled\/policy|planning\/economics|prerequisiteEvaluator|prerequisiteValidation|assignment\/solve/iu);
  }
});

test("the active mapper passes the compiled bundle into authoritative validation", async () => {
  const source = await readFile(new URL("app/api/majors/map/route.js", root), "utf8");
  assert.match(source, /policyBundle:\s*catalog\.policyBundle/iu);
  assert.doesNotMatch(source, /runDecisionEngineShadow|runShadowSafely/iu);
});
