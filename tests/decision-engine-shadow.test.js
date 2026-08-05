import test from "node:test";
import assert from "node:assert/strict";
import { loadPolicyBundle } from "../lib/policy/load-bundle.js";
import { classifyShadowDisagreement, recordShadowEvaluation, runDecisionEngineShadow } from "../lib/decision-engine/shadow.js";

const bundle = await loadPolicyBundle({ allowPending: true });
const student = { name: "Must Not Appear", email: "private@example.invalid", planCreationDate: "2026-08-05", courses: [] };

function plan(course = { course: "ECO 234", section: "A", requirementId: "eco-elective-1", source: "verified-offering" }) {
  return { id: "shadow-plan", terms: [{ academicYear: "2026-2027", termKey: "Fall", term: "Fall 2026", courses: [course] }], unscheduled: [] };
}

test("shadow evaluation records hashes and classifications without student data", async () => {
  const record = await runDecisionEngineShadow({ student, plan: plan(), productionValidation: { valid: true, errors: [] }, bundle, source: "test" });
  assert.equal(record.mode, "SHADOW_NONAUTHORITATIVE");
  assert.equal(record.classification, "AGREEMENT_ALLOW");
  assert.equal(record.completionStatus, "COMPLETE");
  assert.equal(record.evidenceStatus, "VERIFIED");
  assert.match(record.profileHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(record), /Must Not Appear|private@example/);
  const output = [];
  recordShadowEvaluation(record, value => output.push(value));
  assert.match(output[0], /^ECONPLANNER_DECISION_SHADOW /);
});

test("FULL is a named review state rather than an unexpected disagreement", async () => {
  const record = await runDecisionEngineShadow({
    student,
    plan: plan({ course: "ECO 113", section: "A", requirementId: "eco-113", source: "verified-offering" }),
    productionValidation: { valid: false, errors: ["ECO 113-A is closed in Fall 2026."] },
    bundle,
    source: "test"
  });
  assert.equal(record.classification, "KNOWN_REVIEW_STATE");
  assert.equal(record.engineStatus, "REVIEW_REQUIRED");
  assert.equal(record.unexpected, false);
});

test("unapproved production accepts and blocks are classified RED", () => {
  const engineBlock = { academicallyValid: false, decisions: [] };
  assert.equal(classifyShadowDisagreement({ valid: true }, engineBlock), "UNEXPECTED_PRODUCTION_ACCEPT_ENGINE_BLOCK");
  const engineAllow = { academicallyValid: true, decisions: [] };
  assert.equal(classifyShadowDisagreement({ valid: false }, engineAllow), "UNEXPECTED_PRODUCTION_BLOCK_ENGINE_ACCEPT");
  assert.equal(classifyShadowDisagreement({ valid: false, errors: ["hard failure"] }, engineAllow), "UNEXPECTED_PRODUCTION_BLOCK_ENGINE_ACCEPT");
});

test("CP4 placement-context gaps are classified without weakening production blocks", () => {
  const engineAllow = { academicallyValid: true, decisions: [] };
  assert.equal(classifyShadowDisagreement({ valid: false, errors: ["The plan differs from the canonical verified schedule."] }, engineAllow), "KNOWN_SCHEDULE_INTEGRITY_DIFFERENCE");
  assert.equal(classifyShadowDisagreement({ valid: false, errors: ["A course falls outside the graduation planning horizon."] }, engineAllow), "KNOWN_PLANNING_CONTEXT_DIFFERENCE");
  assert.equal(classifyShadowDisagreement({ valid: false, errors: ["The term differs from authoritative projected standing."] }, engineAllow), "KNOWN_PLANNING_CONTEXT_DIFFERENCE");
});
