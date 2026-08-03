import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const production = JSON.parse(await readFile(
  new URL("../data/normalized/economics/schedule-2026-2027.json", import.meta.url),
  "utf8"
));
const oracle = JSON.parse(await readFile(
  new URL("./oracle/verified-schedule-2026-2027.json", import.meta.url),
  "utf8"
));

const COMPARISON_FIELDS = [
  "academicYear",
  "term",
  "course",
  "canonicalCrossListIdentity",
  "section",
  "title",
  "units",
  "startDate",
  "endDate",
  "meetingDays",
  "startTime",
  "endTime",
  "availabilityState",
  "seatsOpen",
  "capacity",
  "verificationDate",
  "sourceReference"
];

function sectionKey(row) {
  return [row.academicYear, row.term, row.course, row.section].join("|");
}

function productionRows() {
  return Object.entries(production.terms || {}).flatMap(([term, sections]) => (
    sections
      .filter(section => section.verificationStatus === "verified")
      .map(section => ({
        academicYear: production.academicYear,
        term,
        course: section.course,
        canonicalCrossListIdentity: [
          section.course,
          ...(section.crossListedAs || [])
        ].sort(),
        section: section.section,
        title: section.title,
        units: section.units,
        startDate: section.meeting?.startDate || null,
        endDate: section.meeting?.endDate || null,
        meetingDays: section.meeting?.days || [],
        startTime: section.meeting?.startTime || null,
        endTime: section.meeting?.endTime || null,
        availabilityState: section.availability?.status || "unknown",
        seatsOpen: section.availability?.seatsOpen ?? null,
        capacity: section.availability?.capacity ?? null,
        verificationDate: section.provenance?.verifiedOn || null,
        sourceReference: section.provenance?.sourceFiles?.length
          ? [...section.provenance.sourceFiles].sort()
          : []
      }))
  ));
}

function oracleRows() {
  return oracle.sections.map(section => ({
    academicYear: oracle.academicYear,
    term: section.term,
    course: section.course,
    canonicalCrossListIdentity: [...section.canonicalCrossListIdentity].sort(),
    section: section.section,
    title: section.title,
    units: section.units,
    startDate: section.courseDates.startDate,
    endDate: section.courseDates.endDate,
    meetingDays: section.meeting.days,
    startTime: section.meeting.startTime,
    endTime: section.meeting.endTime,
    availabilityState: section.availability.state,
    seatsOpen: section.availability.seatsOpen,
    capacity: section.availability.capacity,
    verificationDate: section.verificationDate,
    sourceReference: [section.sourceReference]
  }));
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function displayValue(value) {
  return JSON.stringify(value);
}

function formatDrift(drift) {
  return [
    drift.kind,
    drift.academicYear,
    drift.term,
    drift.course,
    drift.section,
    drift.fieldName,
    `production=${displayValue(drift.productionValue)}`,
    `oracle=${displayValue(drift.oracleValue)}`,
    `source=${drift.source || "unknown"}`
  ].join(" | ");
}

function findScheduleDrift() {
  const productionByKey = new Map(productionRows().map(row => [sectionKey(row), row]));
  const oracleByKey = new Map(oracleRows().map(row => [sectionKey(row), row]));
  const drift = [];

  for (const [key, productionRow] of productionByKey) {
    const oracleRow = oracleByKey.get(key);
    if (!oracleRow) {
      drift.push({
        kind: "ADDED_IN_PRODUCTION",
        ...productionRow,
        fieldName: "sectionPresence",
        productionValue: "present",
        oracleValue: "missing",
        source: productionRow.sourceReference.join(", ")
      });
      continue;
    }

    for (const fieldName of COMPARISON_FIELDS) {
      if (sameValue(productionRow[fieldName], oracleRow[fieldName])) continue;
      drift.push({
        kind: "CHANGED",
        academicYear: productionRow.academicYear,
        term: productionRow.term,
        course: productionRow.course,
        section: productionRow.section,
        fieldName,
        productionValue: productionRow[fieldName],
        oracleValue: oracleRow[fieldName],
        source: oracleRow.sourceReference.join(", ")
      });
    }
  }

  for (const [key, oracleRow] of oracleByKey) {
    if (productionByKey.has(key)) continue;
    drift.push({
      kind: "REMOVED_FROM_PRODUCTION",
      ...oracleRow,
      fieldName: "sectionPresence",
      productionValue: "missing",
      oracleValue: "present",
      source: oracleRow.sourceReference.join(", ")
    });
  }

  return drift;
}

test("independent schedule snapshot has reviewed, immutable source evidence", async () => {
  assert.equal(oracle.schemaVersion, 1);
  assert.equal(oracle.academicYear, "2026-2027");
  assert.equal(oracle.review.status, "INDEPENDENT_ROW_REVIEW");
  assert.match(oracle.review.reviewedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(oracle.review.reviewedBy);
  assert.equal(oracle.sections.length, 17);

  const sourcePaths = new Set(oracle.sources.map(source => source.path));
  for (const source of oracle.sources) {
    const bytes = await readFile(new URL(`../${source.path}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256, source.path);
  }

  const keys = new Set();
  for (const section of oracle.sections) {
    const row = { academicYear: oracle.academicYear, ...section };
    const key = sectionKey(row);
    assert.equal(keys.has(key), false, `duplicate oracle section ${key}`);
    keys.add(key);

    assert.ok(sourcePaths.has(section.sourceReference), key);
    assert.ok(section.canonicalCrossListIdentity.includes(section.course), key);
    assert.equal(section.verificationDate, null, key);
    assert.ok(section.unknownFields.includes("verificationDate"), key);
  }
});

test("production verified sections match the independent schedule snapshot field by field", () => {
  const drift = findScheduleDrift();
  assert.equal(
    drift.length,
    0,
    `Schedule drift requires independent review (${drift.length} finding(s)):\n${drift.map(formatDrift).join("\n")}`
  );
});
