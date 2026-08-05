import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/run-econplanner-phase.mjs", import.meta.url));

async function withDirectory(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "econplanner-phase-test-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function invoke(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true });
}

test("phase wrapper records passing TAP counts, command, duration, and artifacts", async () => withDirectory(async directory => {
  const output = path.join(directory, "phase.json");
  const log = path.join(directory, "phase.log");
  const result = invoke([
    "--phase", "fixture-pass", "--output", output, "--log", log, "--timeout-ms", "5000",
    "--", process.execPath, "-e", "console.log('ℹ tests 2\\nℹ pass 2\\nℹ fail 0')"
  ]);
  assert.equal(result.status, 0, result.stderr);
  const phase = JSON.parse(await readFile(output, "utf8"));
  assert.equal(phase.status, "PASSED");
  assert.equal(phase.tap.tests, 2);
  assert.equal(phase.tap.pass, 2);
  assert.ok(phase.durationMs >= 0);
  assert.deepEqual(phase.command.slice(0, 2), [process.execPath, "-e"]);
}));

test("phase wrapper finalizes TIMED_OUT instead of leaving NOT_ATTEMPTED", async () => withDirectory(async directory => {
  const output = path.join(directory, "timeout.json");
  const result = invoke([
    "--phase", "fixture-timeout", "--output", output, "--timeout-ms", "100",
    "--", process.execPath, "-e", "setInterval(() => {}, 1000)"
  ]);
  assert.notEqual(result.status, 0);
  const phase = JSON.parse(await readFile(output, "utf8"));
  assert.equal(phase.status, "TIMED_OUT");
  assert.ok(phase.completedAt);
}));

test("a missing mandatory output makes an otherwise passing phase fail", async () => withDirectory(async directory => {
  const output = path.join(directory, "missing.json");
  const missing = path.join(directory, "not-created.json");
  const result = invoke([
    "--phase", "fixture-missing", "--output", output, "--timeout-ms", "5000",
    "--expect-artifact", missing,
    "--", process.execPath, "-e", "process.exit(0)"
  ]);
  assert.notEqual(result.status, 0);
  const phase = JSON.parse(await readFile(output, "utf8"));
  assert.equal(phase.status, "FAILED");
  assert.deepEqual(phase.artifacts.missing, [missing]);
}));
