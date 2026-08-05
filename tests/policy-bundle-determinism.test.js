import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compilePolicy } from "../scripts/compile-policy.mjs";

async function filesBelow(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(root, absolute));
    else files.push(path.relative(root, absolute).replaceAll("\\", "/"));
  }
  return files.sort();
}

test("three clean compilations are byte-identical with one stable digest", async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "econ-policy-determinism-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const roots = [1, 2, 3].map(run => path.join(temporaryRoot, `run-${run}`));
  const results = [];
  for (const root of roots) results.push(await compilePolicy({ outputRoot: path.join(root, "release") }));

  assert.equal(new Set(results.map(result => result.bundle.contentHash)).size, 1);
  const expectedFiles = await filesBelow(roots[0]);
  for (const root of roots.slice(1)) {
    assert.deepEqual(await filesBelow(root), expectedFiles);
    for (const relativePath of expectedFiles) {
      assert.deepEqual(await readFile(path.join(root, relativePath)), await readFile(path.join(roots[0], relativePath)), relativePath);
    }
  }
});
