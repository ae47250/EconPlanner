import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {POST} from "../app/api/majors/map/route.js";
import {
  CATALOG_APPLICABILITY_STATUS,
  resolveCatalogApplicability,
  UNKNOWN_DECLARATION_CATALOG_YEAR
} from "../lib/catalog/applicability.js";
import {compareCatalogPolicyRecords} from "../lib/catalog/compare.js";
import {
  catalogPolicyRecords,
  loadCatalogPolicyReleases
} from "../lib/catalog/policy-releases.js";
import {
  resolveInputResolution,
  validateSubmittedCatalogYear
} from "../lib/catalog/input-resolution.js";
import {auditStudentHistory} from "../lib/decision-engine/student-history.js";
import {runtimePolicyBundle} from "../lib/policy/compat-normalized.js";
import {compileCatalogPolicies} from "../scripts/compile-catalog-policies.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const YEARS = ["2023-2024", "2024-2025", "2025-2026"];

function requestFor(student) {
  return new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({student})
  });
}

test("governed historical releases preserve the authoritative flexibility sequence", () => {
  const records = catalogPolicyRecords();
  assert.deepEqual(records.map(record => record.catalogYear), YEARS);
  const [year2023, year2024, year2025] = records;
  assert.deepEqual(year2023.requirements.statisticsOptions, ["ECO 257", "MAT 217"]);
  assert.ok(year2024.requirements.statisticsOptions.includes("PSY 217"));
  assert.deepEqual(year2024.requirements.moneyFinanceOptions, ["ECO 321"]);
  assert.ok(year2025.requirements.moneyFinanceOptions.includes("BUSN 323"));
  assert.equal(year2023.nonCourseMilestones[0].status, "REQUIRED");
  assert.equal(year2024.nonCourseMilestones[0].status, "NOT_LISTED");
  assert.equal(year2025.nonCourseMilestones[0].status, "NOT_LISTED");
  assert.ok(records.every(record => record.allocation["ECO 257"].length === 1 && record.allocation["ECO 257"][0] === "statistics"));
  assert.ok(records.every(record => record.collegeWideBoundary.changedByFlexibleMajorRule === false));
});

test("unknown declaration year uses latest flexible requirements conditionally without advisor-action readiness", () => {
  const applicability = resolveCatalogApplicability({
    majorDeclarationCatalogYear: UNKNOWN_DECLARATION_CATALOG_YEAR,
    entryCatalogYear: "2023-2024",
    currentCatalogYear: "2026-2027",
    availableCatalogYears: YEARS
  });
  assert.equal(applicability.status, CATALOG_APPLICABILITY_STATUS.LATEST_FLEXIBLE_FALLBACK);
  assert.equal(applicability.submittedDeclarationCatalogYear, UNKNOWN_DECLARATION_CATALOG_YEAR);
  assert.deepEqual(applicability.evaluatedCatalogYears, YEARS);
  assert.equal(applicability.appliedMajorCatalogYear, "2025-2026");
  assert.equal(applicability.latestAvailableCatalogYear, "2025-2026");
  assert.equal(applicability.requiresAdvisorConfirmation, true);
  assert.equal(applicability.advisorAction, null);
  assert.equal(applicability.advisorNotice.reasonCode, "LATEST_FLEXIBLE_MAJOR_RULES_APPLIED");
  assert.ok(applicability.materialDifferences.some(item => item.code === "PSY_217_STATISTICS_OPTION_ADDED"));
  assert.ok(applicability.materialDifferences.some(item => item.code === "BUSN_323_MONEY_FINANCE_OPTION_ADDED"));
  assert.ok(applicability.materialDifferences.some(item => item.code === "ECONOMICS_COMPREHENSIVE_EVALUATION_CHANGED"));
});

test("known older catalog preserves both evaluations and supports explicit approval", () => {
  const fallback = resolveCatalogApplicability({
    majorDeclarationCatalogYear: "2023-2024",
    currentCatalogYear: "2026-2027",
    availableCatalogYears: YEARS
  });
  assert.equal(fallback.status, "LATEST_FLEXIBLE_FALLBACK");
  assert.equal(fallback.originalCatalogYear, "2023-2024");
  assert.deepEqual(fallback.evaluatedCatalogYears, ["2023-2024", "2025-2026"]);
  assert.equal(fallback.evaluations.length, 2);
  const approved = resolveCatalogApplicability({
    majorDeclarationCatalogYear: "2023-2024",
    availableCatalogYears: YEARS,
    latestFlexibleApprovalStatus: "APPROVED"
  });
  assert.equal(approved.status, "LATEST_FLEXIBLE_APPROVED");
  assert.equal(approved.requiresAdvisorConfirmation, false);
});

test("a stricter latest record produces a material conflict instead of silent selection", () => {
  const records = structuredClone(catalogPolicyRecords());
  const latest = records.find(record => record.catalogYear === "2025-2026");
  latest.requirements.statisticsOptions = ["ECO 257"];
  const applicability = resolveCatalogApplicability({
    majorDeclarationCatalogYear: "2024-2025",
    availableCatalogYears: YEARS,
    catalogRecords: records
  });
  assert.equal(applicability.status, "AMBIGUOUS_MATERIAL_CONFLICT");
  assert.equal(applicability.appliedMajorCatalogYear, "2024-2025");
  assert.equal(applicability.advisorAction.reasonCode, "AMBIGUOUS_MATERIAL_CATALOG_CONFLICT");
});

test("missing 2026-2027 is preserved and never invented", () => {
  const applicability = resolveCatalogApplicability({
    majorDeclarationCatalogYear: "2026-2027",
    availableCatalogYears: YEARS
  });
  assert.equal(applicability.status, "LATEST_FLEXIBLE_FALLBACK");
  assert.equal(applicability.requestedUnavailableCatalogYear, "2026-2027");
  assert.equal(applicability.appliedMajorCatalogYear, "2025-2026");
  assert.ok(!loadCatalogPolicyReleases().releases.some(release => release.catalogYear === "2026-2027"));
});

test("catalog comparison classifies known changes as flexible", () => {
  const [year2023,, year2025] = catalogPolicyRecords();
  const result = compareCatalogPolicyRecords(year2023, year2025);
  assert.equal(result.status, "more_flexible");
  assert.equal(result.unfavorable.length, 0);
  assert.deepEqual(result.favorable.map(item => item.code).sort(), [
    "BUSN_323_MONEY_FINANCE_OPTION_ADDED",
    "ECONOMICS_COMPREHENSIVE_EVALUATION_CHANGED",
    "PSY_217_STATISTICS_OPTION_ADDED"
  ]);
});

test("catalog intake validation preserves unknown and rejects unsupported values", () => {
  assert.deepEqual(validateSubmittedCatalogYear("I_DO_NOT_KNOW", YEARS), {
    valid: true,
    submittedValue: "I_DO_NOT_KNOW",
    normalizedYear: null,
    explicitlyUnknown: true
  });
  assert.equal(validateSubmittedCatalogYear("2022-2023", YEARS).valid, false);
  const applicability = resolveCatalogApplicability({majorDeclarationCatalogYear: "I_DO_NOT_KNOW", availableCatalogYears: YEARS});
  const resolution = resolveInputResolution({catalogApplicability: applicability});
  assert.equal(resolution.status, "RESOLVED_WITH_AUTHORIZED_DEFAULT");
  assert.equal(resolution.planningCanContinueConditionally, true);
  assert.equal(resolution.safeDefaultsApplied[0].kind, "CONDITIONAL_PLANNING_BASIS_NOT_STUDENT_FACT");
});

test("recoverable and contradictory input problems remain structured and blocked", () => {
  const recoverable = resolveInputResolution({
    student: {},
    planningContext: {projectedSeniorStandingAcademicYear: "2028/2029"},
    issueCode: "INVALID_PLANNING_PACE"
  });
  assert.equal(recoverable.status, "RECOVERABLE_MISSING_INFORMATION");
  assert.equal(recoverable.answerCount, 1);
  assert.equal(recoverable.planningMustRemainBlocked, true);
  const contradictory = resolveInputResolution({issueCode: "INVALID_STUDENT_PREREQUISITES", issues: [{course: "ECO 461"}]});
  assert.equal(contradictory.status, "CONTRADICTORY_INFORMATION");
  assert.equal(contradictory.advisorActionRequired, true);
  assert.equal(contradictory.planningMustRemainBlocked, true);
});

test("ordinary Hanover coursework loses false equivalency review while genuine transfer remains review-dependent", () => {
  const bundle = runtimePolicyBundle();
  const ordinary = auditStudentHistory({courses: [{code: "ECO 331", status: "completed", source: "manual_code"}]}, bundle);
  assert.ok(!ordinary.decisions.some(decision => decision.ruleIds.includes("REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE")));
  assert.ok(ordinary.decisions.some(decision => decision.reasonCode === "HISTORICAL_PREREQUISITE_EVIDENCE_REVIEW"));
  const transfer = auditStudentHistory({courses: [{code: "ECO 331", status: "transfer", source: "manual_code"}]}, bundle);
  assert.ok(transfer.decisions.some(decision => decision.ruleIds.includes("REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE")));
});

test("FULL remains review-required in the active production bundle", () => {
  const bundle = runtimePolicyBundle();
  assert.equal(bundle.indexes.byRuleId["SCHEDULE-AVAILABILITY-BEHAVIOR"].effect.FULL, "REVIEW_REQUIRED");
});

test("API preserves unknown input, applies latest flexible catalog, and emits one canonical notice", async () => {
  const response = await POST(requestFor({
    academicStanding: "senior",
    planCreationDate: "2026-09-01",
    majorDeclarationCatalogYear: "I_DO_NOT_KNOW",
    courses: []
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.catalog.submittedDeclarationCatalogYear, "I_DO_NOT_KNOW");
  assert.equal(body.catalog.appliedMajorCatalogYear, "2025-2026");
  assert.equal(body.inputResolution.planningCanContinueConditionally, true);
  assert.equal(body.catalog.advisorAttention.filter(item => item.code === "LATEST_FLEXIBLE_MAJOR_RULES_APPLIED").length, 1);
});

test("API evaluates a known older catalog and rejects a submitted unsupported year", async () => {
  const olderResponse = await POST(requestFor({
    academicStanding: "senior",
    planCreationDate: "2026-09-01",
    majorDeclarationCatalogYear: "2023-2024",
    courses: []
  }));
  const older = await olderResponse.json();
  assert.equal(olderResponse.status, 200);
  assert.equal(older.catalog.originalCatalogYear, "2023-2024");
  assert.equal(older.catalog.appliedMajorCatalogYear, "2025-2026");
  assert.ok(older.catalog.comparisonFindings.some(item => item.code === "PSY_217_STATISTICS_OPTION_ADDED"));
  const invalidResponse = await POST(requestFor({
    academicStanding: "senior",
    planCreationDate: "2026-09-01",
    majorDeclarationCatalogYear: "2022-2023",
    courses: []
  }));
  const invalid = await invalidResponse.json();
  assert.equal(invalidResponse.status, 422);
  assert.equal(invalid.code, "INVALID_CATALOG_INPUT");
  assert.equal(invalid.inputResolution.status, "UNSUPPORTED_INPUT");
});

test("minimal accessible intake is present and the browser contains no selection logic", async () => {
  const source = await readFile(path.join(ROOT, "app/page.js"), "utf8");
  assert.match(source, /htmlFor="major-declaration-catalog-year"/);
  assert.match(source, /id="major-declaration-catalog-year"/);
  assert.match(source, /value="I_DO_NOT_KNOW">I do not know/);
  assert.match(source, /Economics-major requirements normally depend on when you declared the major/);
  assert.doesNotMatch(source, /resolveCatalogApplicability/);
});

test("catalog policy compilation is byte-identical across three clean outputs and leaves active mapping unchanged", async () => {
  const activeBefore = await readFile(path.join(ROOT, "data/compiled/policy/active.json"), "utf8");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "econ-catalog-compiler-"));
  try {
    const outputs = [];
    for (let index = 1; index <= 3; index += 1) {
      const outputRoot = path.join(tempRoot, `run-${index}`);
      await compileCatalogPolicies({repositoryRoot: ROOT, outputRoot});
      outputs.push(await Promise.all([
        readFile(path.join(outputRoot, "catalog-releases.json"), "utf8"),
        ...["econ-catalog-2023-2024.1", "econ-catalog-2024-2025.1", "econ-catalog-2025-2026.2"]
          .map(version => readFile(path.join(outputRoot, "releases", version, "bundle.json"), "utf8"))
      ]));
    }
    assert.deepEqual(outputs[0], outputs[1]);
    assert.deepEqual(outputs[1], outputs[2]);
  } finally {
    await rm(tempRoot, {recursive: true, force: true});
  }
  const activeAfter = await readFile(path.join(ROOT, "data/compiled/policy/active.json"), "utf8");
  assert.equal(activeAfter, activeBefore);
});
