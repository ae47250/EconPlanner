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
  classifyPrerequisiteChange,
  economicsPlanningStrategyContract,
  loadCatalogPolicyReleases
} from "../lib/catalog/policy-releases.js";
import {
  resolveInputResolution,
  validateSubmittedCatalogYear
} from "../lib/catalog/input-resolution.js";
import {auditStudentHistory} from "../lib/decision-engine/student-history.js";
import {evaluatePrerequisites} from "../lib/decision-engine/prerequisites.js";
import {evaluateRequirementAllocation} from "../lib/decision-engine/requirements.js";
import {mapStudentToProgram} from "../lib/assignment/solve.js";
import {buildMajorRequirementsChecklist} from "../lib/planning/plan-presentation.js";
import {assessCoursePrerequisites} from "../lib/planning/prerequisiteEvaluator.js";
import {validateStudentPrerequisites} from "../lib/planning/prerequisiteValidation.js";
import {loadCatalog} from "../lib/catalog/load.js";
import {runtimePolicyBundle} from "../lib/policy/compat-normalized.js";
import {compileCatalogPolicies} from "../scripts/compile-catalog-policies.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const YEARS = ["2023-2024", "2024-2025", "2025-2026", "2026-2027"];

test("compiled planning-flexibility.7 is the runtime strategy source of truth", () => {
  const contract = economicsPlanningStrategyContract();
  assert.equal(contract.classification, "NONACADEMIC_PLANNING_AND_RANKING_PREFERENCES");
  assert.equal(contract.feasibilityImpact, "NONE");
  assert.deepEqual(contract.strategies.map(strategy => strategy.id), ["balanced", "explore-first", "one-year-early"]);
  const explore = contract.strategies.find(strategy => strategy.id === "explore-first");
  const balanced = contract.strategies.find(strategy => strategy.id === "balanced");
  assert.equal(balanced.rankingPreferences.annualRemainderPlacement, "LATEST_YEARS");
  assert.equal(balanced.rankingPreferences.annualCapacityBasis, "ACTUAL_REMAINING_USABLE_CAPACITY_AFTER_FIXED_AND_RESERVED_OCCUPANCY");
  assert.deepEqual(balanced.rankingPreferences.termShapePreferences.fourCourses, [[1, 2, 1], [2, 1, 1]]);
  assert.equal(balanced.rankingPreferences.termShapePreferences.springMayPreferredMaximum, 1);
  assert.equal(explore.publicLabel, "Explore the Major");
  assert.deepEqual(explore.eligibility.effectiveStandings, ["freshman", "sophomore"]);
  assert.equal(explore.rankingPreferences.firstYearTargetFormula, "MIN_BALANCED_MINUS_ONE_AND_FLOOR_TOTAL_OVER_YEARS");
  assert.deepEqual(explore.rankingPreferences.firstFullYearTwoCourseShapeTiers[0], [[1, 1, 0]]);
  assert.equal(explore.rankingPreferences.exactTargetIsFeasibilityRule, false);
  const oneYearEarly = contract.strategies.find(strategy => strategy.id === "one-year-early");
  assert.deepEqual(oneYearEarly.eligibility.effectiveStandings, ["freshman", "sophomore", "junior"]);
});

function requestFor(student) {
  return new Request("http://localhost/api/majors/map", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({student})
  });
}

test("API normalizes schedule-set state to the exact active drop/add term", async () => {
  const currentStudent = {
    academicStanding: "freshman",
    majorDeclarationCatalogYear: "2026-2027",
    planCreationDate: "2026-08-24",
    courses: [{code: "ECO 113", status: "in_progress"}],
    scheduleSetByTerm: {"fall-2026": true, "winter-2027": true}
  };
  const currentResponse = await POST(requestFor(currentStudent));
  const currentBody = await currentResponse.json();
  const currentEconomics = currentBody.programs.find(item => item.program.programId === "economics");
  assert.equal(currentResponse.status, 200);
  assert.equal(currentEconomics.planningContext.currentTermScheduleSet, true);
  assert.equal(currentEconomics.planningContext.currentTermPlanningWindow.slotId, "fall-2026");
  assert.ok(currentEconomics.economicsPlans.every(plan => (
    plan.terms.find(term => term.slotId === "fall-2026").courses.every(course => course.fixedInProgress)
  )));

  const staleResponse = await POST(requestFor({
    ...currentStudent,
    planCreationDate: "2026-08-29"
  }));
  const staleBody = await staleResponse.json();
  const staleEconomics = staleBody.programs.find(item => item.program.programId === "economics");
  assert.equal(staleResponse.status, 200);
  assert.equal(staleEconomics.planningContext.currentTermPlanningWindow, null);
  assert.equal(staleEconomics.planningContext.currentTermScheduleSet, false);
  assert.ok(staleEconomics.economicsPlans.every(plan => !plan.terms.some(term => term.slotId === "fall-2026")));
});

test("governed catalog releases preserve historical and current declaration-year sets", () => {
  const records = catalogPolicyRecords();
  assert.deepEqual(records.map(record => record.catalogYear), YEARS);
  const [year2023, year2024, year2025] = records;
  assert.deepEqual(year2023.requirements.statisticsOptions, ["ECO 257", "MAT 217"]);
  assert.ok(year2024.requirements.statisticsOptions.includes("PSY 217"));
  assert.deepEqual(year2024.requirements.moneyFinanceOptions, ["ECO 321"]);
  assert.ok(year2025.requirements.moneyFinanceOptions.includes("BUSN 323"));
  const year2026 = records.find(record => record.catalogYear === "2026-2027");
  assert.equal(year2026.requirements.majorCourseCount, 11);
  assert.deepEqual(year2026.requirements.statisticsOptions, ["ECO 257", "MAT 217", "PSY 217"]);
  assert.deepEqual(year2026.prerequisites["ECO 221"].any, [["ECO 113", "ECO 114", "ECO 161"]]);
  assert.ok(year2026.exceptions.some(item => item.alternative === "PSY 217"));
  assert.equal(year2023.nonCourseMilestones[0].status, "REQUIRED");
  assert.equal(year2024.nonCourseMilestones[0].status, "NOT_LISTED");
  assert.equal(year2025.nonCourseMilestones[0].status, "NOT_LISTED");
  assert.ok(records.every(record => record.allocation["ECO 257"].length === 1 && record.allocation["ECO 257"][0] === "statistics"));
  assert.ok(records.every(record => record.collegeWideBoundary.changedByFlexibleMajorRule === false));
});

test("unknown declaration stays preliminary instead of borrowing the entry catalog or a flexible default", () => {
  const applicability = resolveCatalogApplicability({
    majorDeclarationCatalogYear: UNKNOWN_DECLARATION_CATALOG_YEAR,
    entryCatalogYear: "2023-2024",
    currentCatalogYear: "2026-2027",
    availableCatalogYears: YEARS
  });
  assert.equal(applicability.status, CATALOG_APPLICABILITY_STATUS.DECLARATION_YEAR_REQUIRED);
  assert.equal(applicability.submittedDeclarationCatalogYear, UNKNOWN_DECLARATION_CATALOG_YEAR);
  assert.deepEqual(applicability.evaluatedCatalogYears, []);
  assert.equal(applicability.appliedMajorCatalogYear, null);
  assert.equal(applicability.latestAvailableCatalogYear, "2026-2027");
  assert.equal(applicability.requiresAdvisorConfirmation, true);
  assert.equal(applicability.advisorAction, null);
  assert.equal(applicability.preliminaryOnly, true);
});

test("verified older declaration selects its complete authorized catalog set", () => {
  const applicability = resolveCatalogApplicability({
    majorDeclarationCatalogYear: "2023-2024",
    currentCatalogYear: "2026-2027",
    availableCatalogYears: YEARS
  });
  assert.equal(applicability.status, CATALOG_APPLICABILITY_STATUS.OWNER_DESIGNATED_MATCH);
  assert.equal(applicability.originalCatalogYear, "2023-2024");
  assert.deepEqual(applicability.evaluatedCatalogYears, ["2023-2024"]);
  assert.equal(applicability.appliedMajorCatalogYear, "2023-2024");
});

test("newer catalog differences do not leak into an older declaration set", () => {
  const records = structuredClone(catalogPolicyRecords());
  const latest = records.find(record => record.catalogYear === "2025-2026");
  latest.requirements.statisticsOptions = ["ECO 257"];
  const applicability = resolveCatalogApplicability({
    majorDeclarationCatalogYear: "2024-2025",
    availableCatalogYears: YEARS,
    catalogRecords: records
  });
  assert.equal(applicability.status, CATALOG_APPLICABILITY_STATUS.OWNER_DESIGNATED_MATCH);
  assert.equal(applicability.appliedMajorCatalogYear, "2024-2025");
  assert.equal(applicability.advisorAction, null);
  assert.equal(applicability.advisorNotice, null);
});

test("2026-2027 declaration resolves to its registered authoritative release", () => {
  const applicability = resolveCatalogApplicability({
    majorDeclarationCatalogYear: "2026-2027",
    availableCatalogYears: YEARS
  });
  assert.equal(applicability.status, CATALOG_APPLICABILITY_STATUS.OWNER_DESIGNATED_MATCH);
  assert.equal(applicability.requestedUnavailableCatalogYear, null);
  assert.equal(applicability.appliedMajorCatalogYear, "2026-2027");
  assert.ok(loadCatalogPolicyReleases().releases.some(release => release.catalogYear === "2026-2027"));
});

test("course prerequisites follow enrollment term independently of major declaration year", async () => {
  const catalog = await loadCatalog("2024-2025");
  const currentRule = assessCoursePrerequisites({
    code: "ECO 221",
    term: {academicYear: "2026/2027"},
    beforeTerm: new Set(["ECO 161"]),
    prerequisites: catalog.economicsPrerequisites
  });
  const historicalRule = assessCoursePrerequisites({
    code: "ECO 221",
    term: {academicYear: "2025/2026"},
    beforeTerm: new Set(["ECO 161"]),
    prerequisites: catalog.economicsPrerequisites
  });
  assert.equal(currentRule.valid, true);
  assert.equal(historicalRule.valid, false);

  const currentCapstone = assessCoursePrerequisites({
    code: "ECO 461",
    term: {academicYear: "2026/2027"},
    beforeTerm: new Set(["ECO 213", "ECO 214", "PSY 217"]),
    prerequisites: catalog.economicsPrerequisites
  });
  assert.equal(currentCapstone.valid, true);
});

test("Decision Engine uses the enrollment-year ECO 221 rule and records its catalog release", () => {
  const bundle = runtimePolicyBundle();
  const decide = academicYear => evaluatePrerequisites(
    {course: "ECO 221"}, {academicYear, term: "Fall"}, {}, bundle,
    {availableCourses: new Set(["ECO 161"])}
  );
  assert.equal(decide("2025-2026").status, "BLOCK");
  const current = decide("2026-2027");
  assert.equal(current.status, "ALLOW");
  assert.equal(current.governingCatalogRelease.catalogYear, "2026-2027");
  const capstone = evaluatePrerequisites(
    {course: "ECO 461"}, {academicYear: "2026-2027", term: "Winter"}, {}, bundle,
    {availableCourses: new Set(["ECO 213", "ECO 214", "PSY 217"])}
  );
  assert.equal(capstone.status, "ALLOW");
});

test("stricter rules apply and mixed prerequisite changes require review", () => {
  assert.equal(classifyPrerequisiteChange(
    {all: [], any: [["ECO 113", "ECO 114"]]},
    {all: ["ECO 113"], any: []}
  ), "STRICTER");
  assert.equal(classifyPrerequisiteChange(
    {all: ["ECO 113"], any: []},
    {all: ["ECO 114"], any: []}
  ), "MIXED_REVIEW_REQUIRED");
});

test("an older major set rejects newer isolated options and retains its comprehensive evaluation", async () => {
  const bundle = runtimePolicyBundle();
  const decision = evaluateRequirementAllocation({course: "PSY 217"}, "statistics", {}, bundle, {majorCatalogYear: "2023-2024"});
  assert.equal(decision.status, "BLOCK");
  assert.equal(decision.governingCatalogRelease.catalogYear, "2023-2024");
  const catalog = await loadCatalog("2023-2024");
  const program = catalog.programs.find(item => item.id === "economics");
  const mapping = mapStudentToProgram(program, catalog.requirementsByProgram.get("economics"), {courses: []}, {policyBundle: bundle});
  const checklist = buildMajorRequirementsChecklist({mapping});
  assert.ok(checklist.rows.some(row => row.id === "ECONOMICS-COMPREHENSIVE-EVALUATION" && row.status === "still_needed"));
});

test("a 2024-2025 major never proposes a finance preference outside its complete set", async () => {
  const catalog = await loadCatalog("2024-2025");
  const finance = catalog.economicsRequirements.requirementSlots.find(slot => slot.id === "finance");
  assert.deepEqual(finance.options, ["ECO 321"]);
  assert.ok(finance.preferredOptions.every(course => finance.options.includes(course)));
});

test("completed historical courses are retained while in-progress courses use term rules", () => {
  const completed = validateStudentPrerequisites([
    {code: "ECO 221", status: "completed"}
  ], {"ECO 221": {all: ["ECO 113"], any: []}});
  assert.equal(completed.valid, true);
});

test("pending records cannot override an authorized declaration set", () => {
  const records = structuredClone(catalogPolicyRecords());
  const pending = records.find(record => record.catalogYear === "2025-2026");
  pending.activationStatus = "PENDING_OWNER_APPROVAL";
  pending.requirements.statisticsOptions = ["INVALID OPTION"];
  const applicability = resolveCatalogApplicability({
    majorDeclarationCatalogYear: "2026-2027",
    entryCatalogYear: "2024-2025",
    availableCatalogYears: YEARS,
    catalogRecords: records
  });
  assert.equal(applicability.appliedMajorCatalogYear, "2026-2027");
  assert.equal(applicability.evaluatedCatalogYears.length, 1);
  const pendingSelection = resolveCatalogApplicability({majorDeclarationCatalogYear: "2025-2026", availableCatalogYears: YEARS, catalogRecords: records});
  assert.equal(pendingSelection.appliedMajorCatalogYear, null);
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
  assert.equal(resolution.status, "RECOVERABLE_MISSING_INFORMATION");
  assert.equal(resolution.planningCanContinueConditionally, false);
  assert.equal(resolution.planningMustRemainBlocked, true);
  assert.equal(resolution.missingCatalogYearIsOnlyBlocker, true);
});

test("recoverable and contradictory input problems remain structured and blocked", () => {
  const missingPlanDate = resolveInputResolution({issueCode: "MISSING_PLAN_CREATION_DATE"});
  assert.equal(missingPlanDate.status, "RECOVERABLE_MISSING_INFORMATION");
  assert.deepEqual(missingPlanDate.blockingFields, ["planCreationDate"]);
  assert.deepEqual(missingPlanDate.questions, [{
    field: "planCreationDate",
    prompt: "What date should this plan use?"
  }]);
  assert.equal(missingPlanDate.planningMustRemainBlocked, true);

  const recoverable = resolveInputResolution({
    student: {},
    planningContext: {projectedSeniorStandingAcademicYear: "2028/2029"},
    issueCode: "INVALID_PLANNING_PACE"
  });
  assert.equal(recoverable.status, "UNSUPPORTED_INPUT");
  assert.equal(recoverable.answerCount, 1);
  assert.deepEqual(recoverable.blockingFields, ["planningPace"]);
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

test("API leaves unknown declaration preliminary and asks for the formal declaration catalog", async () => {
  const response = await POST(requestFor({
    academicStanding: "senior",
    planCreationDate: "2026-09-01",
    majorDeclarationCatalogYear: "I_DO_NOT_KNOW",
    courses: []
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.code, "MAJOR_DECLARATION_YEAR_REQUIRED");
  assert.equal(body.selectedCatalogYear, null);
  assert.equal(body.inputResolution.planningCanContinueConditionally, false);
  assert.equal(body.inputResolution.planningMustRemainBlocked, true);
  assert.equal(body.inputResolution.advisorActionRequired, true);
});

test("API applies an authorized older catalog and rejects a submitted unsupported year", async () => {
  const olderResponse = await POST(requestFor({
    academicStanding: "senior",
    planCreationDate: "2026-09-01",
    majorDeclarationCatalogYear: "2023-2024",
    courses: []
  }));
  const older = await olderResponse.json();
  assert.equal(olderResponse.status, 200);
  assert.equal(older.catalog.appliedMajorCatalogYear, "2023-2024");
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

test("declaration-year intake is accessible and the browser does not resolve catalog authority", async () => {
  const source = await readFile(path.join(ROOT, "app/page.js"), "utf8");
  assert.match(source, /htmlFor="major-declaration-catalog-year"/);
  assert.match(source, /id="major-declaration-catalog-year"/);
  assert.doesNotMatch(source, /projectedSeniorStandingConfirmation/);
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
        readFile(path.join(outputRoot, "planning-flexibility", "econ-planning-flexibility.13", "bundle.json"), "utf8"),
        ...["econ-catalog-2023-2024.3", "econ-catalog-2024-2025.3", "econ-catalog-2025-2026.5", "econ-catalog-2026-2027.2"]
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
