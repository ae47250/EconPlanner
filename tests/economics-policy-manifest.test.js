import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const manifestUrl = new URL("./oracle/economics-policy.v1.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

const RULE_COLLECTIONS = [
  "requirementRules",
  "prerequisiteRules",
  "concurrencyRules",
  "permissionRules",
  "electiveRules",
  "capstoneRules",
  "planningRules",
  "scheduleEvidenceRules"
];

const confirmedRules = RULE_COLLECTIONS.flatMap(collection => manifest[collection]);
const allRules = [...confirmedRules, ...manifest.unresolvedPolicyQuestions];

function byId(ruleId) {
  return allRules.find(rule => rule.ruleId === ruleId);
}

test("policy manifest has stable version and review metadata", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.policy.id, "hanover-economics-planning-policy");
  assert.equal(manifest.policy.version, 3);
  assert.equal(manifest.policy.confirmationDate, "2026-08-04");
  assert.equal(
    manifest.policy.reviewedBy,
    "Economics Department representative and project owner"
  );

  assert.deepEqual(manifest.policy.allowedStatuses, [
    "CONFIRMED",
    "POLICY_REVIEW_REQUIRED",
    "ADVISOR_CONFIRMATION_REQUIRED",
    "EQUIVALENCY_NOT_CONFIRMED"
  ]);
});

test("all source files and confirmation references are explicit", async () => {
  const sourceIds = new Set(manifest.sources.map(source => source.id));
  const confirmationIds = new Set(manifest.confirmationRecords.map(record => record.id));

  assert.equal(sourceIds.size, manifest.sources.length);
  assert.equal(confirmationIds.size, manifest.confirmationRecords.length);

  for (const source of manifest.sources) {
    await access(new URL(`../${source.path}`, import.meta.url));
    assert.ok(source.authority);
  }

  for (const rule of confirmedRules) {
    assert.equal(rule.status, "CONFIRMED", rule.ruleId);
    assert.ok(confirmationIds.has(rule.confirmationRef), rule.ruleId);
    assert.ok(rule.sourceRefs.length > 0, rule.ruleId);

    for (const sourceRef of rule.sourceRefs) {
      assert.ok(sourceIds.has(sourceRef.split("#")[0]), `${rule.ruleId}: ${sourceRef}`);
    }
  }

  for (const record of manifest.confirmationRecords) {
    assert.match(record.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(
      record.reviewedBy,
      "Economics Department representative and project owner"
    );
  }
});

test("rule IDs are unique and all rule statuses are declared", () => {
  const ruleIds = allRules.map(rule => rule.ruleId);
  assert.equal(new Set(ruleIds).size, ruleIds.length);

  for (const rule of allRules) {
    assert.match(rule.ruleId, /^[A-Z0-9-]+$/);
    assert.ok(manifest.policy.allowedStatuses.includes(rule.status), rule.ruleId);
  }
});

test("the manifest defines all twelve Economics major slots", () => {
  const slotRules = manifest.requirementRules.filter(rule => [
    "exact",
    "choice",
    "elective"
  ].includes(rule.kind));
  const slotCount = slotRules.reduce((total, rule) => total + rule.slotCount, 0);

  assert.equal(slotCount, 12);
  assert.equal(byId("REQ-MAJOR-COURSE-COUNT").slotCount, 11);
  assert.equal(byId("REQ-COGNATE-COURSE-COUNT").slotCount, 1);
  assert.deepEqual(byId("REQ-STATISTICS").options, ["ECO 257", "MAT 217", "PSY 217"]);
  assert.deepEqual(byId("REQ-FINANCE").options, ["ECO 321", "BUSN 323"]);
  assert.equal(byId("REQ-ECO-ELECTIVES").slotCount, 4);
  assert.deepEqual(byId("REQ-ECO-ELECTIVES").futurePlaceholder, {
    displayLabel: "ECO elective",
    identityFields: ["placeholderSlotId", "requirementId"],
    countsAsPlannedSlot: true,
    countsAsCompletedCourse: false,
    allowedBeyondVerifiedScheduleHorizon: true,
    allowedInVerifiedScheduleYear: false
  });
});

test("the prerequisite table covers every confirmed dependent course", () => {
  assert.deepEqual(manifest.prerequisiteRules.map(rule => rule.course), [
    "ECO 213",
    "ECO 214",
    "ECO 221",
    "ECO 222",
    "ECO 223",
    "ECO 257",
    "ECO 315",
    "ECO 316",
    "ECO 321",
    "ECO 331",
    "ECO 333",
    "ECO 335",
    "ECO 337",
    "ECO 357",
    "ECO 461",
    "ECO 471"
  ]);

  assert.deepEqual(byId("PREREQ-ECO-461").oneOfGroups, [
    ["ECO 257", "MAT 217", "PSY 217"]
  ]);
  assert.equal(
    byId("PREREQ-ECO-335").unresolvedRuleId,
    "REVIEW-ECO-335-MATH-EQUIVALENT"
  );
});

test("confirmed exceptions, permissions, capacity, electives, and capstone rules are present", () => {
  assert.deepEqual(manifest.concurrencyRules.map(rule => rule.ruleId), [
    "CONCURRENT-MATH-ECO-213",
    "CONCURRENT-MATH-ECO-214",
    "CONCURRENT-INTERMEDIATE-ECO-461"
  ]);
  assert.equal(byId("PERMISSION-ECO-357").approvalAuthority, "Economics Department");
  assert.equal(byId("CAPACITY-FALL").maxTotalCourses, 4);
  assert.equal(byId("CAPACITY-WINTER").maxTotalCourses, 4);
  assert.equal(byId("CAPACITY-MAY").maxTotalCourses, 1);
  assert.equal(byId("ELECTIVE-MAX-ONE-100-LEVEL").maximum, 1);
  assert.equal(byId("ELECTIVE-ECO-260-COUNTS").countsAs, "ECO elective");
  assert.deepEqual(byId("ELECTIVE-ECO-257-STATISTICS-ONLY").allowedRequirementRuleIds, [
    "REQ-STATISTICS"
  ]);
  assert.deepEqual(byId("ELECTIVE-ECO-257-STATISTICS-ONLY").excludedRequirementRuleIds, [
    "REQ-ECO-ELECTIVES"
  ]);
  assert.deepEqual(byId("CAPSTONE-WINTER-ONLY").allowedTerms, ["Winter"]);
  assert.equal(byId("CAPSTONE-SENIOR-STANDING").requiredStanding, "Senior");
  assert.equal(byId("CAPSTONE-HANOVER-RESIDENCY").requiredInstitution, "Hanover College");
});

test("schedule evidence and section-state behavior are explicit", () => {
  const screenshotRule = byId("SCHEDULE-EVIDENCE-SCREENSHOT-FIELDS");
  const availabilityRule = byId("SCHEDULE-AVAILABILITY-BEHAVIOR");

  assert.deepEqual(screenshotRule.requiredScreenshotFields, [
    "academicYear",
    "term",
    "course",
    "section",
    "title",
    "instructor",
    "credits",
    "dates",
    "meetingPattern",
    "seats",
    "sectionStatus"
  ]);
  assert.match(availabilityRule.statuses.closed, /cannot support a feasible plan/);
  assert.match(availabilityRule.statuses.waitlisted, /conditional/);
});

test("the three unresolved questions remain non-binding review outcomes", () => {
  assert.deepEqual(
    manifest.unresolvedPolicyQuestions.map(rule => [rule.ruleId, rule.status]),
    [
      ["REVIEW-ADVANCED-COURSE-PREREQUISITE-CLOSURE", "POLICY_REVIEW_REQUIRED"],
      ["REVIEW-ECO-335-MATH-EQUIVALENT", "EQUIVALENCY_NOT_CONFIRMED"],
      ["REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE", "ADVISOR_CONFIRMATION_REQUIRED"]
    ]
  );

  for (const rule of manifest.unresolvedPolicyQuestions) {
    assert.equal(rule.confirmationRef, undefined, rule.ruleId);
    assert.ok(rule.question);
    assert.ok(rule.oracleBehavior);
  }
});
