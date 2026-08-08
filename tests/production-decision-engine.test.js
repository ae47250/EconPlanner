import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { loadPolicyBundle } from "../lib/policy/load-bundle.js";
import {
  auditStudentHistory,
  evaluateOffering,
  evaluatePlan,
  evaluatePrerequisites,
  evaluateRecordedCourse,
  evaluateRequirementAllocation,
  evaluateTermLoad,
  normalizeStudentFacts
} from "../lib/decision-engine/index.js";

const activeReference = JSON.parse(await fs.readFile(new URL(
  "../data/compiled/policy/active.json",
  import.meta.url
), "utf8")).programs.ECONOMICS["2025-2026"];
const bundle = await loadPolicyBundle({
  expectedVersion: "econ-2025-2026.1",
  expectedHash: activeReference.contentHash
});
const facts = normalizeStudentFacts({ planCreationDate: "2026-08-05", courses: [] });

function verifiedElectivePlan() {
  return {
    id: "engine-fixture",
    terms: [{
      academicYear: "2026-2027",
      termKey: "Fall",
      term: "Fall 2026",
      courses: [{ course: "ECO 234", section: "A", requirementId: "eco-elective-1", source: "verified-offering" }]
    }],
    unscheduled: []
  };
}

test("the active governed bundle loads immutably with its exact digest", () => {
  assert.equal(bundle.bundleVersion, "econ-2025-2026.1");
  assert.equal(bundle.contentHash, activeReference.contentHash);
  assert.equal(bundle.activationStatus, "ACTIVE");
  assert.equal(Object.isFrozen(bundle), true);
  assert.equal(Object.isFrozen(bundle.rules), true);
});

test("requirement allocation enforces ECO 257 statistics-only without an elective override", () => {
  assert.equal(evaluateRequirementAllocation("ECO 257", "statistics", facts, bundle, { traceId: "fixture" }).status, "ALLOW");
  const elective = evaluateRequirementAllocation("ECO 257", "eco-elective-1", facts, bundle, { traceId: "fixture" });
  assert.equal(elective.status, "BLOCK");
  assert.deepEqual(elective.ruleIds, ["ELECTIVE-ECO-257-STATISTICS-ONLY"]);
});

test("prerequisites distinguish prior evidence, missing evidence, and approved concurrency", () => {
  const missing = evaluatePrerequisites("ECO 213", {}, facts, bundle, { traceId: "fixture", availableCourses: new Set(), sameTermCourses: new Set() });
  assert.equal(missing.status, "BLOCK");
  const prior = evaluatePrerequisites("ECO 213", {}, facts, bundle, { traceId: "fixture", availableCourses: new Set(["ECO 113", "MAT 113"]), sameTermCourses: new Set() });
  assert.equal(prior.status, "ALLOW");
  const concurrent = evaluatePrerequisites({
    course: "ECO 213",
    approvalRequired: [{
      course: "ECO 213",
      prerequisite: "MAT 113",
      type: "INSTRUCTOR_APPROVAL",
      term: "Fall 2026",
      reason: "concurrent_math",
      policySource: "Economics Department policy"
    }]
  }, { term: "Fall 2026" }, facts, bundle, { traceId: "fixture", availableCourses: new Set(["ECO 113"]), sameTermCourses: new Set(["ECO 213", "MAT 113"]) });
  assert.equal(concurrent.status, "CONDITIONAL");
});

test("offering evidence keeps FULL under review and ordinary future projections nonblocking", () => {
  const full = evaluateOffering({ course: "ECO 113", section: "A", source: "verified-offering" }, { academicYear: "2026-2027", termKey: "Fall" }, bundle.indexes.offeringByTerm, bundle, { traceId: "fixture" });
  assert.equal(full.status, "REVIEW_REQUIRED");
  assert.equal(full.offeringEvidence.enrollmentState, "FULL");
  const projected = evaluateOffering({ course: "ECO 213", source: "projected-offering" }, { academicYear: "2027-2028", termKey: "Fall" }, bundle.indexes.offeringByTerm, bundle, { traceId: "fixture" });
  assert.equal(projected.status, "ALLOW");
  assert.equal(projected.reasonCode, "FUTURE_SCHEDULE_PLANNING_PROJECTION");
});

test("term capacity is hard while a heavier Economics load is only a soft warning", () => {
  const heavy = evaluateTermLoad({ termKey: "Fall", academicYear: "2026-2027", courses: [{ course: "ECO 221" }, { course: "ECO 222" }, { course: "ECO 223" }] }, {}, bundle, { traceId: "fixture" });
  assert.equal(heavy.status, "ALLOW");
  assert.equal(heavy.classification, "SOFT");
  const overCapacity = evaluateTermLoad({ termKey: "Fall", academicYear: "2026-2027", courses: Array.from({ length: 5 }, (_, index) => ({ course: `ECO ${220 + index}` })) }, {}, bundle, { traceId: "fixture" });
  assert.equal(overCapacity.status, "BLOCK");
});

test("completed advanced history is preserved as review rather than erased or inferred", () => {
  const recorded = evaluateRecordedCourse({ course: "ECO 331", status: "COMPLETED", prerequisiteEvidence: [] }, facts, bundle, { traceId: "fixture" });
  assert.equal(recorded.status, "REVIEW_REQUIRED");
  assert.deepEqual(recorded.ruleIds, ["HISTORY-COMPLETED-ADVANCED-PRESERVED"]);
});

test("unresolved equivalency scope remains a traceable non-enforcing review decision", () => {
  const ruleId = "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE";
  assert.equal(bundle.indexes.byRuleId[ruleId], undefined);
  const audit = auditStudentHistory({
    planCreationDate: "2026-08-05",
    courses: [{ code: "ECO 113", status: "transfer", source: "transfer_equivalency" }]
  }, bundle, { traceId: "review-fixture" });
  const finding = audit.reviewFindings.find(decision => decision.reasonCode === "COURSE_EVIDENCE_SCOPE_REVIEW");
  assert.ok(finding);
  assert.equal(finding.status, "REVIEW_REQUIRED");
  assert.deepEqual(finding.ruleIds, [ruleId]);
  assert.deepEqual(finding.sourceRefs, ["ECONOMICS-REQUIREMENTS#Use-of-This-File"]);
  assert.equal(finding.policyDisposition.disposition, "REVIEW_ONLY");
  assert.equal(finding.policyDisposition.enforcement, "NON_ENFORCING");
  assert.equal(finding.policyDisposition.status, "REVIEW_REQUIRED");
  assert.equal(finding.provenance[0].sourceId, "ECONOMICS-REQUIREMENTS");
  assert.ok(audit.decisions.every(decision => decision.status !== "ALLOW" && decision.status !== "BLOCK"));
});

test("whole-plan decision p95 stays below 100ms", () => {
  const samples = [];
  for (let index = 0; index < 250; index += 1) samples.push(evaluatePlan(verifiedElectivePlan(), facts, {}, bundle).latencyMs);
  const sorted = samples.toSorted((left, right) => left - right);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  assert.ok(p95 < 100, `whole-plan decision p95 was ${p95}ms`);
});
