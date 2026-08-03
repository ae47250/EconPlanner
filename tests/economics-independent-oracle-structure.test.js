import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { auditExternalEconomicsPlan } from "./oracle/audit-external-plan.js";
import { createExternalPlanSemanticSignature } from "./oracle/plan-signature.js";

const policy = JSON.parse(await readFile(
  new URL("./oracle/economics-policy.v1.json", import.meta.url),
  "utf8"
));
const verifiedSchedule = JSON.parse(await readFile(
  new URL("./oracle/verified-schedule-2026-2027.json", import.meta.url),
  "utf8"
));

async function fixture(name) {
  return JSON.parse(await readFile(
    new URL(`./fixtures/economics-oracle-plans/${name}.json`, import.meta.url),
    "utf8"
  ));
}

function auditFixture(value) {
  return auditExternalEconomicsPlan({
    student: value.student,
    plan: value.plan,
    expectedContext: value.expectedContext,
    policy,
    verifiedSchedule
  });
}

test("independent oracle files have no prohibited production imports", async () => {
  const files = await Promise.all([
    readFile(new URL("./oracle/audit-external-plan.js", import.meta.url), "utf8"),
    readFile(new URL("./oracle/plan-signature.js", import.meta.url), "utf8")
  ]);
  const prohibited = /(?:from\s+|import\s*\()[^;\n]*(?:lib[\\/](?:planning|assignment|requirements)|normalizeEconomicsSchedule|scheduleProvider|data[\\/]normalized[\\/]economics[\\/]schedule)/i;

  for (const source of files) assert.equal(prohibited.test(source), false);
});

test("structurally valid input remains NOT_CHECKED until required rule families exist", async () => {
  const value = await fixture("valid-balanced-plan");
  const result = auditFixture(value);

  assert.equal(value.authorship, "handwritten");
  assert.equal(result.valid, false);
  assert.equal(result.status, "NOT_CHECKED");
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.checkedRuleFamilies.map(item => item.status), Array(5).fill("CHECKED"));
  assert.deepEqual(result.uncheckedRuleFamilies, [
    { family: "REQUIREMENT_ALLOCATION", status: "NOT_CHECKED" },
    { family: "PREREQUISITES", status: "NOT_CHECKED" },
    { family: "SCHEDULE", status: "NOT_CHECKED" },
    { family: "CAPACITY", status: "NOT_CHECKED" },
    { family: "GRADUATION_RULES", status: "NOT_CHECKED" }
  ]);
  assert.equal(result.reviewItems.length, result.uncheckedRuleFamilies.length);
  assert.match(result.semanticSignature, /^econ-plan-semantic-v1:[0-9a-f]{64}$/);
});

test("semantic signature ignores object-key and within-term course ordering", async () => {
  const original = await fixture("valid-balanced-plan");
  const reordered = await fixture("valid-balanced-plan-reordered");
  const originalSignature = createExternalPlanSemanticSignature(original.plan, original.expectedContext);
  const reorderedSignature = createExternalPlanSemanticSignature(reordered.plan, reordered.expectedContext);

  assert.equal(originalSignature, reorderedSignature);
  assert.equal(auditFixture(original).semanticSignature, auditFixture(reordered).semanticSignature);
});

test("materially different plan contents produce a different signature", async () => {
  const original = await fixture("valid-balanced-plan");
  const different = await fixture("valid-materially-different-plan");

  assert.notEqual(
    createExternalPlanSemanticSignature(original.plan, original.expectedContext),
    createExternalPlanSemanticSignature(different.plan, different.expectedContext)
  );
});

test("handwritten malformed fixtures produce their stable structural violation codes", async () => {
  const cases = [
    ["malformed-plan", ["PLAN_TERMS_REQUIRED"]],
    ["duplicate-term-plan", ["DUPLICATE_TERM_IDENTITY"]],
    ["duplicate-slot-plan", ["DUPLICATE_SLOT_ID"]],
    ["out-of-order-term-plan", ["TERM_ORDER_INVALID"]],
    ["malformed-horizon-plan", ["HORIZON_YEAR_COUNT_MISMATCH", "HORIZON_GRADUATION_TERM_MISMATCH"]],
    ["malformed-academic-year-plan", ["ACADEMIC_YEAR_MALFORMED"]],
    ["malformed-course-entry-plan", [
      "COURSE_CODE_REQUIRED",
      "COURSE_REQUIREMENT_ID_REQUIRED",
      "COURSE_SECTION_MALFORMED"
    ]],
    ["duplicate-course-entry-plan", ["DUPLICATE_COURSE_ENTRY"]]
  ];

  for (const [name, expectedCodes] of cases) {
    const value = await fixture(name);
    const result = auditFixture(value);
    const codes = result.violations.map(item => item.code);

    assert.equal(value.authorship, "handwritten", name);
    assert.equal(result.valid, false, name);
    assert.equal(result.status, "INVALID_STRUCTURE", name);
    for (const code of expectedCodes) assert.ok(codes.includes(code), `${name}: ${code}`);
    for (const violation of result.violations) {
      assert.ok(violation.code, name);
      assert.ok(violation.ruleId, name);
      assert.match(violation.objectPath, /^\$/u, name);
      assert.ok(violation.message, name);
      assert.ok(Object.hasOwn(violation, "sourceReference"), name);
    }
  }
});

test("missing external input objects fail with stable input-shape codes", () => {
  const result = auditExternalEconomicsPlan(null);
  assert.equal(result.valid, false);
  assert.equal(result.status, "INVALID_STRUCTURE");
  assert.deepEqual(result.violations.map(item => item.code), [
    "INPUT_NOT_OBJECT",
    "STUDENT_REQUIRED",
    "PLAN_REQUIRED",
    "EXPECTED_CONTEXT_REQUIRED",
    "POLICY_REQUIRED",
    "VERIFIED_SCHEDULE_REQUIRED"
  ]);
});
