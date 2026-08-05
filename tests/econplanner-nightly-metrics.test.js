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
  percentile,
  ruleCoverageSummary,
  sourceEvidenceSummary,
  validateObservabilityPolicy
} from "../lib/nightly/econplannerMetrics.js";
import {
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
    noPlan: plans ? null : { conclusion: "PROVEN_INFEASIBLE", reason: "COUNT_CAPACITY", attempts: [{ exhaustive: true }] }
  };
}

function shard(index, profiles) {
  return {
    schemaVersion: 2,
    kind: "econplanner-nightly-generated-matrix",
    provenance: { generatorVersion: 1, oraclePolicyVersion: 3, scheduleVersion: 2 },
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

test("the observability registry exactly maps all 53 confirmed, 3 review, and 4 structural rules", async () => {
  assert.deepEqual(validateObservabilityPolicy(observabilityPolicy, oraclePolicy, mutationRegistry), {
    valid: true,
    ruleCount: 60,
    criticalFamilyCount: 19
  });
  const coverage = ruleCoverageSummary(observabilityPolicy);
  assert.equal(coverage.rows.length, 60);
  assert.ok(coverage.missingProductionOrOracle.length > 0);
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
});

test("shard validation rejects missing, duplicate, and malformed inputs", () => {
  assert.throws(() => mergeGeneratedShards([]), { code: "MISSING_GENERATED_SHARDS" });
  assert.throws(() => mergeGeneratedShards([shard(1, []), shard(1, [])]), { code: "DUPLICATE_SHARD" });
  assert.throws(() => mergeGeneratedShards([{ ...shard(1, []), schemaVersion: 1 }]), { code: "MALFORMED_GENERATED_SHARD" });
  const merged = mergeGeneratedShards([shard(1, []), { ...shard(2, []), selection: { ...shard(2, []).selection, shard: { index: 3, total: 2 } } }]);
  assert.deepEqual(merged.missingShardIndexes, [2]);
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
  assert.equal(evaluateGates({ ...common, pdf: { hosted: { configuration: "NOT_CONFIGURED", status: "SKIPPED" } } }).overall, "AMBER");
  assert.equal(evaluateGates({ ...common, mutations: { survivedCritical: 1 } }).overall, "RED");
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
  assert.equal(
    createHash("sha256").update(await readFile(new URL("./fixtures/econplanner-nightly-baseline-cases.v1.json", import.meta.url))).digest("hex"),
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
