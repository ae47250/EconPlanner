import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import ajvPackage from "ajv/package.json" with { type: "json" };
import { sourceEvidenceSha256 } from "../lib/source-evidence-hash.js";

const repositoryRoot = new URL("../", import.meta.url);
const policyRoot = new URL("../policy/", import.meta.url);
const readJson = async relativePath => JSON.parse(await readFile(new URL(relativePath, repositoryRoot), "utf8"));

const schemaPaths = [
  "policy/schema/policy-record.v1.schema.json",
  "policy/schema/policy-manifest.v1.schema.json",
  "policy/schema/schedule-release.v1.schema.json",
  "policy/schema/offering-pattern.v1.schema.json",
  "policy/schema/approval-instance.v1.schema.json",
  "policy/schema/message-catalog.v1.schema.json"
];

const manifestPath = "policy/manifest/econ-2025-2026.1.json";
const manifest = await readJson(manifestPath);
const provenance = await readJson("policy/provenance/sources.json");
const courses = await readJson("policy/courses/economics.json");
const messages = await readJson("policy/messages/en-US.json");
const unresolved = await readJson("policy/unresolved/policy-questions.json");

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date", /^\d{4}-\d{2}-\d{2}$/);
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);

const schemas = new Map();
for (const schemaPath of schemaPaths) {
  const schema = await readJson(schemaPath);
  schemas.set(schemaPath, schema);
  ajv.addSchema(schema);
}

function validateOrExplain(schemaPath, data, label) {
  const validate = ajv.getSchema(schemas.get(schemaPath).$id);
  assert.ok(validate, `compiled schema ${schemaPath}`);
  assert.equal(validate(data), true, `${label}: ${ajv.errorsText(validate.errors, { separator: "\n" })}`);
}

const policyDocuments = [];
for (const input of manifest.inputs) {
  const data = await readJson(input.path);
  if (input.schema) validateOrExplain(input.schema, data, input.path);
  if (input.schema === "policy/schema/policy-record.v1.schema.json") {
    policyDocuments.push({ path: input.path, data });
  }
}

const activeRules = policyDocuments.flatMap(document => document.data.records);
const rulesById = new Map(activeRules.map(rule => [rule.ruleId, rule]));
const unresolvedById = new Map(unresolved.questions.map(question => [question.ruleId, question]));
const sourceIds = new Set(provenance.sources.map(source => source.sourceId));
const messageKeys = new Set(Object.keys(messages.messages));

test("CP1 uses the required direct Ajv 8.20.0 dependency and compiles every Draft 2020-12 schema", () => {
  assert.equal(ajvPackage.version, "8.20.0");
  assert.equal(schemas.size, 6);
  for (const schema of schemas.values()) assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");

  const approvalSchema = "policy/schema/approval-instance.v1.schema.json";
  validateOrExplain(approvalSchema, {
    approvalId: "fixture-approval",
    schemaVersion: "1.0.0",
    ruleId: "CONCURRENT-INTERMEDIATE-ECO-461",
    scope: { studentRefHash: "a".repeat(64), course: "ECO 461", termId: "2027-WINTER", requirementId: null },
    authority: "ECONOMICS_DEPARTMENT",
    authorityBoundary: "ECO_461_INTERMEDIATE_CONCURRENCY",
    evidenceRef: "fixture-evidence",
    effectiveDate: "2026-08-05",
    expirationDate: null,
    status: "APPROVED",
    modifiedCondition: "One intermediate may be concurrent.",
    recordedBy: "fixture recorder",
    recordedAt: "2026-08-05T00:00:00Z",
    auditHistory: []
  }, "approval fixture");
});

test("the manifest declares every handwritten policy input", async () => {
  validateOrExplain("policy/schema/policy-manifest.v1.schema.json", manifest, manifestPath);
  assert.equal(manifest.policyVersion, "econ-2025-2026.1");
  assert.equal(manifest.status, "DRAFT");
  assert.deepEqual(manifest.catalogApplicability, ["2025-2026"]);
  assert.equal(new Set(manifest.inputs.map(input => input.id)).size, manifest.inputs.length);
  assert.equal(new Set(manifest.inputs.map(input => input.path)).size, manifest.inputs.length);
  for (const input of manifest.inputs) await access(new URL(input.path, repositoryRoot));
});

test("canonical sources have unique IDs, readable paths, matching hashes, and declared authority boundaries", async () => {
  assert.equal(sourceIds.size, provenance.sources.length);
  assert.equal(provenance.authorityHierarchy.length, 11);

  for (const source of provenance.sources) {
    assert.ok(source.authority, source.sourceId);
    assert.ok(source.authorityBoundary, source.sourceId);
    assert.match(source.effective.from, /^\d{4}-\d{2}-\d{2}$/, source.sourceId);
    if (!source.path) continue;
    const bytes = await readFile(new URL(source.path, repositoryRoot));
    assert.equal(sourceEvidenceSha256(bytes, source.path), source.sha256, source.sourceId);
  }
});

test("all active rules have unique stable IDs, complete metadata, resolvable sources, messages, and dependencies", () => {
  assert.ok(activeRules.length >= 50, `expected at least 50 canonical rules, found ${activeRules.length}`);
  assert.equal(rulesById.size, activeRules.length);

  for (const rule of activeRules) {
    assert.equal(rule.status, "ACTIVE", rule.ruleId);
    assert.ok(rule.sourceRefs.length > 0, rule.ruleId);
    assert.ok(rule.testRefs.positive.length + rule.testRefs.negative.length > 0, rule.ruleId);
    for (const sourceRef of rule.sourceRefs) {
      assert.ok(sourceIds.has(sourceRef.split("#")[0]), `${rule.ruleId}: ${sourceRef}`);
    }
    for (const messageKey of Object.values(rule.messageKeys)) {
      assert.ok(messageKeys.has(messageKey), `${rule.ruleId}: ${messageKey}`);
    }
    for (const dependency of rule.dependencies) {
      assert.ok(rulesById.has(dependency) || unresolvedById.has(dependency), `${rule.ruleId}: ${dependency}`);
    }
  }
});

test("the canonical course and requirement inventory covers the approved Economics model", () => {
  const courseCodes = courses.courses.map(course => course.code);
  assert.equal(courseCodes.length, 31);
  assert.equal(new Set(courseCodes).size, courseCodes.length);
  assert.ok(courseCodes.includes("ECO 257"));
  assert.ok(courseCodes.includes("MAT 217"));
  assert.ok(courseCodes.includes("PSY 217"));

  const requirementIds = [
    "REQ-MAJOR-COURSE-COUNT", "REQ-COGNATE-COURSE-COUNT", "REQ-ECO-113", "REQ-ECO-114",
    "REQ-ECO-213", "REQ-ECO-214", "REQ-STATISTICS", "REQ-FINANCE", "REQ-ECO-461",
    "REQ-COGNATE", "REQ-ECO-ELECTIVES"
  ];
  for (const ruleId of requirementIds) assert.ok(rulesById.has(ruleId), ruleId);
  assert.equal(rulesById.get("REQ-MAJOR-COURSE-COUNT").effect.totalCourseCount, 12);
  assert.equal(rulesById.get("REQ-ECO-ELECTIVES").effect.slotCount, 4);
});

test("all sixteen prerequisite records and four approval boundaries are canonical", () => {
  const prerequisiteRules = activeRules.filter(rule => rule.ruleType === "coursePrerequisite");
  assert.equal(prerequisiteRules.length, 16);
  assert.deepEqual(rulesById.get("PREREQ-ECO-461").effect.oneOfGroups, [["ECO 257", "MAT 217", "PSY 217"]]);
  assert.equal(rulesById.get("PREREQ-ECO-335").effect.equivalencyReviewRule, "REVIEW-ECO-335-MATH-EQUIVALENT");

  for (const ruleId of ["CONCURRENT-MATH-ECO-213", "CONCURRENT-MATH-ECO-214", "CONCURRENT-INTERMEDIATE-ECO-461", "PERMISSION-ECO-357"]) {
    const rule = rulesById.get(ruleId);
    assert.equal(rule.ruleType, "permissionException", ruleId);
    assert.ok(rule.authority.boundary, ruleId);
    assert.ok(rule.requiredEvidence.length > 0, ruleId);
  }
});

test("approved conflict dispositions are explicit and no unresolved record silently enforces", () => {
  const pattern = rulesById.get("PLANNING-INTERMEDIATE-OFFERING-SEPARATION")
    || JSON.parse("null");
  const offeringPatterns = manifest.inputs.find(input => input.id === "offering-patterns");
  assert.ok(offeringPatterns);

  const load = rulesById.get("PLANNING-ECO-LOAD-PREFERENCE");
  assert.equal(load.classification, "SOFT");
  assert.equal(load.disposition, "PREFER");
  assert.equal(load.effect.graduationNeedMayUseTotalTermCapacity, true);

  const eco257 = rulesById.get("ELECTIVE-ECO-257-STATISTICS-ONLY");
  assert.deepEqual(eco257.effect.allowedRequirementRuleIds, ["REQ-STATISTICS"]);
  assert.deepEqual(eco257.effect.excludedRequirementRuleIds, ["REQ-ECO-ELECTIVES"]);
  assert.equal(eco257.effect.advisorOverridePermitted, false);
  assert.equal(eco257.confirmation.date, "2026-08-05");
  assert.equal(eco257.authority.kind, "OWNER_CONFIRMATION");

  assert.equal(rulesById.get("TERM-CANONICAL-MAY").effect.canonicalTerm, "MAY");
  assert.equal(rulesById.get("TERM-CANONICAL-MAY").effect.displayLabel, "Spring/May");
  assert.equal(rulesById.get("HISTORY-COMPLETED-ADVANCED-PRESERVED").effect.preserveCourseFact, true);
  assert.equal(rulesById.get("HISTORY-COMPLETED-ADVANCED-PRESERVED").effect.decision, "REVIEW_REQUIRED");
  assert.equal(rulesById.get("PLANNING-UNPUBLISHED-OFFERINGS-PRELIMINARY").effect.inventedExactTermPermitted, false);
  assert.equal(rulesById.get("SCHEDULE-AVAILABILITY-BEHAVIOR").effect.FULL, "REVIEW_REQUIRED");
  assert.equal(rulesById.get("SCHEDULE-AVAILABILITY-BEHAVIOR").effect.absenceWithoutCompleteCoverage, "UNKNOWN");
  assert.equal(pattern, null, "offering pattern belongs only in the separately governed pattern document");

  for (const question of unresolved.questions) {
    assert.equal(question.status, "REVIEW_REQUIRED", question.ruleId);
    assert.equal(rulesById.has(question.ruleId), false, `${question.ruleId} must not be an active enforcing record`);
  }
});

test("offering patterns project only unpublished years and exact schedules preserve distinct evidence dimensions", async () => {
  const patterns = await readJson("policy/offering-patterns/economics.json");
  const pattern = patterns.patterns.find(entry => entry.patternId === "PLANNING-INTERMEDIATE-OFFERING-SEPARATION");
  assert.deepEqual(pattern.course, ["ECO 213", "ECO 214"]);
  assert.equal(pattern.projectionGranularity, "ACADEMIC_YEAR_TBC");
  assert.equal(pattern.projectionPolicy.universalSameTermProhibition, false);
  assert.equal(pattern.projectionPolicy.activeExactScheduleOverrides, true);

  const schedule = await readJson("policy/schedules/2026-2027.json");
  assert.equal(schedule.releaseStatus, "ACTIVE");
  assert.deepEqual(schedule.terms.map(term => term.canonicalTerm), ["FALL", "WINTER", "MAY", "SUMMER"]);
  assert.equal(schedule.terms.find(term => term.canonicalTerm === "MAY").displayLabel, "Spring/May 2027");
  assert.equal(schedule.terms.flatMap(term => term.sections).length, 17);
  assert.equal(schedule.terms.find(term => term.canonicalTerm === "SUMMER").coverage, "UNAVAILABLE");
  assert.equal(schedule.terms.flatMap(term => term.sections).filter(section => section.enrollmentState === "FULL").length, 2);
  for (const section of schedule.terms.flatMap(term => term.sections)) {
    assert.equal(section.offeringExistence, "OFFERED");
    assert.ok(section.enrollmentState);
    assert.ok(section.sourceRefs.length > 0);
  }
});

test("the August 5 owner confirmation is preserved in both governed provenance records", async () => {
  const source = provenance.sources.find(entry => entry.sourceId === "OWNER-ECO257-2026-08-05");
  assert.equal(source.confirmedOn, "2026-08-05");
  assert.equal(source.reviewer, "Project owner and Economics Department domain expert");
  assert.match(source.locator, /Current Codex thread/);
  assert.match(source.statement, /must never count as an Economics elective/);

  const sourceManifest = await readJson("data/manifests/source-manifest.json");
  const entry = sourceManifest.entries.find(candidate => candidate.source === "codex-thread:owner-confirmation-2026-08-05#eco-257-statistics-only");
  assert.ok(entry);
  assert.equal(entry.contentSha256, createHash("sha256").update(entry.statement, "utf8").digest("hex"));
  assert.equal(entry.reviewedBy, "Project owner and Economics Department domain expert");
});

test("the compiled bundle does not switch runtime authority", async () => {
  const runtimePaths = [
    "lib/catalog/load.js", "lib/assignment/solve.js", "lib/planning/economics.js",
    "app/api/majors/map/route.js", "lib/reports/build-economics.js"
  ];
  for (const runtimePath of runtimePaths) {
    const contents = await readFile(new URL(runtimePath, repositoryRoot), "utf8");
    assert.doesNotMatch(contents, /policy\/manifest|data\/compiled\/policy|load-bundle/iu, runtimePath);
  }
  await access(new URL("data/compiled/policy/active.json", repositoryRoot));
  assert.ok(fileURLToPath(policyRoot).endsWith(`${process.platform === "win32" ? "\\" : "/"}policy${process.platform === "win32" ? "\\" : "/"}`));
});
