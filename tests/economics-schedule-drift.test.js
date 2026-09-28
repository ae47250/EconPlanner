import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sourceEvidenceSha256 } from "../lib/source-evidence-hash.js";
import { loadEconomicsPolicyCompatibility } from "../lib/policy/compat-normalized.js";
import { normalizeEconomicsSchedule } from "../lib/planning/scheduleProvider.js";

const production = normalizeEconomicsSchedule(
  loadEconomicsPolicyCompatibility({ allowPending: true }).schedule
);
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
  "instructor",
  "units",
  "startDate",
  "endDate",
  "meetingDays",
  "startTime",
  "endTime",
  "availabilityState",
  "seatsOpen",
  "capacity",
  "availabilityAsOf",
  "verificationDate",
  "sourceReference"
];

function sectionKey(row) {
  return [row.academicYear, row.term, row.course, row.section].join("|");
}

function productionRows(schedule = production) {
  return Object.entries(schedule.terms || {}).flatMap(([term, sections]) => (
    sections
      .filter(section => section.verificationStatus === "verified")
      .map(section => ({
        academicYear: schedule.academicYear,
        term,
        course: section.course,
        canonicalCrossListIdentity: [
          section.course,
          ...(section.crossListedAs || [])
        ].sort(),
        section: section.section,
        title: section.title,
        instructor: section.instructor ?? null,
        units: section.units,
        startDate: section.meeting?.startDate || null,
        endDate: section.meeting?.endDate || null,
        meetingDays: section.meeting?.days || [],
        startTime: section.meeting?.startTime || null,
        endTime: section.meeting?.endTime || null,
        availabilityState: section.availability?.status || "unknown",
        seatsOpen: section.availability?.seatsOpen ?? null,
        capacity: section.availability?.capacity ?? null,
        availabilityAsOf: section.availability?.asOf ?? null,
        verificationDate: section.provenance?.verifiedOn || null,
        sourceReference: section.provenance?.sourceFiles?.length
          ? [...section.provenance.sourceFiles].sort()
          : []
      }))
  ));
}

function oracleRows(snapshot = oracle) {
  return snapshot.sections.map(section => ({
    academicYear: snapshot.academicYear,
    term: section.term,
    course: section.course,
    canonicalCrossListIdentity: [...section.canonicalCrossListIdentity].sort(),
    section: section.section,
    title: section.title,
    instructor: section.instructor ?? null,
    units: section.units,
    startDate: section.courseDates.startDate,
    endDate: section.courseDates.endDate,
    meetingDays: section.meeting.days,
    startTime: section.meeting.startTime,
    endTime: section.meeting.endTime,
    availabilityState: section.availability.state,
    seatsOpen: section.availability.seatsOpen,
    capacity: section.availability.capacity,
    availabilityAsOf: section.availability.asOf ?? null,
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

function findScheduleDrift(productionSchedule = production, oracleSnapshot = oracle) {
  const productionByKey = new Map(productionRows(productionSchedule).map(row => [sectionKey(row), row]));
  const oracleByKey = new Map(oracleRows(oracleSnapshot).map(row => [sectionKey(row), row]));
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

const REPRESENTATIVE_TEXT_EVIDENCE = [
  "term|course|section|title",
  "Fall|ECO 234|A|Rational Choices",
  "Winter|ECO 461|A|Research Seminar"
].join("\n");

test("text evidence hashing treats LF and CRLF as identical", () => {
  const crlfEvidence = REPRESENTATIVE_TEXT_EVIDENCE.replaceAll("\n", "\r\n");
  assert.equal(
    sourceEvidenceSha256(Buffer.from(crlfEvidence), "schedule-evidence.md"),
    sourceEvidenceSha256(Buffer.from(REPRESENTATIVE_TEXT_EVIDENCE), "schedule-evidence.md")
  );
});

test("official catalog snapshot hashing is stable across LF and CRLF checkouts", () => {
  const crlfEvidence = REPRESENTATIVE_TEXT_EVIDENCE.replaceAll("\n", "\r\n");
  assert.equal(
    sourceEvidenceSha256(Buffer.from(crlfEvidence), "catalog-snapshot.php"),
    sourceEvidenceSha256(Buffer.from(REPRESENTATIVE_TEXT_EVIDENCE), "catalog-snapshot.php")
  );
});

test("text evidence hashing treats LF and standalone CR as identical", () => {
  const crEvidence = REPRESENTATIVE_TEXT_EVIDENCE.replaceAll("\n", "\r");
  assert.equal(
    sourceEvidenceSha256(Buffer.from(crEvidence), "schedule-evidence.md"),
    sourceEvidenceSha256(Buffer.from(REPRESENTATIVE_TEXT_EVIDENCE), "schedule-evidence.md")
  );
});

test("text evidence hashing still detects meaningful schedule changes", () => {
  const changedEvidence = REPRESENTATIVE_TEXT_EVIDENCE.replace("ECO 234", "ECO 235");
  assert.notEqual(
    sourceEvidenceSha256(Buffer.from(changedEvidence), "schedule-evidence.md"),
    sourceEvidenceSha256(Buffer.from(REPRESENTATIVE_TEXT_EVIDENCE), "schedule-evidence.md")
  );
});

test("independent schedule snapshot has reviewed, immutable source evidence", async () => {
  assert.equal(oracle.schemaVersion, 1);
  assert.equal(oracle.academicYear, "2026-2027");
  assert.equal(oracle.review.status, "INDEPENDENT_ROW_REVIEW");
  assert.match(oracle.review.reviewedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(oracle.review.reviewedBy);
  assert.ok(oracle.sections.length > 0);

  const sourcePaths = new Set(oracle.sources.map(source => source.path));
  for (const source of oracle.sources) {
    const bytes = await readFile(new URL(`../${source.path}`, import.meta.url));
    assert.equal(sourceEvidenceSha256(bytes, source.path), source.sha256, source.path);
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
    assert.equal(section.unknownFields?.includes("verificationDate"), true, key);
    assert.equal(section.availability.asOf, null, key);
    assert.equal(section.unknownFields?.includes("availability.asOf"), true, key);
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

test("generated coverage agrees with independently reviewed subject/course boundaries", () => {
  assert.deepEqual(production.coverageByTerm, oracle.coverageByTerm);
  assert.equal(oracle.offeringConfirmations.length, 2);
  assert.deepEqual(oracle.offeringConfirmations.map(item => [item.academicYear,item.course,item.term,item.offeringExistence]), [
    ["2026-2027","BUSN 323","Fall","OFFERED"],
    ["2026-2027","BUSN 323","Winter","NOT_OFFERED"]
  ]);
  assert.equal(oracle.sections.some(section => section.term === "Winter" && section.course === "BUSN 323"),false);
});

test("a meaningful production schedule change is still reported as drift", () => {
  const changedSchedule = structuredClone(production);
  const changedSection = Object.values(changedSchedule.terms)
    .flat()
    .find(section => section.verificationStatus === "verified");
  assert.ok(changedSection);
  changedSection.title = `${changedSection.title} changed`;

  const drift = findScheduleDrift(changedSchedule, oracle);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].kind, "CHANGED");
  assert.equal(drift[0].course, changedSection.course);
  assert.equal(drift[0].section, changedSection.section);
  assert.equal(drift[0].fieldName, "title");
});
