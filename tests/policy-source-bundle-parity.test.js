import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson } from "../lib/policy/canonical-json.js";
import { loadEconomicsPolicyCompatibility } from "../lib/policy/compat-normalized.js";

const root = new URL("../", import.meta.url);
const readJson = async relativePath => JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
const manifest = await readJson("policy/manifest/econ-2025-2026.1.json");
const bundle = await readJson("data/compiled/policy/releases/econ-2025-2026.1/bundle.json");

test("the committed bundle is a field-preserving projection of manifest-declared canonical sources", async () => {
  const declaredDocuments = await Promise.all(manifest.inputs.map(input => readJson(input.path)));
  const sourceRules = declaredDocuments.flatMap(document => document.records ?? []).filter(rule => rule.status === "ACTIVE");
  assert.deepEqual(bundle.rules, sourceRules.toSorted((left, right) => left.ruleId.localeCompare(right.ruleId)));

  const messages = await readJson("policy/messages/en-US.json");
  const provenance = await readJson("policy/provenance/sources.json");
  const unresolved = await readJson("policy/unresolved/policy-questions.json");
  assert.equal(canonicalJson(bundle.messages), canonicalJson(messages.messages));
  assert.equal(canonicalJson(bundle.provenance.sources), canonicalJson(provenance.sources));
  assert.equal(canonicalJson(bundle.unresolved), canonicalJson(unresolved.questions));
});

test("the bundle digest covers canonical payload bytes and active.json pins the exact release", async () => {
  const { contentHash, ...payload } = bundle;
  const digest = createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
  assert.equal(contentHash, `sha256:${digest}`);
  assert.equal((await readFile(new URL("data/compiled/policy/releases/econ-2025-2026.1/bundle.sha256", root), "utf8")).trim(), digest);

  const active = await readJson("data/compiled/policy/active.json");
  const pinned = active.programs.ECONOMICS["2025-2026"];
  assert.equal(pinned.bundleVersion, bundle.bundleVersion);
  assert.equal(pinned.contentHash, contentHash);
  assert.equal(pinned.activationStatus, "ACTIVE");
});

test("generated compatibility views are field-complete semantic matches for current runtime inputs", async () => {
  const names = ["courses.json", "requirements.json", "prerequisites.json", "planning-constraints.json", "schedule-2026-2027.json"];
  const loaded = loadEconomicsPolicyCompatibility({ useCache: false });
  const loaderKeys = ["courses", "requirements", "prerequisites", "planningConstraints", "schedule"];
  const reference = (await readJson("data/compiled/policy/active.json")).programs.ECONOMICS["2025-2026"];
  const report = await readJson("data/compiled/policy/releases/econ-2025-2026.1/compile-report.json");
  assert.deepEqual(reference.compatibilityHashes, Object.fromEntries(report.compatibility.map(entry => [entry.output, entry.canonicalHash])));
  for (const [index, name] of names.entries()) {
    const compiled = await readJson(`data/compiled/policy/releases/econ-2025-2026.1/compatibility/${name}`);
    const current = await readJson(`data/normalized/economics/${name}`);
    assert.equal(canonicalJson(compiled), canonicalJson(current), name);
    assert.equal(canonicalJson(loaded[loaderKeys[index]]), canonicalJson(current), `loader ${name}`);
  }
});

test("compatibility loading rejects changed files, absent files, and missing or changed pins", async t => {
  const compiledRoot = await mkdtemp(path.join(os.tmpdir(), "econ-compat-integrity-"));
  t.after(() => rm(compiledRoot, { recursive: true, force: true }));
  await cp(new URL("data/compiled/policy/active.json", root), path.join(compiledRoot, "active.json"));
  const release = "releases/econ-2025-2026.1";
  await cp(new URL(`data/compiled/policy/${release}`, root), path.join(compiledRoot, release), { recursive: true });
  const activePath = path.join(compiledRoot, "active.json");
  const active = JSON.parse(await readFile(activePath, "utf8"));
  const reference = active.programs.ECONOMICS["2025-2026"];
  const load = (useCache = false) => loadEconomicsPolicyCompatibility({ compiledRoot, useCache });
  assert.equal(Object.isFrozen(load().planningConstraints), true);
  for (const name of Object.keys(reference.compatibilityHashes)) {
    const file = path.join(compiledRoot, release, name);
    const original = await readFile(file, "utf8");
    await writeFile(file, JSON.stringify({ ...JSON.parse(original), unexpectedChange: true }));
    assert.throws(() => load(), /compatibility digest mismatch/);
    await rm(file);
    assert.throws(() => load(), { code: "ENOENT" });
    await writeFile(file, original);
  }
  load(true); // A changed pin must not reuse a previously cached release.
  const name = "compatibility/planning-constraints.json";
  reference.compatibilityHashes[name] = `sha256:${"0".repeat(64)}`;
  await writeFile(activePath, JSON.stringify(active));
  assert.throws(() => load(true), /compatibility digest mismatch/);
  delete reference.compatibilityHashes[name];
  await writeFile(activePath, JSON.stringify(active));
  assert.throws(() => load(), /No compatibility digest is pinned/);
});

test("canonical indexes preserve approved semantics that differ from legacy representations", () => {
  assert.deepEqual(bundle.indexes.byRuleId["ELECTIVE-ECO-257-STATISTICS-ONLY"].effect.allowedRequirementRuleIds, ["REQ-STATISTICS"]);
  assert.deepEqual(bundle.indexes.byRuleId["ELECTIVE-ECO-257-STATISTICS-ONLY"].effect.excludedRequirementRuleIds, ["REQ-ECO-ELECTIVES"]);
  assert.equal(bundle.indexes.byRuleId["TERM-CANONICAL-MAY"].effect.canonicalTerm, "MAY");
  assert.equal(bundle.indexes.byRuleId["SCHEDULE-AVAILABILITY-BEHAVIOR"].effect.FULL, "REVIEW_REQUIRED");
  assert.equal(bundle.indexes.offeringByTerm["2026-FALL"].sections.filter(section => section.enrollmentState === "FULL").length, 4);
});
