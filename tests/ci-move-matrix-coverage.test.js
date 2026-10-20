import test from "node:test";
import assert from "node:assert/strict";
import { combineCoverage, coverageKeys, profileGroups, selectProfiles } from "../scripts/ci/move-matrix-coverage.mjs";

function reports() {
  return Object.entries(profileGroups).map(([shard, profiles]) => ({
    shard, profiles: [...profiles], coverage: { ...Object.fromEntries(coverageKeys.map(key => [key, 1])), profiles: profiles.length },
    uncoveredCells: [], uncoveredProfiles: [], findingCount: 0
  }));
}

test("shard groups partition every profile and reject stale or unknown selections", () => {
  const names = Object.values(profileGroups).flat();
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(selectProfiles(names, "1"), profileGroups[1]);
  assert.throws(() => selectProfiles([...names, "new-profile"], "1"));
  assert.throws(() => selectProfiles(names, "3"));
});

test("combined coverage retains global assertions even when a category exists in only one shard", () => {
  const input = reports();
  input[0].coverage.fixed = 0;
  assert.equal(combineCoverage(input).profiles, 10);
  assert.equal(combineCoverage(input).fixed, 1);
  input[1].coverage.fixed = 0;
  assert.throws(() => combineCoverage(input), /Missing move-matrix coverage: fixed/);
});

test("missing, duplicated, incomplete, or failed shard evidence cannot pass", () => {
  assert.throws(() => combineCoverage(reports().slice(0, 1)));
  assert.throws(() => combineCoverage([reports()[0], reports()[0]]));
  for (const corrupt of [
    report => report.profiles.pop(),
    report => report.uncoveredCells.push("unexercised-cell"),
    report => report.uncoveredProfiles.push("missing-profile"),
    report => report.findingCount++,
    report => delete report.coverage.pairs,
    report => report.coverage.profiles--
  ]) {
    const input = reports();
    corrupt(input[0]);
    assert.throws(() => combineCoverage(input));
  }
});
