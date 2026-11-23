import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCompatibilityRepresentations } from "../lib/policy/compatibility-projection.js";
import { canonicalJson } from "../lib/policy/canonical-json.js";
import { compilePolicy } from "../scripts/compile-policy.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compatibilityNames = ["courses.json", "requirements.json", "prerequisites.json", "planning-constraints.json", "schedule-2026-2027.json"];

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function canonicalInputs(root = repositoryRoot) {
  const manifest = await readJson(path.join(root, "policy/manifest/econ-2025-2026.1.json"));
  const inputs = await Promise.all(manifest.inputs.map(async declaration => [declaration.id, await readJson(path.join(root, declaration.path))]));
  const inputById = Object.fromEntries(inputs);
  return {
    courses: inputById.courses,
    requirements: inputById.requirements,
    rules: inputs.flatMap(([, document]) => document.records ?? []).filter(rule => rule.status === "ACTIVE").sort((left, right) => left.ruleId.localeCompare(right.ruleId)),
    schedule: inputById["schedule-2026-2027"],
    offeringPatterns: inputById["offering-patterns"],
    provenance: inputById.provenance,
    profile: inputById["compatibility-profile"]
  };
}

test("all five compatibility documents are derived from canonical manifest inputs without field loss", async () => {
  const generated = buildCompatibilityRepresentations(await canonicalInputs());
  for (const name of compatibilityNames) {
    const current = await readJson(path.join(repositoryRoot, "data/normalized/economics", name));
    assert.equal(canonicalJson(generated[name]), canonicalJson(current), name);
    const compiled = await readJson(path.join(repositoryRoot, "data/compiled/policy/releases/econ-2025-2026.1/compatibility", name));
    assert.equal(canonicalJson(generated[name]), canonicalJson(compiled), `compiled ${name}`);
  }
});

test("a canonical prerequisite change flows into both prerequisite compatibility surfaces", async () => {
  const inputs = await canonicalInputs();
  const rule = inputs.rules.find(candidate => candidate.ruleId === "PREREQ-ECO-221");
  rule.effect.allOf = ["ECO 114"];
  const generated = buildCompatibilityRepresentations(inputs);
  assert.deepEqual(generated["prerequisites.json"]["ECO 221"].all, ["ECO 114"]);
  assert.deepEqual(generated["courses.json"].courses.find(course => course.code === "ECO 221").prerequisites.all, ["ECO 114"]);
});

test("canonical schedule fields flow into every compatibility field, including metadata", async () => {
  const inputs = await canonicalInputs();
  const section = inputs.schedule.terms[0].sections[0];
  section.meeting.startTime = "08:15";
  section.enrollmentState = "FULL";
  section.sourceRefs = ["SCHEDULE-2026-2027-MATH-FALL#MAT-113-A"];
  section.availabilityAsOf = "2026-08-09";
  section.seatsOpen = 0;
  section.capacity = 25;
  inputs.provenance.sources.find(source => source.sourceId === "SCHEDULE-2026-2027-MATH-FALL").receivedOn = "2026-08-09";

  const projected = buildCompatibilityRepresentations(inputs)["schedule-2026-2027.json"].terms.Fall[0];
  assert.equal(projected.meeting.startTime, "8:15 AM");
  assert.deepEqual(projected.availability, { status: "full", rawStatus: "Full", seatsOpen: 0, capacity: 25, asOf: "2026-08-09" });
  assert.deepEqual(projected.provenance.sourceFiles, ["data/raw/economics/schedule-2026-2027-math-fall.png"]);
  assert.equal(projected.provenance.screenshotRetrievedOn, "2026-08-09");
});

test("stale normalized files cannot override canonical compatibility generation", async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "econ-stale-normalized-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await Promise.all([
    cp(path.join(repositoryRoot, "policy"), path.join(temporaryRoot, "policy"), { recursive: true }),
    cp(path.join(repositoryRoot, "data/raw"), path.join(temporaryRoot, "data/raw"), { recursive: true })
  ]);
  const normalizedRoot = path.join(temporaryRoot, "data/normalized/economics");
  await mkdir(normalizedRoot, { recursive: true });
  await writeFile(path.join(normalizedRoot, "courses.json"), JSON.stringify({ courses: [{ code: "STALE 999", title: "Must not win" }] }));

  const result = await compilePolicy({ repositoryRoot: temporaryRoot });
  const generated = await readJson(path.join(result.normalizedRoot, "courses.json"));
  assert.equal(generated.courses.some(course => course.code === "STALE 999"), false);
  assert.equal(generated.courses.find(course => course.code === "ECO 113").title, "Principles of Microeconomics");
});

test("canonical comparisons detect changed, added, deleted rows and coverage drift even when mirrors agree", async () => {
  const expected = buildCompatibilityRepresentations(await canonicalInputs())["schedule-2026-2027.json"];
  for (const mutate of [
    value => { value.terms.Winter[0].instructor = "Drift"; },
    value => { value.terms.Winter.push(structuredClone(value.terms.Winter[0])); },
    value => { value.terms.Winter.pop(); },
    value => { value.coverageByTerm.Winter.coverageScopes = []; }
  ]) {
    const normalized = structuredClone(expected);
    mutate(normalized);
    const compiled = structuredClone(normalized);
    assert.equal(canonicalJson(normalized), canonicalJson(compiled));
    for (const mirror of [normalized, compiled]) assert.throws(() => assert.equal(canonicalJson(mirror), canonicalJson(expected)));
  }
  const schedule = (await canonicalInputs()).schedule;
  const bundle = await readJson(path.join(repositoryRoot, "data/compiled/policy/releases/econ-2025-2026.1/bundle.json"));
  for (const term of schedule.terms) {
    assert.deepEqual(bundle.indexes.offeringByTerm[term.termId].sections, [...term.sections].sort((a,b) => a.sectionId.localeCompare(b.sectionId)));
    assert.deepEqual(bundle.indexes.offeringByTerm[term.termId].coverageScopes, term.coverageScopes);
  }
});
