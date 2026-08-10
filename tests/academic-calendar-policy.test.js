import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canonicalJson } from "../lib/policy/canonical-json.js";
import { sourceEvidenceSha256 } from "../lib/source-evidence-hash.js";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("normalized academic calendar is a byte-derived projection of canonical source and provenance", async () => {
  const [source, provenance, normalized, manifest] = await Promise.all([
    readJson("../policy/calendars/hanover-undergraduate.json"),
    readJson("../policy/provenance/academic-calendar.1.json"),
    readJson("../data/normalized/academic-calendars.json"),
    readJson("../data/manifests/source-manifest.json")
  ]);
  const expected = {
    calendarVersion: source.calendarVersion,
    source: source.source,
    retrievedOn: source.retrievedOn,
    approvalStatus: source.status,
    academicYears: source.academicYears,
    summerClarificationWindows: source.summerClarificationWindows,
    initialDropAddWindows: source.initialDropAddWindows.map(window => ({
      ...window,
      source: source.source,
      retrievedOn: source.retrievedOn
    }))
  };
  assert.deepEqual(normalized, expected);
  assert.ok(provenance.sources.some(item => (
    item.authorityBoundary === "UNDERGRADUATE_TERM_BOUNDARIES_AND_INITIAL_DROP_ADD_DATES_ONLY"
  )));
  assert.match(provenance.sources[0].statement, /Schedule confirmation week/);
  const entry = manifest.entries.find(item => item.role === "academic_calendar");
  assert.equal(entry.path, "data/normalized/academic-calendars.json");
  assert.equal(entry.sha256, sourceEvidenceSha256(
    canonicalJson(expected),
    "data/normalized/academic-calendars.json"
  ));
});
