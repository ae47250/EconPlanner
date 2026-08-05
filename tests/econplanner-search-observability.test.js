import test from "node:test";
import assert from "node:assert/strict";

import { mergeGeneratedShards } from "../lib/nightly/econplannerMetrics.js";

const provenance = Object.freeze({
  repository: "fictional/econplanner",
  commitSha: "011a624f13f2cb1b62c1acf550ea91c67c6e71b3",
  originMainSha: "011a624f13f2cb1b62c1acf550ea91c67c6e71b3",
  branch: "main",
  workflowName: "Fictional nightly",
  workflowRunId: 100,
  workflowAttempt: 3,
  generatorVersion: 1,
  oraclePolicyVersion: 3,
  scheduleVersion: 2,
  metricSchemaVersion: 2
});

function profile({ id, plans, firstSolutionNode, nodeLimit = false }) {
  return {
    seed: 7,
    profileId: id,
    plannerInputHash: `hash-${id}`,
    plans,
    planSignatures: plans ? [`signature-${id}`] : [],
    planObservability: plans ? [{
      legacyValidatedDisplayedPlan: true,
      legacyFeasibilityStatus: "PRELIMINARY_ONLY",
      strategy: "BALANCED",
      strategyFit: "EXACT"
    }] : [],
    legacyValidatedDisplayedPlan: Boolean(plans),
    durationMs: 10,
    solverNodes: plans ? [100] : [],
    solverDiagnostics: {
      strategyAttempts: [{
        nodesVisited: 120,
        durationMs: 5,
        exhaustive: !nodeLimit,
        solutionFound: Boolean(plans),
        firstSolutionNode,
        terminationReason: nodeLimit ? "NODE_LIMIT" : "EXHAUSTED",
        finalValidSchedules: plans,
        completeSchedulesExamined: plans
      }],
      searchAttempts: [{ solutionBudgetHit: false }]
    },
    noPlan: plans ? null : {
      conclusion: nodeLimit ? "UNKNOWN" : "PROVEN_INFEASIBLE",
      reason: nodeLimit ? "SEARCH_INCOMPLETE" : "NO_COMPLETE_ASSIGNMENT",
      category: nodeLimit ? "SEARCH_INCOMPLETE" : "INFEASIBLE_PROVEN"
    }
  };
}

function shard(index, profiles, overrides = {}) {
  return {
    schemaVersion: 2,
    kind: "econplanner-nightly-generated-matrix",
    provenance: { ...provenance, ...overrides },
    selection: {
      seeds: [7],
      shard: { index, total: 2 },
      effectivePairwiseCoverage: { requiredPairs: 0, coveredPairs: 0, missingPairs: [] }
    },
    metrics: { totalRuntimeMs: 10, processMemory: { maxRssBytes: 1024 } },
    profiles,
    failures: [],
    dimensions: { declared: {}, effective: {} },
    highRiskCombinations: []
  };
}

test("CP0 reports solver evidence without inventing future completion metrics", () => {
  const merged = mergeGeneratedShards([
    shard(1, [profile({ id: "complete", plans: 1, firstSolutionNode: 17, nodeLimit: true })]),
    shard(2, [profile({ id: "incomplete", plans: 0, firstSolutionNode: null, nodeLimit: true })])
  ]);

  assert.equal(merged.provenance.identityComplete, true);
  assert.deepEqual(merged.provenance.missingIdentityFields, []);
  assert.deepEqual(merged.provenance.inputWorkflowAttempts, [3]);
  assert.equal(merged.coverage.completion.targetAvailability, "NOT_MEASURED");
  assert.equal(merged.coverage.completion.legacyValidationProxy.availability, "PROXY");
  assert.equal(merged.coverage.completion.legacyValidationProxy.profilesWithLegacyValidatedDisplayedPlan, 1);
  assert.equal(merged.coverage.completion.legacyValidationProxy.displayedPlansValidatedAndScheduled, 1);
  assert.deepEqual(merged.coverage.completion.legacyValidationProxy.plansByLegacyFeasibilityStatus, { PRELIMINARY_ONLY: 1 });
  assert.deepEqual(merged.coverage.completion.primaryProductCoverage, {
    availability: "NOT_MEASURED",
    reasonCode: "PRODUCTION_DECISION_ENGINE_SNAPSHOT_AND_REPORT_CONTRACT_NOT_IMPLEMENTED",
    numerator: null,
    denominator: 2,
    denominatorAvailability: "MEASURED",
    percentage: null
  });
  assert.equal(merged.solver.firstSolverSolutionNodes.observations, 1);
  assert.equal(merged.solver.firstSolverSolutionNodes.p50, 17);
  assert.equal(merged.solver.timeToFirstCompletePlanMs.value, null);
  assert.equal(merged.solver.limitBehavior.nodeLimitProfiles, 2);
  assert.equal(merged.solver.limitBehavior.nodeLimitProfilesWithLegacyValidatedDisplayedPlan, 1);
  assert.equal(merged.solver.limitBehavior.exactIncumbentPreservation.availability, "NOT_MEASURED");
  assert.equal(merged.strategies.availability, "PROXY");
  assert.equal(merged.moveDestinations.availability, "NOT_MEASURED");
  assert.equal(merged.productionDecisionEngine.availability, "NOT_MEASURED");
  assert.equal(merged.policyCompiler.availability, "NOT_MEASURED");
  assert.deepEqual(merged.noPlan.categories, { SEARCH_INCOMPLETE: 1 });
});

test("generated shards reject mixed identity, version, or rerun provenance", () => {
  const first = shard(1, []);
  for (const [field, value] of [
    ["repository", "different/repository"],
    ["commitSha", "different"],
    ["originMainSha", "different"],
    ["branch", "different"],
    ["workflowName", "Different workflow"],
    ["workflowRunId", 101],
    ["generatorVersion", 2],
    ["oraclePolicyVersion", 4],
    ["scheduleVersion", 3],
    ["metricSchemaVersion", 3]
  ]) {
    assert.throws(
      () => mergeGeneratedShards([first, shard(2, [], { [field]: value })]),
      { code: "MIXED_SHARD_PROVENANCE" },
      field
    );
  }
});

test("partial reruns may combine earlier attempts from the same workflow run", () => {
  const merged = mergeGeneratedShards([
    shard(1, [], { workflowAttempt: 1 }),
    shard(2, [], { workflowAttempt: 2 })
  ]);

  assert.deepEqual(merged.provenance.inputWorkflowAttempts, [1, 2]);
  assert.throws(
    () => mergeGeneratedShards([shard(1, []), shard(2, [], { workflowAttempt: 0 })]),
    { code: "MALFORMED_SHARD_PROVENANCE" }
  );
});

test("identity completeness requires every shard to carry every required field", () => {
  const merged = mergeGeneratedShards([
    shard(1, []),
    shard(2, [], { commitSha: null })
  ]);

  assert.equal(merged.provenance.identityComplete, false);
  assert.deepEqual(merged.provenance.missingIdentityFields, ["commitSha"]);
  assert.deepEqual(merged.provenance.missingIdentityByShard, [{ shardIndex: 2, fields: ["commitSha"] }]);
});
