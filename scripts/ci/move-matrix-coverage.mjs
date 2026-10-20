import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Balance by exercised move pairs, not by the number of student profiles.
export const profileGroups = {
  1: ["early", "extended", "transfer", "senior"],
  2: ["freshman", "current-fixed", "sophomore", "taking-now", "junior", "reserved"]
};
export const coverageKeys = ["profiles", "plans", "pairs", "listed", "hidden", "accepted", "rejected", "may2027", "capstone", "capstoneAccepted", "capstoneRejected", "fixed"];

export function selectProfiles(names, shard) {
  assert.ok(Object.hasOwn(profileGroups, shard), `Unknown move-matrix shard: ${shard}`);
  assert.deepEqual(Object.values(profileGroups).flat().sort(), [...names].sort(), "Shard groups must cover every PR profile exactly once");
  return profileGroups[shard];
}

export function combineCoverage(reports) {
  assert.deepEqual(reports.map(report => String(report.shard)).sort(), Object.keys(profileGroups).sort(), "Every move-matrix shard must report exactly once");
  const total = Object.fromEntries(coverageKeys.map(key => [key, 0]));
  for (const report of reports) {
    assert.deepEqual([...report.profiles].sort(), [...profileGroups[report.shard]].sort(), "Shard profile coverage differs");
    assert.equal(report.coverage.profiles, report.profiles.length, "Profile count differs");
    assert.equal(report.findingCount, 0, "Move matrix reported failures");
    assert.deepEqual(report.uncoveredCells, [], "Move cells were omitted");
    assert.deepEqual(report.uncoveredProfiles, [], "Profiles were omitted");
    for (const key of coverageKeys) {
      assert.ok(Number.isSafeInteger(report.coverage[key]) && report.coverage[key] >= 0, `Invalid coverage: ${key}`);
      total[key] += report.coverage[key];
    }
  }
  for (const key of coverageKeys) assert.ok(total[key] > 0, `Missing move-matrix coverage: ${key}`);
  return total;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reports = await Promise.all(process.argv.slice(2).map(async path => JSON.parse(await readFile(path, "utf8"))));
  console.log(JSON.stringify(combineCoverage(reports)));
}
