import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "../lib/policy/canonical-json.js";
import { loadPolicyBundle } from "../lib/policy/load-bundle.js";
import { loadCanonicalPolicy } from "./oracle/load-canonical-policy.js";

const [source, bundle] = await Promise.all([
  loadCanonicalPolicy(),
  loadPolicyBundle()
]);

test("the CP4 active bundle loads without a shadow-mode override", async () => {
  assert.equal((await loadPolicyBundle({ useCache: false })).activationStatus, "ACTIVE");
});

test("the independent canonical loader projects every active source rule into the bundle", () => {
  assert.equal(canonicalJson(source.rules), canonicalJson(bundle.rules));
  assert.equal(source.rules.length, 58);
  assert.deepEqual(source.rules.map(rule => rule.ruleId), Object.keys(bundle.indexes.byRuleId).sort());
});

test("canonical courses, schedule, patterns, messages, provenance, and review records survive compilation", () => {
  assert.equal(canonicalJson(Object.fromEntries(source.courses.map(course => [course.code, course]))), canonicalJson(bundle.indexes.coursesByCode));
  assert.equal(canonicalJson(Object.fromEntries(source.offeringPatterns.map(pattern => [pattern.patternId, pattern]))), canonicalJson(bundle.indexes.offeringPatternsById));
  assert.equal(canonicalJson(source.messages), canonicalJson(bundle.messages));
  assert.equal(canonicalJson(source.provenance.sources), canonicalJson(bundle.provenance.sources));
  assert.equal(canonicalJson(source.unresolved), canonicalJson(bundle.unresolved));
  assert.deepEqual(source.schedule.terms.map(term => term.termId).sort(), Object.keys(bundle.indexes.offeringByTerm).sort());
});
