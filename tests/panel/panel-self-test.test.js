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
    for (const file of ["trace.json", "trace.md", "unique-lines.txt"]) await cp(path.join(panel, file), path.join(temporary, file));
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

test("PDF snapshot keeps adjacent report list items on separate lines", async () => {
  const snapshot = await readFile(path.join(panel, "snapshots/30.txt"), "utf8");
  assert.match(snapshot, /\nGraduation goal: Spring\/May 2027\nWhy an advisor should review this plan:/);
  assert.doesNotMatch(snapshot, /2027Why an advisor should review this plan:/);
  assert.match(snapshot, /TABLE HEADER: Requirement\nTABLE HEADER: Course \/ term\nTABLE HEADER: Status/);
  assert.match(snapshot, /CHECKLIST CELL: ECO 113\nCHECKLIST CELL: ECO 113/);
});

test("panel lint ignores schedule and grid repetition but catches a planted duplicate sentence", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "econplanner-panel-lint-noise-"));
  try {
    const snapshotDir = path.join(temporary, "snapshots");
    await mkdir(snapshotDir);
    const lines = [
      "SCREEN", "SCREEN > Plan: Balanced", "STATUS: Ready to plan",
      "SCREEN > Plan: Balanced > Grid",
      "GRID ROW: ECO 113 | Principles of Microeconomics",
      "GRID ROW: ECO 113 | Principles of Microeconomics",
      "NOTE: Seat availability not confirmed",
      "NOTE: Seat availability not confirmed",
      "SCREEN > Plan: Balanced > Notes: Published schedules",
      "— Section J: Tue/Thu, 10:00–11:45 a.m.; Section K: Mon/Wed/Fri, 8:00–9:10 a.m.",
      "— Section J: Tue/Thu, 10:00–11:45 a.m.; Section K: Mon/Wed/Fri, 8:00–9:10 a.m.",
      "Check the registration system before you register.",
      "Check the registration system before you register.",
      "PDF", ""
    ];
    const file = path.join(snapshotDir, "01.txt");
    await writeFile(file, lines.join("\n"));
    const planted = invoke(lintScript, ["--snapshots-dir", snapshotDir]);
    assert.equal(planted.status, 1, planted.stdout + planted.stderr);
    assert.match(planted.stdout, /duplicate=1/);
    assert.match(planted.stdout, /semicolon=0/);
    lines.splice(lines.lastIndexOf("Check the registration system before you register."), 1);
    await writeFile(file, lines.join("\n"));
    const restored = invoke(lintScript, ["--snapshots-dir", snapshotDir]);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.match(restored.stdout, /Panel sentence violations: 0/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("same-fact wording variants go to a separate non-blocking report", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "econplanner-panel-fact-report-"));
  try {
    const snapshotDir = path.join(temporary, "snapshots");
    await mkdir(snapshotDir);
    await writeFile(path.join(snapshotDir, "01.txt"), [
      "SCREEN", "SCREEN > Plan: Balanced", "STATUS: Needs confirmation",
      "ECO 461 requires approval from the Economics Department.",
      "ECO 461 needs approval from the Economics Department.",
      "PDF", ""
    ].join("\n"));
    const result = invoke(lintScript, ["--snapshots-dir", snapshotDir]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Panel sentence violations: 0/);
    assert.match(await readFile(path.join(temporary, "fact-variants.txt"), "utf8"), /Same-fact wording variants: 1/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("panel:check catches a planted change to the unique-lines inventory", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "econplanner-panel-lines-check-"));
  try {
    await cp(path.join(panel, "snapshots"), path.join(temporary, "snapshots"), { recursive: true });
    await cp(path.join(panel, "plans"), path.join(temporary, "plans"), { recursive: true });
    for (const file of ["trace.json", "trace.md", "unique-lines.txt"]) await cp(path.join(panel, file), path.join(temporary, file));
    const inventory = path.join(temporary, "unique-lines.txt");
    await writeFile(inventory, `${await readFile(inventory, "utf8")}01\tDeliberately planted line.\n`);
    const result = invoke(runScript, ["--check", "--generated-dir", temporary]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /unique-lines\.txt differs:/);
    assert.match(result.stderr, /Deliberately planted line/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
