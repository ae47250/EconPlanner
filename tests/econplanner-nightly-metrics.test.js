import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import {
  buildAggregate,
  compareApprovedBaseline,
  distributionSummary,
  evaluateGates,
  mergeGeneratedShards,
  ordinaryProductCoverage,
  percentile,
  ruleCoverageSummary,
  sourceEvidenceSummary,
  validateObservabilityPolicy
} from "../lib/nightly/econplannerMetrics.js";
import {
  assertFrozenCp4AuthoritySummary,
  assertFictionalProfileFile,
  canonicalPlannerInputHash,
  classifyNoPlan,
  duplicateInputGroups,
  effectivePairwiseCoverageReport,
  stableValue
} from "../scripts/run-economics-nightly-matrix.mjs";

const readJson = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
const observabilityPolicy = await readJson("./fixtures/econplanner-observability-policy.v1.json");
const baseline = await readJson("./fixtures/econplanner-nightly-baseline.v1.json");
const baselineCases = await readJson("./fixtures/econplanner-nightly-baseline-cases.v1.json");
const oraclePolicy = await readJson("./oracle/economics-policy.v1.json");
const mutationRegistry = await readJson("./fixtures/economics-validator-disagreements.v1.json");

function profile(id, hash, plans = 1) {
  return {
    seed: 7,
    profileId: id,
    plannerInputHash: hash,
    plans,
    planSignatures: plans ? [`signature-${id}`] : [],
    durationMs: id === "p1" ? 10 : 30,
    solverNodes: plans ? [100] : [],
    solverDiagnostics: {
      strategyAttempts: [{ nodesVisited: 120, durationMs: 5, exhaustive: true, finalValidSchedules: plans, completeSchedulesExamined: 2 }],
      searchAttempts: [{ solutionBudgetHit: false }]
    },
    decisionShadow: plans ? [{
      classification: "AGREEMENT_ALLOW",
      unexpected: false,
      completionStatus: "COMPLETE",
      evidenceStatus: "PRELIMINARY",
      readinessStatus: "READY_WITH_CONDITIONS",
      planDisposition: "COMPLETE_READY_WITH_CONDITIONS",
      advisorActionRequired: false,
      latencyMs: 2,
      policyBundleVersion: "econ-2025-2026.1",
      policyBundleHash: "sha256:fixture"
    }] : [],
    allocationAlternatives: { strict: plans ? 2 : 0, optimistic: plans ? 2 : 0, projectedStrict: plans ? 2 : 0, projectedOptimistic: plans ? 2 : 0, multipleValidAllocations: Boolean(plans), pageLimitOutcomes: ["EXHAUSTED"] },
    tbcWitnessOutcomes: plans ? ["PRELIMINARY"] : [],
    catalogApplicability: { status: "EXACT" },
    evidenceFindings: [],
    noPlan: plans ? null : { conclusion: "PROVEN_INFEASIBLE", reason: "COUNT_CAPACITY", attempts: [{ exhaustive: true }] }
  };
}

test("CP4b-A shard aggregation reports readiness, allocations, TBC witnesses, and catalog applicability", () => {
  const merged = mergeGeneratedShards([shard(1, [profile("p1", "h1")]), shard(2, [profile("p2", "h2", 0)])]);
  assert.equal(merged.coverage.completion.primaryProductCoverage.numerator, 1);
  assert.equal(merged.coverage.completion.shadowDecision.readinessStatuses.READY_WITH_CONDITIONS, 1);
  assert.equal(merged.coverage.completion.advisorActionRequiredProfiles, 0);
  assert.equal(merged.cp4bA.profilesWithMultipleValidAllocations, 1);
  assert.equal(merged.cp4bA.allocationAlternativeCounts.maximum, 2);
  assert.equal(merged.cp4bA.tbcWitnessOutcomes.PRELIMINARY, 1);
  assert.equal(merged.cp4bA.catalogApplicabilityStatuses.EXACT, 2);
});

function shard(index, profiles) {
  return {
    schemaVersion: 2,
    kind: "econplanner-nightly-generated-matrix",
    provenance: {
      repository: "fictional/econplanner",
      commitSha: "fictional-commit",
      originMainSha: "fictional-commit",
      branch: "main",
      generatorVersion: 1,
      oraclePolicyVersion: 3,
      scheduleVersion: 2,
      metricSchemaVersion: 2
    },
    selection: {
      seeds: [7],
      shard: { index, total: 2 },
      effectivePairwiseCoverage: { requiredPairs: 1, coveredPairs: 1, missingPairs: [] }
    },
    metrics: { totalRuntimeMs: index === 1 ? 100 : 300, processMemory: { maxRssBytes: index * 1024 } },
    profiles,
    failures: [],
    dimensions: { declared: {}, effective: {} },
    highRiskCombinations: []
  };
}

function ordinaryShard(profiles, historyCoverage = []) {
  const value = shard(1, profiles);
  value.selection = {
    ...value.selection,
    shard: { index: 1, total: 1 },
    cohort: { id: "ordinary-on-time-v1", category: "ordinary-on-time" },
    historyCoverage
  };
  return value;
}

test("ordinary coverage uses resolved standing, preserves hard histories, and reports zero denominators as N/A", () => {
  const historyCoverage = [{
    standing: "freshman",
    normalRemainingYears: 4,
    profileCount: 2,
    historyCategories: ["no-economics-history", "foundations-completed"],
    justification: "Includes a deliberately difficult no-history freshman."
  }];
  const rows = [
    { ...profile("ordinary-freshman-hard", "ordinary-h1", 0), cohortCategory: "ordinary-on-time", resolvedEffectiveStanding: "freshman", historyCategory: "no-economics-history" },
    { ...profile("ordinary-freshman-progress", "ordinary-h2", 3), cohortCategory: "ordinary-on-time", resolvedEffectiveStanding: "freshman", historyCategory: "foundations-completed" }
  ];
  const coverage = ordinaryProductCoverage(rows, [], historyCoverage);

  assert.equal(coverage.availability, "MEASURED_AUTHORITY");
  assert.equal(coverage.schemaVersion, 1);
  assert.equal(coverage.metricId, "ordinary-on-time-plan-coverage-v1");
  assert.equal(coverage.role, "PRIMARY_PRODUCT_KPI");
  assert.deepEqual(coverage.overall, {
    numerator: 1,
    denominator: 2,
    zeroPlanCount: 1,
    percentage: 50,
    planCountDistribution: { zero: 1, one: 0, two: 0, threePlus: 1 }
  });
  assert.equal(coverage.byStanding.freshman.normalRemainingYears, 4);
  assert.deepEqual(coverage.byStanding.freshman.historyCategories, historyCoverage[0].historyCategories);
  assert.equal(coverage.byStanding.sophomore.denominator, 0);
  assert.equal(coverage.byStanding.sophomore.percentage, null);
});

test("aggregate adds a versioned ordinary product KPI without changing pairwise readiness meaning", () => {
  const ordinary = {
    ...profile("ordinary-freshman", "ordinary-hash", 3),
    cohortCategory: "ordinary-on-time",
    declaredStanding: "freshman",
    resolvedEffectiveStanding: "freshman",
    effectiveRemainingYears: 4,
    expectedGraduationYear: 2030,
    historyCategory: "no-economics-history"
  };
  const aggregate = buildAggregate({
    shards: [
      shard(1, [profile("stress-1", "stress-h1")]),
      shard(2, [profile("stress-2", "stress-h2", 0)]),
      ordinaryShard([ordinary], [{
        standing: "freshman",
        normalRemainingYears: 4,
        profileCount: 1,
        historyCategories: ["no-economics-history"],
        justification: "Deliberately difficult starting history."
      }])
    ],
    prerequisite: { schemaVersion: 2, kind: "econplanner-nightly-prerequisites", metrics: {}, normal: {}, optional: {} },
    browser: { schemaVersion: 2, kind: "econplanner-nightly-browser", metrics: {} },
    pdf: { schemaVersion: 2, kind: "econplanner-nightly-pdf", hosted: { configuration: "CONFIGURED", status: "PASSED" }, local: { status: "PASSED" } },
    phases: [],
    baseline,
    observabilityPolicy,
    oraclePolicy,
    mutationRegistry,
    provenance: { startedAt: "2026-08-04T00:00:00Z", completedAt: "2026-08-04T00:00:01Z" }
  });

  assert.equal(aggregate.coverage.productKpi.schemaVersion, 1);
  assert.equal(aggregate.coverage.productKpi.metricId, "ordinary-on-time-plan-coverage-v1");
  assert.equal(aggregate.coverage.productKpi.cohortId, "ordinary-on-time-v1");
  assert.equal(aggregate.coverage.productKpi.overall.numerator, 1);
  assert.equal(aggregate.coverage.productKpi.overall.denominator, 1);
  assert.equal(aggregate.coverage.completion.primaryProductCoverage.numerator, 1);
  assert.equal(aggregate.coverage.completion.primaryProductCoverage.denominator, 2);
  assert.equal(aggregate.coverage.stressPairwise.profiles.tested, 2);
  assert.equal(aggregate.coverage.stressPairwise.profiles.withPlans, 1);
  assert.equal(aggregate.artifactCompleteness.ordinaryOnTimeCohort.missing, false);
});

test("the observability registry exactly maps all 53 confirmed, 3 review, and 4 structural rules", async () => {
  assert.deepEqual(validateObservabilityPolicy(observabilityPolicy, oraclePolicy, mutationRegistry), {
    valid: true,
    ruleCount: 60,
    criticalFamilyCount: 19
  });
  const coverage = ruleCoverageSummary(observabilityPolicy);
  assert.equal(coverage.rows.length, 60);
  assert.deepEqual(coverage.missingProductionOrOracle, []);
  const sources = sourceEvidenceSummary(oraclePolicy);
  assert.equal(sources.effectiveDateComplete, true);
  assert.equal(sources.reviewerSignoffPresent, true);
  assert.deepEqual(sources.missingSourceRules, []);
  for (const group of observabilityPolicy.ruleGroups) {
    for (const reference of [...group.implementationRefs, ...group.positiveTests, ...group.negativeTests]) {
      await access(new URL(`../${reference}`, import.meta.url));
    }
  }
});

test("nightly coverage has no missing Production or Oracle rule and no critical coverage-gap gate", () => {
  const coverage = ruleCoverageSummary(observabilityPolicy);
  assert.deepEqual(coverage.missingProductionOrOracle, []);
  const gates = evaluateGates({
    generated: mergeGeneratedShards([
      shard(1, [profile("coverage-1", "coverage-h1")]),
      shard(2, [profile("coverage-2", "coverage-h2")])
    ]),
    prerequisite: { metrics: {}, normal: {}, optional: {} },
    browser: { metrics: {} },
    pdf: { hosted: { configuration: "CONFIGURED", status: "PASSED" }, local: { status: "PASSED" } },
    phases: [],
    comparison: {
      approvedBaseline: { metrics: {} },
      previousSuccessful: { availability: "AVAILABLE", compatible: true, changedCases: [] }
    },
    coverage,
    mutations: { survivedCritical: 0 },
    artifactCompleteness: { missingMandatoryKinds: [], missingMandatoryPhases: [] },
    sourceEvidence: {
      effectiveDateComplete: true,
      reviewerSignoffPresent: true,
      missingSourceRules: [],
      unknownSourceRules: [],
      missingConfirmationRules: []
    },
    observabilityPolicy
  });
  assert.equal(gates.red.some(item => item.code === "CRITICAL_RULE_COVERAGE_GAP"), false);
});

test("canonical planner input hashing is stable across key order and exposes duplicates", () => {
  const left = { courses: [{ status: "completed", code: "ECO 113" }], standing: "senior" };
  const right = { standing: "senior", courses: [{ code: "ECO 113", status: "completed" }] };
  assert.deepEqual(stableValue(left), stableValue(right));
  assert.equal(canonicalPlannerInputHash(left), canonicalPlannerInputHash(right));
  assert.match(canonicalPlannerInputHash(left), /^[0-9a-f]{64}$/);
  assert.deepEqual(duplicateInputGroups([
    { profileId: "a", plannerInputHash: canonicalPlannerInputHash(left) },
    { profileId: "b", plannerInputHash: canonicalPlannerInputHash(right) }
  ])[0].profileIds, ["a", "b"]);
});

test("effective pairwise coverage excludes axes that never reach the planner", () => {
  const report = effectivePairwiseCoverageReport([
    { axes: { standing: "senior", approvalState: null } },
    { axes: { standing: "junior", approvalState: null } }
  ]);
  assert.equal(report.axes.standing.consumed, true);
  assert.deepEqual(report.axes.approvalState, { values: [], consumed: false });
  assert.equal(report.requiredPairs, 0);
});

test("no-plan precedence never certifies an incomplete search as infeasible", () => {
  const incomplete = classifyNoPlan({
    metricsDiagnostics: {
      strategyAttempts: [{ exhaustive: false, solutionFound: false }],
      searchAttempts: [{ failure: "COUNT_CAPACITY" }]
    },
    planningGaps: [],
    candidateOutcomes: []
  });
  assert.equal(incomplete.conclusion, "UNKNOWN");
  assert.equal(incomplete.reason, "SEARCH_INCOMPLETE");
  const exhaustive = classifyNoPlan({
    metricsDiagnostics: {
      strategyAttempts: [{ exhaustive: true, solutionFound: false }],
      searchAttempts: [{ failure: "COUNT_CAPACITY" }]
    },
    planningGaps: [],
    candidateOutcomes: []
  });
  assert.equal(exhaustive.conclusion, "PROVEN_INFEASIBLE");
  assert.equal(exhaustive.reason, "COUNT_CAPACITY");
});

test("the CP4 frozen-cohort authority gate rejects blanket context reviews and malformed convergence records", () => {
  const records = Array.from({ length: 439 }, (_, index) => ({
    evidenceStatus: index < 246 ? "REVIEW_REQUIRED" : "PRELIMINARY",
    reasonCodes: index < 246 ? ["ENROLLMENT_FULL"] : ["UNPUBLISHED_OFFERING_TBC"],
    reviewFindings: index < 246 ? [{
      ruleIds: ["SCHEDULE-AVAILABILITY-BEHAVIOR"],
      sourceRefs: ["DEPARTMENT-POLICIES#Confirmed-policy-9"]
    }] : []
  }));
  const summary = {
    metrics: {
      profilesTested: 368,
      profilesWithPlans: 186,
      acceptedPlanCount: 439,
      completion: { shadowDecision: { evidenceStatuses: { PRELIMINARY: 193, REVIEW_REQUIRED: 246 } } },
      productionDecisionEngine: { unexpectedDisagreements: 0 },
      oracleDisagreementCount: 0,
      unclassifiedOracleDisagreementCount: 0
    },
    profiles: [{
      profileId: "fictional-econ-20260805-c014e0de",
      decisionShadow: records.slice(0, 438),
      strategyConvergences: [{ code: "PLANS_CONVERGED", keptLabel: "Balanced", convergedLabel: "Explore the Major" }]
    }, {
      profileId: "fictional-econ-20270117-a6a8df79",
      decisionShadow: records.slice(438),
      strategyConvergences: [{ code: "PLANS_CONVERGED", keptLabel: "Balanced", convergedLabel: "Explore the Major" }]
    }]
  };
  assert.deepEqual(assertFrozenCp4AuthoritySummary(summary), {
    profiles: 368,
    profilesWithPlans: 186,
    displayedPlans: 439,
    evidenceStatuses: { PRELIMINARY: 193, REVIEW_REQUIRED: 246 },
    convergenceProfiles: [
      "fictional-econ-20260805-c014e0de",
      "fictional-econ-20270117-a6a8df79"
    ]
  });
  const intentionalAdditionalConvergence = structuredClone(summary);
  intentionalAdditionalConvergence.profiles.push({
    profileId: "fictional-econ-approved-policy-convergence",
    decisionShadow: [],
    strategyConvergences: [{ code: "PLANS_CONVERGED", keptLabel: "Balanced", convergedLabel: "Explore the Major" }]
  });
  assert.deepEqual(assertFrozenCp4AuthoritySummary(intentionalAdditionalConvergence).convergenceProfiles, [
    "fictional-econ-20260805-c014e0de",
    "fictional-econ-20270117-a6a8df79",
    "fictional-econ-approved-policy-convergence"
  ]);
  const resolvedHistoricalConvergences = structuredClone(summary);
  for (const profile of resolvedHistoricalConvergences.profiles) profile.strategyConvergences = [];
  assert.deepEqual(assertFrozenCp4AuthoritySummary(resolvedHistoricalConvergences).convergenceProfiles, []);
  const malformedConvergence = structuredClone(summary);
  malformedConvergence.profiles[0].strategyConvergences[0].code = "UNCLASSIFIED";
  assert.throws(() => assertFrozenCp4AuthoritySummary(malformedConvergence), { code: "CP4_FROZEN_CONVERGENCE_DRIFT" });
  const blanket = structuredClone(summary);
  blanket.profiles[0].decisionShadow[0].reasonCodes = ["PLANNING_CONTEXT_REQUIRED"];
  assert.throws(() => assertFrozenCp4AuthoritySummary(blanket), { code: "CP4_OBSERVABILITY_CONTEXT_OMITTED" });
});

test("profile-file replay accepts only explicitly fictional, PII-free inputs", () => {
  assert.doesNotThrow(() => assertFictionalProfileFile({ fictional: true, student: { displayName: "Fictional Replay" } }));
  assert.throws(() => assertFictionalProfileFile({ fictional: false }), { code: "NON_FICTIONAL_PROFILE_FILE" });
  assert.throws(() => assertFictionalProfileFile({ fictional: true, student: { email: "person@example.com" } }), { code: "PROFILE_FILE_PII" });
  assert.throws(() => assertFictionalProfileFile({ fictional: true, student: { displayName: "Actual Student" } }), { code: "PROFILE_FILE_PII" });
});

test("shard merging reports percentiles, imbalance, memory bytes, duplicates, and no-plan reasons", () => {
  const merged = mergeGeneratedShards([
    shard(1, [profile("p1", "same", 1)]),
    shard(2, [profile("p2", "same", 0)])
  ]);
  assert.equal(merged.coverage.profiles.tested, 2);
  assert.equal(merged.coverage.effectiveInputs.duplicateProfiles, 2);
  assert.equal(merged.noPlan.reasons.COUNT_CAPACITY, 1);
  assert.equal(merged.profileDurationMs.p90, 30);
  assert.equal(merged.solver.shardImbalanceRatio, 3);
  assert.equal(merged.solver.processMaxRssBytes, 2048);
  assert.equal(merged.computeTimeMs, 400);
  assert.equal(merged.productionDecisionEngine.availability, "MEASURED_SHADOW");
  assert.equal(merged.productionDecisionEngine.unexpectedDisagreements, 0);
  assert.equal(merged.productionDecisionEngine.latencyMs.p95, 2);
  assert.equal(merged.coverage.completion.targetAvailability, "MEASURED_SHADOW");
  assert.equal(merged.coverage.completion.shadowDecision.profilesWithCompletePlan, 1);
  assert.deepEqual(merged.coverage.completion.shadowDecision.evidenceStatuses, { PRELIMINARY: 1 });
});

test("shard validation rejects missing, duplicate, and malformed inputs", () => {
  assert.throws(() => mergeGeneratedShards([]), { code: "MISSING_GENERATED_SHARDS" });
  assert.throws(() => mergeGeneratedShards([shard(1, []), shard(1, [])]), { code: "DUPLICATE_SHARD" });
  assert.throws(() => mergeGeneratedShards([{ ...shard(1, []), schemaVersion: 1 }]), { code: "MALFORMED_GENERATED_SHARD" });
  const merged = mergeGeneratedShards([shard(1, []), { ...shard(2, []), selection: { ...shard(2, []).selection, shard: { index: 3, total: 2 } } }]);
  assert.deepEqual(merged.missingShardIndexes, [2]);
});

test("current authority survives aggregation, including runs that found no plans", () => {
  for (const plans of [0, 1]) {
    const current = [shard(1, [profile("p1", "h1", plans)]), shard(2, [profile("p2", "h2", plans)])];
    for (const item of current) {
      item.metrics.productionDecisionEngine = {
        authority: "PRODUCTION_DECISION_ENGINE", availability: "MEASURED_AUTHORITY",
        bundleVersion: "econ-2025-2026.1", bundleHash: "sha256:fixture"
      };
      item.metrics.completion = { shadowDecision: { authority: "PRODUCTION_DECISION_ENGINE" } };
      for (const row of item.profiles) for (const record of row.decisionShadow) record.mode = "AUTHORITATIVE_REUSED";
    }
    const merged = mergeGeneratedShards(current);
    assert.equal(merged.productionDecisionEngine.authority, "PRODUCTION_DECISION_ENGINE");
    assert.equal(merged.productionDecisionEngine.availability, "MEASURED_AUTHORITY");
    assert.equal(merged.productionDecisionEngine.bundleVersion, "econ-2025-2026.1");
    assert.equal(merged.productionDecisionEngine.bundleHash, "sha256:fixture");
    assert.equal(merged.coverage.completion.shadowDecision.authority, "PRODUCTION_DECISION_ENGINE");
    assert.equal(merged.coverage.completion.targetAvailability, plans ? "MEASURED_AUTHORITY" : "NOT_MEASURED");
    assert.equal(merged.coverage.completion.primaryProductCoverage.availability, "MEASURED_AUTHORITY");
    assert.equal(merged.coverage.completion.primaryProductCoverage.numerator, plans * 2);
    assert.equal(merged.coverage.completion.primaryProductCoverage.percentage, plans * 100);

    const mixed = structuredClone(current);
    delete mixed[1].metrics.productionDecisionEngine;
    assert.throws(() => mergeGeneratedShards(mixed), { code: "INCONSISTENT_DECISION_AUTHORITY" });
    const differentBundle = structuredClone(current);
    differentBundle[1].metrics.productionDecisionEngine.bundleHash = "sha256:other-release";
    assert.throws(() => mergeGeneratedShards(differentBundle), { code: "INCONSISTENT_DECISION_BUNDLE" });
    current[0].metrics.completion.shadowDecision.authority = "LEGACY_PRODUCTION_REMAINS_AUTHORITATIVE";
    assert.throws(() => mergeGeneratedShards(current), { code: "INCONSISTENT_DECISION_AUTHORITY" });
  }
});

test("historical shadow runs retain their original authority and cannot masquerade as production", () => {
  const historical = [shard(1, [profile("p1", "h1")]), shard(2, [profile("p2", "h2")])];
  const merged = mergeGeneratedShards(historical);
  assert.equal(merged.productionDecisionEngine.authority, "LEGACY_PRODUCTION_REMAINS_AUTHORITATIVE");
  assert.equal(merged.coverage.completion.primaryProductCoverage.availability, "MEASURED_SHADOW");
  historical[0].profiles[0].decisionShadow[0].mode = "AUTHORITATIVE_REUSED";
  assert.throws(() => mergeGeneratedShards(historical), { code: "INCONSISTENT_DECISION_AUTHORITY" });
});

test("percentiles and baseline deltas preserve zero-denominator and unavailable semantics", () => {
  assert.equal(percentile([1, 2, 10], 0.9), 10);
  assert.equal(distributionSummary([1, 2, 10]).p99, 10);
  const generated = mergeGeneratedShards([shard(1, [profile("p1", "h1")]), shard(2, [profile("p2", "h2", 0)])]);
  const comparison = compareApprovedBaseline(generated, null, null, null, {
    approved: true,
    schemaVersion: 1,
    generated: { profilesTested: 0 }
  });
  assert.equal(comparison.metrics.profilesTested.percentage, null);
  assert.equal(comparison.metrics.profilesWithPlans.availability, "NOT_AVAILABLE_IN_BASELINE");
});

test("v1 case adaptation names changed deterministic profiles without inventing signatures", () => {
  const profileId = "fictional-econ-20260803-baseline-case";
  const generated = mergeGeneratedShards([
    shard(1, [{ ...profile("p1", "h1", 1), profileId, seed: 20260803 }]),
    shard(2, [])
  ]);
  const comparison = compareApprovedBaseline(
    generated,
    null,
    null,
    null,
    { approved: true, versions: { generatorVersion: 1, oraclePolicyVersion: 3, scheduleVersion: 2 }, generated: {} },
    { outcomes: [`${profileId}=0`] },
    { generatorVersion: 1, oraclePolicyVersion: 3, scheduleVersion: 2 }
  );
  assert.equal(comparison.deterministicCases.compatible, true);
  assert.deepEqual(comparison.deterministicCases.changed.map(item => item.profileId), [profileId]);
  assert.equal(comparison.deterministicCases.changed[0].currentPlanCount, 1);
  assert.equal(comparison.deterministicCases.changed[0].expectedPlanCount, 0);
});

test("GREEN, AMBER, and RED gate paths are distinct and timing remains AMBER", () => {
  const generated = mergeGeneratedShards([shard(1, [profile("p1", "h1")]), shard(2, [profile("p2", "h2")])]);
  const common = {
    generated,
    prerequisite: { metrics: {}, normal: {}, optional: {} },
    browser: { metrics: {} },
    pdf: { hosted: { configuration: "CONFIGURED", status: "PASSED" }, local: { status: "PASSED" } },
    phases: [],
    comparison: { approvedBaseline: { metrics: {} }, previousSuccessful: { availability: "AVAILABLE", compatible: true, changedCases: [] } },
    coverage: { missingProductionOrOracle: [] },
    mutations: { survivedCritical: 0 },
    artifactCompleteness: { missingMandatoryKinds: [], missingMandatoryPhases: [] },
    sourceEvidence: { effectiveDateComplete: true, reviewerSignoffPresent: true, missingSourceRules: [], unknownSourceRules: [], missingConfirmationRules: [] },
    observabilityPolicy
  };
  assert.equal(evaluateGates(common).overall, "GREEN");
  const engineOnly = structuredClone(common);
  engineOnly.generated.productionDecisionEngine.unexpectedDisagreements = 1;
  assert.equal(evaluateGates(engineOnly).overall, "RED");
  assert.ok(evaluateGates(engineOnly).red.some(item => item.code === "UNEXPECTED_ENGINE_DISAGREEMENT"));
  assert.equal(evaluateGates({ ...common, pdf: { hosted: { configuration: "NOT_CONFIGURED", status: "SKIPPED" } } }).overall, "AMBER");
  assert.equal(evaluateGates({ ...common, mutations: { survivedCritical: 1 } }).overall, "RED");
  const missingCommitShard = shard(2, [profile("p2", "h2")]);
  missingCommitShard.provenance.commitSha = null;
  const incompleteProvenance = mergeGeneratedShards([shard(1, [profile("p1", "h1")]), missingCommitShard]);
  const provenanceGate = evaluateGates({ ...common, generated: incompleteProvenance });
  assert.equal(provenanceGate.overall, "RED");
  assert.ok(provenanceGate.red.some(item => item.code === "INCOMPLETE_GENERATED_SHARD_PROVENANCE"));
});

test("the approved v1 fixture is permanent, hash-complete, and adapts only common metrics", async () => {
  assert.equal(baseline.source.runId, 30938769038);
  assert.equal(baseline.source.commitSha, "944a33fb2c9d8a0192abd47203834aab835f1f0a");
  assert.equal(baseline.artifacts.length, 7);
  for (const artifact of baseline.artifacts) {
    assert.match(artifact.manifestSha256, /^[0-9a-f]{64}$/);
    for (const file of artifact.files) assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(baselineCases.caseCount, 358);
  assert.equal(baselineCases.outcomes.length, 358);
  assert.equal(baselineCases.outcomes.filter(value => !value.endsWith("=0")).length, 190);
  assert.equal(baselineCases.outcomes.reduce((sum, value) => sum + Number(value.slice(value.lastIndexOf("=") + 1)), 0), 570);
  assert.equal(createHash("sha256").update(JSON.stringify(baselineCases.outcomes)).digest("hex"), baseline.caseFixture.outcomesSha256);
  const baselineCaseFixture = await readFile(new URL("./fixtures/econplanner-nightly-baseline-cases.v1.json", import.meta.url), "utf8");
  assert.equal(
    createHash("sha256").update(baselineCaseFixture.replaceAll("\r\n", "\n")).digest("hex"),
    baseline.caseFixture.sha256
  );
});

test("aggregate separates wall time from summed parallel compute and reports mutation kill rate", () => {
  const phases = [{ schemaVersion: 2, kind: "econplanner-nightly-phase", phaseId: "unit", status: "PASSED", durationMs: 250 }];
  const aggregate = buildAggregate({
    shards: [shard(1, [profile("p1", "h1")]), shard(2, [profile("p2", "h2")])],
    prerequisite: { schemaVersion: 2, kind: "econplanner-nightly-prerequisites", metrics: {}, normal: {}, optional: {} },
    browser: { schemaVersion: 2, kind: "econplanner-nightly-browser", metrics: {} },
    pdf: { schemaVersion: 2, kind: "econplanner-nightly-pdf", hosted: { configuration: "CONFIGURED", status: "PASSED" }, local: { status: "PASSED" } },
    phases,
    baseline,
    observabilityPolicy,
    oraclePolicy,
    mutationRegistry,
    provenance: { startedAt: "2026-08-04T00:00:00Z", completedAt: "2026-08-04T00:00:01Z" }
  });
  assert.equal(aggregate.workflow.wallTimeMs, 1000);
  assert.equal(aggregate.workflow.computeTimeMs, 650);
  assert.equal(aggregate.validation.oracleQuality.mutations.total, 24);
  assert.equal(aggregate.validation.oracleQuality.mutations.survivedCritical, 0);
  assert.equal(aggregate.validation.oracleQuality.mutations.killRate, 1);
});

test("aggregate provenance preserves exact shard identity when local values are unavailable", () => {
  const identity = {
    commitSha: "011a624f13f2cb1b62c1acf550ea91c67c6e71b3",
    workflowRunId: 30967416964
  };
  const first = { ...shard(1, [profile("p1", "h1")]), provenance: { ...shard(1, []).provenance, ...identity, workflowAttempt: 1 } };
  const second = { ...shard(2, [profile("p2", "h2")]), provenance: { ...shard(2, []).provenance, ...identity, workflowAttempt: 2 } };
  const aggregate = buildAggregate({
    shards: [first, second],
    prerequisite: { schemaVersion: 2, kind: "econplanner-nightly-prerequisites", metrics: {}, normal: {}, optional: {} },
    browser: { schemaVersion: 2, kind: "econplanner-nightly-browser", metrics: {} },
    pdf: { schemaVersion: 2, kind: "econplanner-nightly-pdf", hosted: { configuration: "CONFIGURED", status: "PASSED" }, local: { status: "PASSED" } },
    phases: [],
    baseline,
    observabilityPolicy,
    oraclePolicy,
    mutationRegistry,
    provenance: {
      commitSha: null,
      workflowRunId: identity.workflowRunId,
      workflowAttempt: 2,
      startedAt: "2026-08-04T00:00:00Z",
      completedAt: "2026-08-04T00:00:01Z"
    }
  });

  assert.equal(aggregate.provenance.commitSha, identity.commitSha);
  assert.equal(aggregate.provenance.workflowRunId, identity.workflowRunId);
  assert.equal(aggregate.provenance.workflowAttempt, 2);
  assert.deepEqual(aggregate.provenance.inputWorkflowAttempts, [1, 2]);
  assert.equal(aggregate.workflow.wallTimeMs, 1000);
});

test("aggregate runtime identity cannot overwrite a different shard run", () => {
  const exact = {
    commitSha: "011a624f13f2cb1b62c1acf550ea91c67c6e71b3",
    workflowRunId: 30967416964,
    workflowAttempt: 3
  };
  const first = { ...shard(1, []), provenance: { ...shard(1, []).provenance, ...exact } };
  const second = { ...shard(2, []), provenance: { ...shard(2, []).provenance, ...exact } };

  assert.throws(() => buildAggregate({
    shards: [first, second],
    baseline,
    observabilityPolicy,
    oraclePolicy,
    mutationRegistry,
    provenance: { ...exact, workflowRunId: 999 }
  }), { code: "MIXED_RUN_PROVENANCE" });

  assert.throws(() => buildAggregate({
    shards: [first, second],
    baseline,
    observabilityPolicy,
    oraclePolicy,
    mutationRegistry,
    provenance: { ...exact, workflowAttempt: 2 }
  }), { code: "MIXED_RUN_PROVENANCE" });
});
