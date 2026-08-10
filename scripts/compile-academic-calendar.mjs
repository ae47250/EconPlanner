import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "../lib/policy/canonical-json.js";
import { sourceEvidenceSha256 } from "../lib/source-evidence-hash.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = "policy/calendars/hanover-undergraduate.json";
const PROVENANCE_PATH = "policy/provenance/academic-calendar.1.json";
const OUTPUT_PATH = "data/normalized/academic-calendars.json";
const MANIFEST_PATH = "data/manifests/source-manifest.json";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CANONICAL_TERMS = new Set(["FALL", "WINTER", "MAY"]);

function fail(message) {
  throw new Error(`Academic-calendar compilation failed: ${message}`);
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(REPOSITORY_ROOT, relativePath), "utf8"));
}

function validate(source, provenance) {
  if (source.calendarVersion !== "hanover-undergraduate-calendar.1"
    || source.status !== "OFFICIAL_HANOVER_SOURCE"
    || source.source !== "https://www.hanover.edu/academics/calendar/") {
    fail("the canonical official-calendar identity is incomplete");
  }
  if (provenance.calendarVersion !== source.calendarVersion
    || !provenance.sources?.some(item => (
      item.sourceId === "HANOVER-UNDERGRADUATE-ACADEMIC-CALENDAR-2026-08-10"
      && item.authorityBoundary === "UNDERGRADUATE_TERM_BOUNDARIES_AND_INITIAL_DROP_ADD_DATES_ONLY"
    ))) {
    fail("official academic-calendar provenance is incomplete");
  }
  const identities = new Set();
  for (const window of source.initialDropAddWindows || []) {
    if (!/^\d{4}-\d{4}$/.test(window.academicYear)
      || !CANONICAL_TERMS.has(window.canonicalTerm)
      || !window.displayTerm
      || !DATE_PATTERN.test(window.start)
      || !DATE_PATTERN.test(window.end)
      || window.start > window.end
      || !window.sourceRef) {
      fail(`invalid initial drop/add window: ${JSON.stringify(window)}`);
    }
    const identity = `${window.academicYear}:${window.canonicalTerm}`;
    if (identities.has(identity)) fail(`duplicate initial drop/add window: ${identity}`);
    identities.add(identity);
  }
  if (identities.size !== 6) fail("exactly six verified initial drop/add windows are required");
}

export async function compileAcademicCalendar() {
  const source = await readJson(SOURCE_PATH);
  const provenance = await readJson(PROVENANCE_PATH);
  validate(source, provenance);
  const normalized = {
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
  const normalizedBytes = canonicalJson(normalized);
  await writeFile(path.join(REPOSITORY_ROOT, OUTPUT_PATH), normalizedBytes, "utf8");

  const manifest = await readJson(MANIFEST_PATH);
  const entry = manifest.entries?.find(item => item.role === "academic_calendar");
  if (!entry) fail("source manifest has no academic_calendar entry");
  Object.assign(entry, {
    source: source.source,
    academicYear: "2025-2026 through 2026-2027",
    retrievedOn: source.retrievedOn,
    approvalStatus: source.status,
    path: OUTPUT_PATH,
    sha256: sourceEvidenceSha256(normalizedBytes, OUTPUT_PATH)
  });
  await writeFile(path.join(REPOSITORY_ROOT, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { normalized, sha256: entry.sha256 };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await compileAcademicCalendar();
  process.stdout.write(`${result.normalized.calendarVersion} sha256:${result.sha256}\n`);
}
