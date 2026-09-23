import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compilePolicy } from "../scripts/compile-policy.mjs";

test("the CP2 compiler validates and emits a complete release within its performance budget", async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "econ-policy-compiler-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const releaseRoot = path.join(temporaryRoot, "release");
  const started = performance.now();
  const { bundle, compileReport } = await compilePolicy({ outputRoot: releaseRoot });
  const elapsedMs = performance.now() - started;

  assert.ok(elapsedMs <= 5000, `compiler took ${elapsedMs.toFixed(2)}ms`);
  assert.equal(bundle.bundleVersion, "econ-2025-2026.1");
  assert.equal(compileReport.activationStatus, "ACTIVE");
  assert.match(bundle.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(compileReport.validation.criticalConflicts, []);
  assert.equal(compileReport.validation.schemas, "PASS");
  assert.equal(compileReport.counts.activeRules, 54);
  assert.equal(compileReport.counts.unresolvedReviewRecords, 5);
  assert.equal(compileReport.counts.historicalOfferingRecords, 0);
  assert.deepEqual(bundle.indexes.historicalOfferingByCourse, {});
  assert.deepEqual(bundle.indexes.preliminaryOfferingByTerm, {});
  assert.equal(bundle.provenance.historicalOfferingContract.activationStatus, "INACTIVE_NO_APPROVED_DATA");
  assert.equal(compileReport.compatibility.length, 5);
  assert.ok(compileReport.compatibility.every(entry => entry.status === "GENERATED"));

  for (const relativePath of [
    "bundle.json", "bundle.sha256", "compile-report.json", "policy-diff.md", "dependency-impact.md",
    "compatibility/courses.json", "compatibility/requirements.json", "compatibility/prerequisites.json",
    "compatibility/planning-constraints.json", "compatibility/schedule-2026-2027.json"
  ]) {
    assert.ok((await readFile(path.join(releaseRoot, relativePath))).length > 0, relativePath);
  }
  for (const relativePath of ["courses.json", "requirements.json", "prerequisites.json", "planning-constraints.json", "schedule-2026-2027.json"]) {
    assert.ok((await readFile(path.join(temporaryRoot, "normalized/economics", relativePath))).length > 0, relativePath);
  }
});

test("compatibility generation is byte-deterministic across three clean outputs", async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "econ-policy-determinism-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const outputNames = [
    "bundle.json", "compile-report.json", "compatibility/courses.json", "compatibility/requirements.json",
    "compatibility/prerequisites.json", "compatibility/planning-constraints.json", "compatibility/schedule-2026-2027.json"
  ];
  const roots = [];
  for (let index = 0; index < 3; index += 1) {
    const releaseRoot = path.join(temporaryRoot, `run-${index}`, "release");
    await compilePolicy({ outputRoot: releaseRoot });
    roots.push(releaseRoot);
  }
  for (const outputName of outputNames) {
    const expected = await readFile(path.join(roots[0], outputName), "utf8");
    for (const releaseRoot of roots.slice(1)) assert.equal(await readFile(path.join(releaseRoot, outputName), "utf8"), expected, outputName);
  }
  for (const outputName of ["courses.json", "requirements.json", "prerequisites.json", "planning-constraints.json", "schedule-2026-2027.json"]) {
    const expected = await readFile(path.join(path.dirname(roots[0]), "normalized/economics", outputName), "utf8");
    assert.equal(await readFile(path.join(roots[0], "compatibility", outputName), "utf8"), expected, `release/runtime ${outputName}`);
    for (const releaseRoot of roots.slice(1)) {
      assert.equal(await readFile(path.join(path.dirname(releaseRoot), "normalized/economics", outputName), "utf8"), expected, `runtime ${outputName}`);
    }
  }
});

test("the compiler records review outcomes instead of converting unknown policy into allow or block", async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "econ-policy-review-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const { bundle } = await compilePolicy({ outputRoot: path.join(temporaryRoot, "release") });

  assert.equal(bundle.indexes.byRuleId["SCHEDULE-AVAILABILITY-BEHAVIOR"].effect.FULL, "REVIEW_REQUIRED");
  assert.equal(bundle.indexes.byRuleId["PLANNING-UNPUBLISHED-OFFERINGS-PRELIMINARY"].effect.inventedExactTermPermitted, false);
  assert.equal(bundle.indexes.offeringPatternsById["PLANNING-INTERMEDIATE-OFFERING-SEPARATION"].projectionPolicy.universalSameTermProhibition, false);
  assert.equal(bundle.unresolved.length, 5);
});
