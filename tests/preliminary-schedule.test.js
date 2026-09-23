import test from "node:test";
import assert from "node:assert/strict";
import { runtimePolicyBundle } from "../lib/policy/compat-normalized.js";
import { evaluateOffering } from "../lib/decision-engine/placement.js";
import { annotatePreliminaryScheduleEvidence, preliminaryEvidenceFor, preliminaryTermId } from "../lib/policy/preliminary-schedule.js";
import { preliminaryOfferingIndex } from "../scripts/compile-policy.mjs";

const current = runtimePolicyBundle();
const fictional = {
  ...current,
  indexes: {
    ...current.indexes,
    preliminaryOfferingByTerm: {
      "2027-FALL": {
        releaseId: "FICTIONAL-TEST-RELEASE",
        issuedOn: "2026-11-01",
        sourceRefs: ["FICTIONAL-TEST-SCHEDULE#FALL"],
        courses: ["ECO 213"]
      }
    }
  }
};

test("compiler indexes only dated, archived preliminary evidence outside exact coverage", () => {
  const release = { releases: [{
    releaseId: "FICTIONAL-TEST-RELEASE",
    academicYear: "2027-2028",
    issuedOn: "2026-11-01",
    sourceRefs: ["FICTIONAL-TEST-SCHEDULE#FALL"],
    terms: [{ termId: "2027-FALL", courses: ["ECO 213"] }]
  }] };
  const provenance = { sources: [{ sourceId: "FICTIONAL-TEST-SCHEDULE", path: "fictional-test-schedule.pdf", sha256: "test-hash" }] };
  const exact = { terms: [{ termId: "2026-FALL" }] };
  assert.deepEqual(preliminaryOfferingIndex(release, exact, provenance)["2027-FALL"].courses, ["ECO 213"]);
  assert.throws(() => preliminaryOfferingIndex(release, exact, { sources: [] }), /archived, hashed schedule evidence/);
  assert.throws(() => preliminaryOfferingIndex(release, { terms: [{ termId: "2027-FALL" }] }, provenance), /overlaps the active exact schedule/);
});

test("dated preliminary evidence guides a course and term without proving sections or seats", () => {
  const term = { academicYear: "2027-2028", termKey: "Fall" };
  assert.equal(preliminaryTermId(term), "2027-FALL");
  const decision = evaluateOffering({ course: "ECO 213", source: "projected-offering" }, term, fictional.indexes.offeringByTerm, fictional);
  assert.equal(decision.status, "ALLOW");
  assert.equal(decision.reasonCode, "PRELIMINARY_SCHEDULE_COURSE_TERM");
  assert.equal(decision.offeringEvidence.preliminarySchedule.issuedOn, "2026-11-01");
  assert.equal(decision.offeringEvidence.sectionId, undefined);
  assert.equal(decision.offeringEvidence.enrollmentState, undefined);
});

test("preliminary omissions do not block a labeled projection", () => {
  const term = { academicYear: "2027-2028", termKey: "Fall" };
  assert.equal(preliminaryEvidenceFor(fictional, "2027-FALL", "ECO 214"), null);
  const decision = evaluateOffering({ course: "ECO 214", source: "projected-offering" }, term, fictional.indexes.offeringByTerm, fictional);
  assert.equal(decision.status, "ALLOW");
  assert.equal(decision.reasonCode, "FUTURE_SCHEDULE_PLANNING_PROJECTION");
});

test("revalidating a moved course removes stale preliminary evidence", () => {
  const course = { course: "ECO 213", source: "projected-offering", preliminaryScheduleEvidence: { issuedOn: "old" } };
  const plan = { terms: [{ academicYear: "2027-2028", termKey: "Winter", courses: [course] }] };
  annotatePreliminaryScheduleEvidence(plan, fictional);
  assert.equal(course.preliminaryScheduleEvidence, undefined);
  plan.terms[0].termKey = "Fall";
  annotatePreliminaryScheduleEvidence(plan, fictional);
  assert.equal(course.preliminaryScheduleEvidence.issuedOn, "2026-11-01");
});

test("the active exact schedule supersedes preliminary entries in its covered term", () => {
  const overlapping = {
    ...fictional,
    indexes: {
      ...fictional.indexes,
      preliminaryOfferingByTerm: {
        "2026-FALL": fictional.indexes.preliminaryOfferingByTerm["2027-FALL"]
      }
    }
  };
  assert.equal(preliminaryEvidenceFor(overlapping, "2026-FALL", "ECO 213"), null);
  const decision = evaluateOffering({ course: "ECO 213", source: "projected-offering" }, { academicYear: "2026-2027", termKey: "Fall" }, overlapping.indexes.offeringByTerm, overlapping);
  assert.notEqual(decision.reasonCode, "PRELIMINARY_SCHEDULE_COURSE_TERM");
});
