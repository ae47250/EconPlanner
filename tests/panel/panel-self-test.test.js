import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const panel = path.join(root, "tests/panel");
const runScript = path.join(root, "scripts/panel/run.mjs");
const lintScript = path.join(root, "scripts/panel/lint.mjs");

function invoke(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: { ...process.env, CI: "true" },
    encoding: "utf8",
    timeout: 30000
  });
  if (result.error) throw result.error;
  return result;
}

test("panel:check catches one changed course in a temporary plan copy", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "econplanner-panel-self-test-"));
  try {
    await cp(path.join(panel, "snapshots"), path.join(temporary, "snapshots"), { recursive: true });
    await cp(path.join(panel, "plans"), path.join(temporary, "plans"), { recursive: true });
    for (const file of ["trace.json", "trace.md"]) await cp(path.join(panel, file), path.join(temporary, file));
    const target = path.join(temporary, "plans/15.json");
    const plans = JSON.parse(await readFile(target, "utf8"));
    const course = plans.plans.flatMap(plan => plan.terms).flatMap(term => term.courses)[0];
    assert.ok(course, "student 15 must have a scheduled course to mutate");
    const original = course.course;
    course.course = original === "ECO 113" ? "ECO 114" : "ECO 113";
    await writeFile(target, JSON.stringify(plans, null, 2) + "\n");
    const result = invoke(runScript, ["--check", "--generated-dir", temporary]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /plans\/15\.json differs:/);
    assert.match(result.stderr, new RegExp(`-\\s+"course": "${original}"`));
    assert.match(result.stderr, new RegExp(`\\+\\s+"course": "${course.course}"`));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("panel:lint counts course codes and titles in a 30-word sentence", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "econplanner-panel-lint-self-test-"));
  try {
    const snapshotDir = path.join(temporary, "snapshots");
    await mkdir(snapshotDir);
    const sentence = "ECO 113 and ECO 114 Principles of Macroeconomics appear with MAT 121 in this long sentence so the panel counts course code and course title while reviewing a student's plan.";
    assert.equal(sentence.match(/[\p{L}\p{N}]+(?:[’'/-][\p{L}\p{N}]+)*/gu)?.length, 30);
    await writeFile(path.join(snapshotDir, "15.txt"), [
      "SCREEN", "SCREEN > Plan: Balanced", "STATUS: Ready to plan", sentence, "PDF", ""
    ].join("\n"));
    const result = invoke(lintScript, ["--snapshots-dir", snapshotDir]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /\[wordLimit\] SCREEN \/ Balanced:/);
    assert.match(result.stdout, /wordLimit=1/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
