const METRIC_SCHEMA_VERSION = 2;
const EXECUTION_VALUES = new Set(["NOT_ATTEMPTED", "PASSED", "FAILED", "SKIPPED", "TIMED_OUT"]);
const POLICY_RULE_GROUPS = Object.freeze([
  "requirementRules",
  "prerequisiteRules",
  "concurrencyRules",
  "permissionRules",
  "electiveRules",
  "capstoneRules",
  "planningRules",
  "scheduleEvidenceRules",
  "unresolvedPolicyQuestions"
]);
const STRUCTURAL_RULE_IDS = Object.freeze([
  "ORACLE-STRUCTURE-INPUT",
  "ORACLE-STRUCTURE-TERM",
  "ORACLE-STRUCTURE-HORIZON",
  "ORACLE-STRUCTURE-COURSE"
]);

function invariant(condition, code, message) {
  if (condition) return;
  const error = new Error(message);
  error.code = code;
  throw error;
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function rounded(value) {
  return Math.round(number(value) * 100) / 100;
}

export function percentile(values, fraction) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export function distributionSummary(values) {
  const numbers = values.map(Number).filter(Number.isFinite);
  return {
    observations: numbers.length,
    total: numbers.reduce((sum, value) => sum + value, 0),
    p50: percentile(numbers, 0.5),
    p90: percentile(numbers, 0.9),
    p95: percentile(numbers, 0.95),
    p99: percentile(numbers, 0.99),
    maximum: numbers.length ? Math.max(...numbers) : 0
  };
}

function increment(target, key, value = 1) {
  target[key] = number(target[key]) + value;
}

function incrementSelected(target, items, selector) {
  for (const item of items) {
    const key = selector(item);
    if (key) increment(target, key);
  }
  return Object.fromEntries(Object.entries(target).sort(([left], [right]) => left.localeCompare(right)));
}

function mergePresentValues(...sources) {
  const output = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source || {})) {
      if (value !== null && value !== undefined && value !== "") output[key] = value;
    }
  }
  return output;
}

function normalizedNoPlanCategory(reason, conclusion) {
  if (reason === "INVALID_INPUT") return "INPUT_BLOCKED";
  if (reason === "SEARCH_INCOMPLETE") return "SEARCH_INCOMPLETE";
  if (reason === "POLICY_REVIEW_REQUIRED") return "POLICY_REVIEW_REQUIRED";
  if (reason === "MISSING_OFFERING") return "SCHEDULE_BLOCKED";
  if (conclusion === "PROVEN_INFEASIBLE" && ["COUNT_CAPACITY", "EMPTY_DOMAIN", "NO_COMPLETE_ASSIGNMENT"].includes(reason)) {
    return "INFEASIBLE_PROVEN";
  }
  if (reason === "PRODUCTION_FALSE_NEGATIVE") return "PRODUCTION_FALSE_NEGATIVE";
  return "OTHER";
}

function shardProvenance(ordered) {
  const fields = [
    "repository",
    "commitSha",
    "originMainSha",
    "branch",
    "workflowName",
    "workflowRunId",
    "generatorVersion",
    "oraclePolicyVersion",
    "scheduleVersion",
    "metricSchemaVersion"
  ];
  const result = {};
  for (const field of fields) {
    const values = [...new Set(ordered.map(shard => shard.provenance?.[field]).filter(value => (
      value !== null && value !== undefined && value !== ""
    )))];
    invariant(values.length <= 1, "MIXED_SHARD_PROVENANCE", `Generated shards disagree about ${field}.`);
    if (values.length === 1) result[field] = values[0];
  }
  const requiredIdentityFields = [
    "repository",
    "commitSha",
    "originMainSha",
    "branch",
    "generatorVersion",
    "oraclePolicyVersion",
    "scheduleVersion",
    "metricSchemaVersion"
  ];
  const missingIdentityByShard = ordered.flatMap(shard => {
    const fields = requiredIdentityFields.filter(field => {
      const value = shard.provenance?.[field];
      return value === null || value === undefined || value === "";
    });
    return fields.length ? [{ shardIndex: number(shard.selection?.shard?.index), fields }] : [];
  });
  const missingIdentityFields = [...new Set(missingIdentityByShard.flatMap(item => item.fields))].sort();
  const inputWorkflowAttempts = [...new Set(ordered
    .map(shard => shard.provenance?.workflowAttempt)
    .filter(value => value !== null && value !== undefined && value !== "")
    .map(Number))].sort((left, right) => left - right);
  invariant(
    inputWorkflowAttempts.every(value => Number.isInteger(value) && value >= 1),
    "MALFORMED_SHARD_PROVENANCE",
    "Generated shard workflow attempts must be positive integers."
  );
  return {
    availability: Object.keys(result).length ? "MEASURED" : "NOT_AVAILABLE",
    consistent: true,
    identityComplete: missingIdentityFields.length === 0,
    missingIdentityFields,
    missingIdentityByShard,
    inputWorkflowAttempts,
    ...result
  };
}

function mergeDimensionSummaries(shards) {
  const output = { declared: {}, effective: {} };
  for (const shard of shards) {
    for (const kind of ["declared", "effective"]) {
      for (const [axis, values] of Object.entries(shard.dimensions?.[kind] || {})) {
        output[kind][axis] ||= {};
        for (const [value, metrics] of Object.entries(values)) {
          output[kind][axis][value] ||= { profiles: 0, profilesWithPlans: 0, noPlans: 0, acceptedPlans: 0 };
          for (const field of Object.keys(output[kind][axis][value])) {
            output[kind][axis][value][field] += number(metrics[field]);
          }
        }
      }
    }
  }
  return output;
}

function mergeHighRiskCombinations(shards) {
  const values = new Map();
  for (const item of shards.flatMap(shard => shard.highRiskCombinations || [])) {
    const current = values.get(item.id) || { id: item.id, profiles: 0, profilesWithPlans: 0, noPlans: 0, acceptedPlans: 0 };
    for (const field of ["profiles", "profilesWithPlans", "noPlans", "acceptedPlans"]) current[field] += number(item[field]);
    values.set(item.id, current);
  }
  return [...values.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function duplicateGroups(profiles) {
  const groups = new Map();
  for (const profile of profiles) {
    const ids = groups.get(profile.plannerInputHash) || [];
    ids.push(profile.profileId);
    groups.set(profile.plannerInputHash, ids);
  }
  return [...groups.entries()]
    .filter(([hash, ids]) => hash && ids.length > 1)
    .map(([plannerInputHash, profileIds]) => ({ plannerInputHash, profileIds: [...profileIds].sort() }))
    .sort((left, right) => left.plannerInputHash.localeCompare(right.plannerInputHash));
}

export function mergeGeneratedShards(shards) {
  invariant(Array.isArray(shards) && shards.length > 0, "MISSING_GENERATED_SHARDS", "At least one generated-profile shard is required.");
  for (const shard of shards) {
    invariant(shard?.schemaVersion === METRIC_SCHEMA_VERSION, "MALFORMED_GENERATED_SHARD", "Generated shards must use metric schema version 2.");
    invariant(shard?.kind === "econplanner-nightly-generated-matrix", "MALFORMED_GENERATED_SHARD", "Unexpected generated shard kind.");
  }
  const ordered = [...shards].sort((left, right) => number(left.selection?.shard?.index) - number(right.selection?.shard?.index));
  const provenance = shardProvenance(ordered);
  const totals = new Set(ordered.map(shard => number(shard.selection?.shard?.total)));
  invariant(totals.size === 1, "INCONSISTENT_SHARD_TOTAL", "Generated shards disagree about the shard total.");
  const expectedShards = [...totals][0];
  const indexes = ordered.map(shard => number(shard.selection?.shard?.index));
  invariant(new Set(indexes).size === indexes.length, "DUPLICATE_SHARD", "Generated shard indexes must be unique.");
  const missingShardIndexes = Array.from({ length: expectedShards }, (_, index) => index + 1).filter(index => !indexes.includes(index));
  const profiles = ordered.flatMap(shard => shard.profiles || []);
  const failures = ordered.flatMap(shard => shard.failures || []);
  const profileIds = [...profiles, ...failures].map(profile => profile.profileId);
  invariant(new Set(profileIds).size === profileIds.length, "DUPLICATE_PROFILE", "A generated profile was recorded more than once.");
  const strategyAttempts = profiles.flatMap(profile => profile.solverDiagnostics?.strategyAttempts || []);
  const searchAttempts = profiles.flatMap(profile => profile.solverDiagnostics?.searchAttempts || []);
  const acceptedNodeCounts = profiles.flatMap(profile => profile.solverNodes || []);
  const planObservability = profiles.flatMap(profile => profile.planObservability || []);
  const legacyFeasibilityStatuses = incrementSelected({}, planObservability, plan => plan.legacyFeasibilityStatus);
  const strategyFits = incrementSelected({}, planObservability, plan => `${plan.strategy || "UNKNOWN"}:${plan.strategyFit || "UNKNOWN"}`);
  const noPlanRows = profiles.filter(profile => profile.plans === 0).map(profile => ({
    seed: profile.seed,
    profileId: profile.profileId,
    plannerInputHash: profile.plannerInputHash,
    conclusion: profile.noPlan?.conclusion || "UNKNOWN",
    category: profile.noPlan?.category || normalizedNoPlanCategory(
      profile.noPlan?.reason || "UNEXPLAINED",
      profile.noPlan?.conclusion || "UNKNOWN"
    ),
    reason: profile.noPlan?.reason || "UNEXPLAINED",
    replay: profile.replay,
    attempts: profile.noPlan?.attempts || []
  }));
  const reasons = {};
  const categories = {};
  for (const row of noPlanRows) increment(reasons, row.reason);
  for (const row of noPlanRows) increment(categories, row.category);
  const runtimeByShard = ordered.map(shard => number(shard.metrics?.totalRuntimeMs));
  const maximumShardRuntime = runtimeByShard.length ? Math.max(...runtimeByShard) : 0;
  const medianShardRuntime = percentile(runtimeByShard, 0.5);
  const inputDuplicates = duplicateGroups(profiles);
  const validatorRejectionReasons = {};
  for (const attempt of strategyAttempts) {
    for (const [reason, count] of Object.entries(attempt.validatorRejectionReasons || {})) increment(validatorRejectionReasons, reason, number(count));
  }
  const firstSolverSolutionNodes = strategyAttempts
    .map(attempt => attempt.firstSolutionNode)
    .filter(value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)))
    .map(Number);
  const nodeLimitProfiles = profiles.filter(profile => (
    profile.solverDiagnostics?.strategyAttempts || []
  ).some(attempt => attempt.terminationReason === "NODE_LIMIT"));
  const nodeLimitProfilesWithLegacyValidatedDisplayedPlan = nodeLimitProfiles.filter(profile => (
    profile.planObservability || []
  ).some(plan => plan.legacyValidatedDisplayedPlan));
  return {
    provenance,
    expectedShards,
    presentShards: ordered.length,
    missingShardIndexes,
    seeds: ordered[0]?.selection?.seeds || [],
    profiles,
    failures,
    coverage: {
      profiles: {
        tested: profiles.length + failures.length,
        withPlans: profiles.filter(profile => profile.plans > 0).length,
        noPlans: noPlanRows.length,
        failures: failures.length,
        acceptedPlans: profiles.reduce((sum, profile) => sum + number(profile.plans), 0)
      },
      completion: {
        targetAvailability: "NOT_MEASURED",
        targetReasonCode: "PRODUCTION_DECISION_ENGINE_COMPLETION_CONTRACT_NOT_IMPLEMENTED",
        legacyValidationProxy: {
          availability: "PROXY",
          measurementBasis: "LEGACY_DISPLAYED_PLAN_VALIDATION_AND_UNSCHEDULED_COUNT",
          profilesWithLegacyValidatedDisplayedPlan: profiles.filter(profile => (
            profile.legacyValidatedDisplayedPlan
            || (profile.planObservability || []).some(plan => plan.legacyValidatedDisplayedPlan)
          )).length,
          displayedPlansValidatedAndScheduled: planObservability.filter(plan => plan.legacyValidatedDisplayedPlan).length,
          plansByLegacyFeasibilityStatus: legacyFeasibilityStatuses
        },
        primaryProductCoverage: {
          availability: "NOT_MEASURED",
          reasonCode: "PRODUCTION_DECISION_ENGINE_SNAPSHOT_AND_REPORT_CONTRACT_NOT_IMPLEMENTED",
          numerator: null,
          denominator: profiles.length + failures.length,
          denominatorAvailability: "MEASURED",
          percentage: null
        },
        perProfileReportReadiness: {
          availability: "NOT_MEASURED",
          reasonCode: "REPORT_AND_PDF_NOT_EXECUTED_FOR_EVERY_GENERATED_PROFILE",
          numerator: null,
          denominator: profiles.length + failures.length
        }
      },
      effectiveInputs: {
        uniqueHashes: new Set(profiles.map(profile => profile.plannerInputHash).filter(Boolean)).size,
        duplicateProfiles: inputDuplicates.reduce((sum, group) => sum + group.profileIds.length, 0),
        duplicateGroups: inputDuplicates
      },
      eco257: {
        acceptedStatisticsPlacements: ordered.reduce((sum, shard) => sum + number(shard.metrics?.acceptedEco257StatisticsPlacements), 0),
        acceptedElectivePlacements: ordered.reduce((sum, shard) => sum + number(shard.metrics?.acceptedEco257ElectivePlacements), 0),
        invalidElectiveAttempts: ordered.reduce((sum, shard) => sum + number(shard.metrics?.invalidEco257ElectiveAttempts), 0)
      },
      pairwise: ordered[0]?.selection?.effectivePairwiseCoverage || null,
      dimensions: mergeDimensionSummaries(ordered),
      highRiskCombinations: mergeHighRiskCombinations(ordered),
      deterministicCases: profiles.map(profile => ({
        seed: profile.seed,
        profileId: profile.profileId,
        plannerInputHash: profile.plannerInputHash,
        outcome: profile.plans > 0 ? "PLAN" : "NO_PLAN",
        displayedPlanCount: number(profile.plans),
        planSignatures: profile.planSignatures || [],
        replay: profile.replay || null
      })).sort((left, right) => `${left.seed}:${left.profileId}`.localeCompare(`${right.seed}:${right.profileId}`))
    },
    noPlan: {
      total: noPlanRows.length,
      explained: noPlanRows.filter(row => row.reason !== "UNEXPLAINED").length,
      unexplained: noPlanRows.filter(row => row.reason === "UNEXPLAINED").length,
      reasons,
      categories,
      productionFalseNegative: {
        availability: "NOT_MEASURED",
        reasonCode: "ORACLE_DOES_NOT_SEARCH_FOR_A_PLAN_WHEN_PRODUCTION_RETURNS_NO_PLAN",
        count: null
      },
      rows: noPlanRows
    },
    solver: {
      strategyAttempts: strategyAttempts.length,
      searchAttempts: searchAttempts.length,
      acceptedPlanNodes: distributionSummary(acceptedNodeCounts),
      attemptNodes: distributionSummary(strategyAttempts.map(attempt => attempt.nodesVisited)),
      attemptDurationMs: distributionSummary(strategyAttempts.map(attempt => attempt.durationMs)),
      candidatePoolSize: distributionSummary(strategyAttempts.map(attempt => attempt.candidatePoolSize)),
      completionAttempts: strategyAttempts.reduce((sum, attempt) => sum + number(attempt.completeSchedulesExamined), 0),
      prerequisiteFailures: searchAttempts.reduce((sum, attempt) => sum + number(attempt.prerequisiteFailures), 0),
      deadEnds: searchAttempts.reduce((sum, attempt) => sum + number(attempt.deadEnds), 0),
      validSolutions: strategyAttempts.reduce((sum, attempt) => sum + number(attempt.finalValidSchedules), 0),
      validatorRejections: strategyAttempts.reduce((sum, attempt) => sum + number(attempt.validatorRejectedSchedules), 0),
      validatorRejectionReasons: Object.fromEntries(Object.entries(validatorRejectionReasons).sort((left, right) => (
        right[1] - left[1] || left[0].localeCompare(right[0])
      ))),
      exactDuplicatesRemoved: strategyAttempts.reduce((sum, attempt) => sum + number(attempt.exactDuplicatesRemoved), 0),
      semanticDuplicatesRemoved: strategyAttempts.reduce((sum, attempt) => sum + number(attempt.semanticDuplicatesRemoved), 0),
      nodeLimitHits: strategyAttempts.filter(attempt => attempt.terminationReason === "NODE_LIMIT").length,
      solutionBudgetHits: searchAttempts.filter(attempt => attempt.solutionBudgetHit).length,
      firstSolverSolutionNodes: {
        availability: "MEASURED",
        measurementBasis: "PRE_FINAL_VALIDATOR_SOLVER_ASSIGNMENT",
        ...distributionSummary(firstSolverSolutionNodes)
      },
      timeToFirstCompletePlanMs: {
        availability: "NOT_MEASURED",
        reasonCode: "SOLVER_DOES_NOT_EMIT_FIRST_COMPLETE_SOLUTION_TIME",
        value: null
      },
      nodesToFirstCompleteApprovedPlan: {
        availability: "NOT_MEASURED",
        reasonCode: "FIRST_SOLUTION_NODE_PRECEDES_FINAL_VALIDATION",
        value: null
      },
      limitBehavior: {
        nodeLimitProfiles: nodeLimitProfiles.length,
        nodeLimitProfilesWithLegacyValidatedDisplayedPlan: nodeLimitProfilesWithLegacyValidatedDisplayedPlan.length,
        exactIncumbentPreservation: {
          availability: "NOT_MEASURED",
          reasonCode: "INCUMBENT_IDENTITY_AND_ALTERNATIVE_BUDGET_NOT_EMITTED",
          value: null
        }
      },
      slowestProfiles: [...profiles].sort((left, right) => number(right.durationMs) - number(left.durationMs)).slice(0, 10).map(profile => ({
        seed: profile.seed,
        profileId: profile.profileId,
        durationMs: profile.durationMs,
        plannerInputHash: profile.plannerInputHash,
        replay: profile.replay
      })),
      shardRuntimeMs: distributionSummary(runtimeByShard),
      shardImbalanceRatio: medianShardRuntime ? rounded(maximumShardRuntime / medianShardRuntime) : 0,
      processMaxRssBytes: Math.max(0, ...ordered.map(shard => number(shard.metrics?.processMemory?.maxRssBytes)))
    },
    strategies: {
      availability: "PROXY",
      measurementBasis: "CURRENT_VALIDATOR_DISTRIBUTION_RESULT",
      displayedPlanFits: strategyFits,
      convergences: profiles.reduce((sum, profile) => sum + (profile.strategyConvergences || []).length, 0)
    },
    moveDestinations: {
      availability: "NOT_MEASURED",
      reasonCode: "SERVER_DERIVED_DESTINATIONS_NOT_IMPLEMENTED_UNTIL_CP6",
      requests: null,
      destinations: null,
      classified: null
    },
    productionDecisionEngine: {
      availability: "NOT_MEASURED",
      reasonCode: "PRODUCTION_DECISION_ENGINE_NOT_IMPLEMENTED_UNTIL_CP3",
      decisions: null,
      latencyMs: null
    },
    policyCompiler: {
      availability: "NOT_MEASURED",
      reasonCode: "POLICY_COMPILER_NOT_IMPLEMENTED_UNTIL_CP2",
      compileTimeMs: null,
      conflicts: null,
      bundleHash: null
    },
    oracle: {
      disagreements: ordered.reduce((sum, shard) => sum + number(shard.metrics?.oracleDisagreementCount), 0),
      classified: ordered.reduce((sum, shard) => sum + number(shard.metrics?.classifiedOracleDisagreementCount), 0),
      unclassified: ordered.reduce((sum, shard) => sum + number(shard.metrics?.unclassifiedOracleDisagreementCount), 0),
      reviews: ordered.reduce((sum, shard) => sum + number(shard.metrics?.oracleReviewCount), 0)
    },
    profileDurationMs: distributionSummary(profiles.map(profile => profile.durationMs)),
    computeTimeMs: runtimeByShard.reduce((sum, value) => sum + value, 0)
  };
}

function comparePreviousSuccessful(generated, previous, provenance) {
  if (!previous) return { availability: "NOT_AVAILABLE" };
  const currentVersions = provenance || {};
  const priorVersions = previous.provenance || {};
  const compatible = ["generatorVersion", "oraclePolicyVersion", "scheduleVersion"].every(key => (
    currentVersions[key] === priorVersions[key]
  ));
  const previousCases = previous.coverage?.deterministicCases || [];
  const byHash = new Map(previousCases.filter(item => item.plannerInputHash).map(item => [item.plannerInputHash, item]));
  const byId = new Map(previousCases.map(item => [`${item.seed}:${item.profileId}`, item]));
  const changedCases = generated.coverage.deterministicCases.flatMap(current => {
    const prior = byHash.get(current.plannerInputHash) || byId.get(`${current.seed}:${current.profileId}`);
    if (!prior) return [];
    if (current.outcome === prior.outcome && JSON.stringify(current.planSignatures) === JSON.stringify(prior.planSignatures)) return [];
    return [{ current, previous: prior }];
  });
  return {
    availability: "AVAILABLE",
    runId: previous.provenance?.workflowRunId || null,
    compatible,
    matchedCases: generated.coverage.deterministicCases.length - generated.coverage.deterministicCases.filter(current => (
      !byHash.has(current.plannerInputHash) && !byId.has(`${current.seed}:${current.profileId}`)
    )).length,
    changedCases,
    metrics: {
      profilesTested: metricDelta(generated.coverage.profiles.tested, previous.coverage?.profiles?.tested),
      profilesWithPlans: metricDelta(generated.coverage.profiles.withPlans, previous.coverage?.profiles?.withPlans),
      noPlans: metricDelta(generated.coverage.profiles.noPlans, previous.coverage?.profiles?.noPlans),
      acceptedPlans: metricDelta(generated.coverage.profiles.acceptedPlans, previous.coverage?.profiles?.acceptedPlans),
      solverNodes: metricDelta(generated.solver.acceptedPlanNodes.total, previous.solver?.acceptedPlanNodes?.total)
    }
  };
}

function policyRuleIds(oraclePolicy) {
  return POLICY_RULE_GROUPS.flatMap(group => (oraclePolicy?.[group] || []).map(rule => rule.ruleId));
}

export function sourceEvidenceSummary(oraclePolicy) {
  const rules = POLICY_RULE_GROUPS.flatMap(group => oraclePolicy?.[group] || []);
  const confirmations = new Map((oraclePolicy?.confirmationRecords || []).map(record => [record.id, record]));
  const sourceIds = new Set((oraclePolicy?.sources || []).map(source => source.id));
  const missingSourceRules = rules.filter(rule => !(rule.sourceRefs || []).length).map(rule => rule.ruleId);
  const unknownSourceRules = rules.filter(rule => (rule.sourceRefs || []).some(reference => (
    !sourceIds.has(String(reference).split("#")[0])
  ))).map(rule => rule.ruleId);
  const missingConfirmationRules = rules.filter(rule => (
    rule.status === "CONFIRMED" && (!rule.confirmationRef || !confirmations.has(rule.confirmationRef))
  )).map(rule => rule.ruleId);
  return {
    policyId: oraclePolicy?.policy?.id || null,
    policyVersion: oraclePolicy?.policy?.version || null,
    confirmationDate: oraclePolicy?.policy?.confirmationDate || null,
    reviewedBy: oraclePolicy?.policy?.reviewedBy || null,
    sourceCount: sourceIds.size,
    ruleCount: rules.length,
    effectiveDateComplete: Boolean(oraclePolicy?.policy?.confirmationDate),
    reviewerSignoffPresent: Boolean(oraclePolicy?.policy?.reviewedBy),
    missingSourceRules,
    unknownSourceRules,
    missingConfirmationRules,
    sources: oraclePolicy?.sources || []
  };
}

export function validateObservabilityPolicy(observabilityPolicy, oraclePolicy, mutationRegistry = null) {
  invariant(observabilityPolicy?.schemaVersion === 1, "INVALID_OBSERVABILITY_POLICY", "Observability policy schemaVersion must be 1.");
  invariant(observabilityPolicy?.criticalRuleFamilies?.length === 19, "CRITICAL_FAMILY_COUNT", "Exactly 19 critical rule families are required.");
  invariant(new Set(observabilityPolicy.criticalRuleFamilies).size === 19, "DUPLICATE_CRITICAL_FAMILY", "Critical rule families must be unique.");
  const expectedRules = [...policyRuleIds(oraclePolicy), ...STRUCTURAL_RULE_IDS].sort();
  const declaredRules = (observabilityPolicy.ruleGroups || []).flatMap(group => group.ruleIds || []).sort();
  invariant(new Set(declaredRules).size === declaredRules.length, "DUPLICATE_RULE_MAPPING", "Every rule ID must appear in exactly one observability group.");
  invariant(JSON.stringify(declaredRules) === JSON.stringify(expectedRules), "RULE_MAPPING_INCOMPLETE", "Observability rule IDs must exactly match oracle and structural rules.");
  const families = new Set(observabilityPolicy.criticalRuleFamilies);
  const layers = new Set(observabilityPolicy.layers || []);
  for (const group of observabilityPolicy.ruleGroups || []) {
    invariant(group.criticalFamilies?.length > 0, "MISSING_RULE_CRITICALITY", `${group.group} has no critical family.`);
    invariant(group.criticalFamilies.every(family => families.has(family)), "UNKNOWN_CRITICAL_FAMILY", `${group.group} references an unknown critical family.`);
    invariant(group.positiveTests?.length > 0 && group.negativeTests?.length > 0, "MISSING_RULE_TEST_POLARITY", `${group.group} needs positive and negative tests.`);
    invariant(Object.keys(group.layers || {}).every(layer => layers.has(layer)), "UNKNOWN_COVERAGE_LAYER", `${group.group} references an unknown coverage layer.`);
    invariant([...layers].every(layer => observabilityPolicy.layerValues.includes(group.layers?.[layer])), "INCOMPLETE_COVERAGE_LAYER", `${group.group} must classify every layer.`);
  }
  for (const event of observabilityPolicy.syntheticCriticalEvents || []) {
    invariant(families.has(event.criticalFamily), "UNKNOWN_SYNTHETIC_FAMILY", `${event.code} references an unknown critical family.`);
  }
  if (mutationRegistry) {
    const knownRules = new Set(declaredRules);
    for (const mutation of mutationRegistry.mutations || []) {
      invariant(knownRules.has(mutation.ruleId), "UNMAPPED_MUTATION_RULE", `${mutation.id} references unmapped rule ${mutation.ruleId}.`);
    }
  }
  return { valid: true, ruleCount: declaredRules.length, criticalFamilyCount: families.size };
}

export function ruleCoverageSummary(observabilityPolicy) {
  const rows = (observabilityPolicy.ruleGroups || []).flatMap(group => group.ruleIds.map(ruleId => ({
    ruleId,
    group: group.group,
    criticalFamilies: group.criticalFamilies,
    layers: group.layers,
    implementationRefs: group.implementationRefs,
    positiveTests: group.positiveTests,
    negativeTests: group.negativeTests,
    knownGapCodes: group.knownGapCodes || []
  })));
  const uiOnly = rows.filter(row => row.layers.ui_parity === "IMPLEMENTED"
    && row.layers.production_validator !== "IMPLEMENTED"
    && row.layers.independent_oracle !== "IMPLEMENTED");
  const missingProductionOrOracle = rows.filter(row => (
    row.layers.production_validator === "MISSING" || row.layers.independent_oracle === "MISSING"
  ));
  const missingByLayer = Object.fromEntries((observabilityPolicy.layers || []).map(layer => [
    layer,
    rows.filter(row => row.layers[layer] === "MISSING").map(row => row.ruleId)
  ]));
  return { ruleCount: rows.length, rows, uiOnly, missingProductionOrOracle, missingByLayer };
}

function metricDelta(current, baseline) {
  if (baseline === undefined || baseline === null) return { availability: "NOT_AVAILABLE_IN_BASELINE", current };
  const absolute = number(current) - number(baseline);
  return {
    availability: "AVAILABLE",
    current: number(current),
    baseline: number(baseline),
    absolute,
    percentage: number(baseline) === 0 ? null : rounded((absolute / number(baseline)) * 100)
  };
}

export function compareApprovedBaseline(generated, prerequisite, browser, pdf, baseline, baselineCases = null, currentProvenance = {}) {
  const comparisons = {
    profilesTested: metricDelta(generated.coverage.profiles.tested, baseline.generated?.profilesTested),
    profilesWithPlans: metricDelta(generated.coverage.profiles.withPlans, baseline.generated?.profilesWithPlans),
    profilesWithoutPlans: metricDelta(generated.coverage.profiles.noPlans, baseline.generated?.profilesWithoutPlans),
    acceptedPlanCount: metricDelta(generated.coverage.profiles.acceptedPlans, baseline.generated?.acceptedPlanCount),
    generatedFailures: metricDelta(generated.coverage.profiles.failures, baseline.generated?.failureCount),
    oracleDisagreements: metricDelta(generated.oracle.disagreements, baseline.generated?.oracleDisagreementCount),
    oracleReviews: metricDelta(generated.oracle.reviews, baseline.generated?.oracleReviewCount),
    profileP50Ms: metricDelta(generated.profileDurationMs.p50, baseline.generated?.profileDurationMs?.p50),
    profileP95Ms: metricDelta(generated.profileDurationMs.p95, baseline.generated?.profileDurationMs?.p95),
    profileMaxMs: metricDelta(generated.profileDurationMs.maximum, baseline.generated?.profileDurationMs?.maximum),
    solverTotalNodes: metricDelta(generated.solver.acceptedPlanNodes.total, baseline.generated?.solverNodes?.total),
    solverP50Nodes: metricDelta(generated.solver.acceptedPlanNodes.p50, baseline.generated?.solverNodes?.p50),
    solverP95Nodes: metricDelta(generated.solver.acceptedPlanNodes.p95, baseline.generated?.solverNodes?.p95),
    solverMaxNodes: metricDelta(generated.solver.acceptedPlanNodes.maximum, baseline.generated?.solverNodes?.maximum),
    acceptedEco257StatisticsPlacements: metricDelta(
      generated.coverage.eco257.acceptedStatisticsPlacements,
      baseline.generated?.acceptedEco257StatisticsPlacements
    ),
    acceptedEco257ElectivePlacements: metricDelta(
      generated.coverage.eco257.acceptedElectivePlacements,
      baseline.generated?.acceptedEco257ElectivePlacements
    ),
    invalidEco257ElectiveAttempts: metricDelta(
      generated.coverage.eco257.invalidElectiveAttempts,
      baseline.generated?.invalidEco257ElectiveAttempts
    ),
    prerequisiteCases: metricDelta(prerequisite?.metrics?.totalPrerequisiteCasesExecuted, baseline.prerequisites?.cases),
    prerequisiteDisagreements: metricDelta(
      number(prerequisite?.metrics?.normalProductionDisagreements) + number(prerequisite?.metrics?.optionalProductionDisagreements),
      baseline.prerequisites?.productionDisagreements
    ),
    browserExecutions: metricDelta(browser?.metrics?.baselineComparableTestExecutions ?? browser?.metrics?.testExecutions, baseline.browser?.testExecutions),
    browserFailures: metricDelta(browser?.metrics?.failed, baseline.browser?.failed),
    effectiveUniqueInputs: metricDelta(generated.coverage.effectiveInputs.uniqueHashes, undefined),
    duplicateEffectiveProfiles: metricDelta(generated.coverage.effectiveInputs.duplicateProfiles, undefined),
    explainedNoPlans: metricDelta(generated.noPlan.explained, undefined),
    attemptNodeP90: metricDelta(generated.solver.attemptNodes.p90, undefined),
    attemptDurationP90Ms: metricDelta(generated.solver.attemptDurationMs.p90, undefined),
    processMaxRssBytes: metricDelta(generated.solver.processMaxRssBytes, undefined),
    browserRetries: metricDelta(browser?.metrics?.retryCount, undefined),
    materialParityMismatches: metricDelta(browser?.metrics?.materialParityMismatchCount, undefined)
  };
  const expectedCases = new Map((baselineCases?.outcomes || []).map(value => {
    const separator = value.lastIndexOf("=");
    return [value.slice(0, separator), Number(value.slice(separator + 1))];
  }));
  const deterministicChanges = generated.coverage.deterministicCases.flatMap(current => {
    if (!expectedCases.has(current.profileId)) return [];
    const expectedPlanCount = expectedCases.get(current.profileId);
    return current.displayedPlanCount === expectedPlanCount ? [] : [{
      seed: current.seed,
      profileId: current.profileId,
      expectedPlanCount,
      currentPlanCount: current.displayedPlanCount,
      replay: current.replay
    }];
  });
  const versionCompatible = ["generatorVersion", "oraclePolicyVersion", "scheduleVersion"].every(key => (
    baseline?.versions?.[key] === currentProvenance?.[key]
  ));
  return {
    availability: baseline?.approved ? "AVAILABLE" : "NOT_AVAILABLE",
    baselineId: baseline?.baselineId || null,
    schemaVersion: baseline?.schemaVersion || null,
    sourceRunId: baseline?.source?.runId || null,
    hostedPdfComparable: pdf?.hosted?.configuration === baseline?.hostedPdf?.configuration,
    metrics: comparisons,
    deterministicCases: {
      availability: baselineCases ? "AVAILABLE" : "NOT_AVAILABLE_IN_BASELINE",
      planSignatures: "NOT_AVAILABLE_IN_BASELINE",
      compatible: versionCompatible,
      expected: expectedCases.size,
      matched: generated.coverage.deterministicCases.filter(current => expectedCases.has(current.profileId)).length,
      missingFromCurrent: [...expectedCases.keys()].filter(profileId => !generated.coverage.deterministicCases.some(current => current.profileId === profileId)),
      newInCurrent: generated.coverage.deterministicCases.filter(current => !expectedCases.has(current.profileId)).map(current => current.profileId),
      changed: deterministicChanges
    }
  };
}

function performanceRegressions(comparison) {
  const names = ["profileP50Ms", "profileP95Ms", "profileMaxMs", "solverTotalNodes", "solverP50Nodes", "solverP95Nodes", "solverMaxNodes"];
  return names.filter(name => comparison.metrics?.[name]?.availability === "AVAILABLE" && comparison.metrics[name].absolute > 0);
}

function performanceCalibration(approvedBaseline, previous, currentRunId) {
  const metricNames = ["profileP50Ms", "profileP95Ms", "profileMaxMs", "solverTotalNodes", "solverP50Nodes", "solverP95Nodes", "solverMaxNodes"];
  const ratios = Object.fromEntries(metricNames.flatMap(name => {
    const metric = approvedBaseline.metrics?.[name];
    return metric?.availability === "AVAILABLE" && metric.baseline > 0
      ? [[name, rounded(metric.current / metric.baseline)]]
      : [];
  }));
  const previousSamples = previous?.performance?.calibration?.samples || [];
  const samples = [...previousSamples, {
    runId: currentRunId || null,
    recordedAt: new Date().toISOString(),
    ratios
  }].slice(-3);
  const proposedRatios = {};
  if (samples.length >= 3) {
    for (const name of metricNames) {
      const values = samples.map(sample => sample.ratios?.[name]).filter(Number.isFinite);
      if (values.length < 3) continue;
      const median = percentile(values, 0.5);
      const deviations = values.map(value => Math.abs(value - median));
      proposedRatios[name] = {
        median: rounded(median),
        medianAbsoluteDeviation: rounded(percentile(deviations, 0.5)),
        proposedMaximumRatio: rounded(median + 3 * percentile(deviations, 0.5))
      };
    }
  }
  return {
    requiredComparableRuns: 3,
    comparableRuns: samples.length,
    timingOnlyRedEnabled: false,
    samples,
    proposedThresholdFixture: samples.length >= 3 ? {
      status: "PENDING_OWNER_APPROVAL",
      method: "median-plus-three-mad-of-paired-baseline-ratios",
      ratios: proposedRatios
    } : null
  };
}

function criticalDifferenceCount(prerequisite, criticalCodes) {
  return criticalCodes.reduce((sum, code) => sum
    + number(prerequisite?.normal?.disagreementClasses?.[code])
    + number(prerequisite?.optional?.disagreementClasses?.[code]), 0);
}

export function evaluateGates({ generated, prerequisite, browser, pdf, phases, comparison, coverage, mutations, artifactCompleteness, sourceEvidence, governance, observabilityPolicy }) {
  const red = [];
  const amber = [];
  if (generated.missingShardIndexes.length) red.push({ code: "MISSING_GENERATED_SHARD", details: generated.missingShardIndexes });
  if (!generated.provenance.identityComplete) {
    red.push({ code: "INCOMPLETE_GENERATED_SHARD_PROVENANCE", details: generated.provenance.missingIdentityByShard });
  }
  if (generated.failures.length) red.push({ code: "GENERATED_PROFILE_FAILURE", count: generated.failures.length });
  if (generated.coverage.eco257.acceptedElectivePlacements) red.push({ code: "INVALID_DISPLAYED_PLAN", count: generated.coverage.eco257.acceptedElectivePlacements });
  if (generated.noPlan.unexplained) red.push({ code: "UNEXPLAINED_NO_PLAN", count: generated.noPlan.unexplained });
  const falseInfeasible = generated.noPlan.rows.filter(row => row.conclusion === "PROVEN_INFEASIBLE" && row.attempts.some(attempt => !attempt.exhaustive));
  if (falseInfeasible.length) red.push({ code: "INCOMPLETE_SEARCH_LABELED_INFEASIBLE", count: falseInfeasible.length });
  if (generated.oracle.unclassified) red.push({ code: "UNCLASSIFIED_ORACLE_FINDING", count: generated.oracle.unclassified });
  const criticalDifferences = criticalDifferenceCount(prerequisite, observabilityPolicy.criticalFindingCodes || []);
  if (criticalDifferences) red.push({ code: "CRITICAL_PRODUCTION_ORACLE_DIFFERENCE", count: criticalDifferences });
  if (number(prerequisite?.metrics?.unexpectedDisagreements)) red.push({ code: "UNEXPECTED_ORACLE_DISAGREEMENT", count: prerequisite.metrics.unexpectedDisagreements });
  if (number(browser?.metrics?.failed)) red.push({ code: "BROWSER_TEST_FAILURE", count: browser.metrics.failed });
  if (number(browser?.metrics?.materialParityMismatchCount)) red.push({ code: "MATERIAL_ARTIFACT_PARITY_MISMATCH", count: browser.metrics.materialParityMismatchCount });
  if (number(browser?.metrics?.seriousOrCriticalAccessibilityFindings)) red.push({ code: "CRITICAL_ACCESSIBILITY_FINDING", count: browser.metrics.seriousOrCriticalAccessibilityFindings });
  if (pdf?.hosted?.status === "FAILED" || pdf?.local?.status === "FAILED") red.push({ code: "PDF_CONTRACT_FAILURE" });
  for (const phase of phases || []) {
    if (["FAILED", "TIMED_OUT"].includes(phase.status) && phase.required !== false) red.push({ code: "REQUIRED_PHASE_FAILED", phase: phase.phaseId, status: phase.status });
  }
  if (coverage.missingProductionOrOracle.length) red.push({ code: "CRITICAL_RULE_COVERAGE_GAP", count: coverage.missingProductionOrOracle.length });
  if (mutations.survivedCritical) red.push({ code: "SURVIVING_CRITICAL_MUTATION", count: mutations.survivedCritical });
  if (artifactCompleteness.missingMandatoryKinds.length) red.push({ code: "MISSING_MANDATORY_ARTIFACT", details: artifactCompleteness.missingMandatoryKinds });
  if (artifactCompleteness.missingMandatoryPhases.length) red.push({ code: "MISSING_MANDATORY_PHASE", details: artifactCompleteness.missingMandatoryPhases });
  if (!sourceEvidence?.effectiveDateComplete || !sourceEvidence?.reviewerSignoffPresent
    || sourceEvidence?.missingSourceRules?.length || sourceEvidence?.unknownSourceRules?.length
    || sourceEvidence?.missingConfirmationRules?.length) {
    red.push({ code: "SOURCE_IDENTITY_MISSING" });
  }
  if (comparison.previousSuccessful?.compatible && comparison.previousSuccessful.changedCases?.length) {
    red.push({ code: "DETERMINISTIC_OUTCOME_CHANGED", count: comparison.previousSuccessful.changedCases.length });
  }
  if (comparison.approvedBaseline?.deterministicCases?.compatible && (
    comparison.approvedBaseline.deterministicCases.changed.length
    || comparison.approvedBaseline.deterministicCases.missingFromCurrent.length
    || comparison.approvedBaseline.deterministicCases.newInCurrent.length
  )) {
    red.push({
      code: "DETERMINISTIC_OUTCOME_CHANGED",
      count: comparison.approvedBaseline.deterministicCases.changed.length
        + comparison.approvedBaseline.deterministicCases.missingFromCurrent.length
        + comparison.approvedBaseline.deterministicCases.newInCurrent.length,
      replayCases: comparison.approvedBaseline.deterministicCases.changed
    });
  }
  if (pdf?.hosted?.configuration === "NOT_CONFIGURED") amber.push({ code: "HOSTED_PDF_NOT_CONFIGURED" });
  if (number(browser?.metrics?.flakeObservationCount) || number(browser?.metrics?.retryCount)) amber.push({ code: "BROWSER_FLAKE_OR_RETRY" });
  if (number(browser?.metrics?.moderateOrMinorAccessibilityFindings)) amber.push({ code: "NONCRITICAL_ACCESSIBILITY_FINDING", count: browser.metrics.moderateOrMinorAccessibilityFindings });
  if (governance && !governance.ownerApprovalComplete) amber.push({ code: "OWNER_REVIEW_PENDING" });
  if (comparison.previousSuccessful?.availability !== "AVAILABLE") amber.push({ code: "PREVIOUS_SUCCESSFUL_NOT_AVAILABLE" });
  const performance = performanceRegressions(comparison.approvedBaseline);
  if (performance.length) amber.push({ code: "PERFORMANCE_OUTSIDE_BASELINE", metrics: performance });
  return { overall: red.length ? "RED" : amber.length ? "AMBER" : "GREEN", red, amber };
}

function workflowWallTime(provenance) {
  const start = Date.parse(provenance.startedAt || "");
  const end = Date.parse(provenance.completedAt || "");
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

export function buildAggregate({
  shards,
  prerequisite = null,
  browser = null,
  pdf = null,
  phases = [],
  notifications = [],
  baseline,
  baselineCases = null,
  previous = null,
  observabilityPolicy,
  oraclePolicy,
  mutationRegistry,
  sourceEvidence = null,
  provenance = {}
}) {
  validateObservabilityPolicy(observabilityPolicy, oraclePolicy, mutationRegistry);
  for (const phase of phases) {
    invariant(phase?.schemaVersion === METRIC_SCHEMA_VERSION && phase?.kind === "econplanner-nightly-phase", "MALFORMED_PHASE_ARTIFACT", "Phase artifacts must use schema version 2.");
    invariant(EXECUTION_VALUES.has(phase.status), "MALFORMED_PHASE_ARTIFACT", `${phase.phaseId || "unknown"} has an invalid execution status.`);
  }
  for (const [label, artifact, expectedKind] of [
    ["prerequisite", prerequisite, "econplanner-nightly-prerequisites"],
    ["browser", browser, "econplanner-nightly-browser"],
    ["pdf", pdf, "econplanner-nightly-pdf"]
  ]) {
    if (!artifact) continue;
    invariant(artifact.schemaVersion === METRIC_SCHEMA_VERSION && artifact.kind === expectedKind, "MALFORMED_PHASE_ARTIFACT", `${label} artifact must use schema version 2.`);
  }
  const generated = mergeGeneratedShards(shards);
  for (const field of [
    "repository",
    "commitSha",
    "originMainSha",
    "branch",
    "workflowName",
    "workflowRunId"
  ]) {
    const shardValue = generated.provenance[field];
    const runtimeValue = provenance[field];
    if (shardValue === null || shardValue === undefined || runtimeValue === null || runtimeValue === undefined) continue;
    invariant(
      String(shardValue) === String(runtimeValue),
      "MIXED_RUN_PROVENANCE",
      `Aggregate runtime ${field} does not match generated-shard ${field}.`
    );
  }
  const currentAttempt = provenance.workflowAttempt === null || provenance.workflowAttempt === undefined
    ? null
    : Number(provenance.workflowAttempt);
  if (currentAttempt !== null) {
    invariant(
      Number.isInteger(currentAttempt) && currentAttempt >= 1,
      "MALFORMED_RUN_PROVENANCE",
      "Aggregate workflow attempt must be a positive integer."
    );
    invariant(
      generated.provenance.inputWorkflowAttempts.every(attempt => attempt <= currentAttempt),
      "MIXED_RUN_PROVENANCE",
      "Generated-shard workflow attempts cannot be newer than the aggregate attempt."
    );
  }
  const runProvenance = mergePresentValues(
    shards[0]?.provenance,
    generated.provenance,
    provenance,
    { inputWorkflowAttempts: generated.provenance.inputWorkflowAttempts }
  );
  const coverage = ruleCoverageSummary(observabilityPolicy);
  const approvedBaseline = compareApprovedBaseline(
    generated,
    prerequisite,
    browser,
    pdf,
    baseline,
    baselineCases,
    runProvenance
  );
  const comparison = {
    approvedBaseline,
    previousSuccessful: comparePreviousSuccessful(generated, previous, runProvenance)
  };
  const familyByRule = new Map((observabilityPolicy.ruleGroups || []).flatMap(group => (
    (group.ruleIds || []).map(ruleId => [ruleId, group.criticalFamilies || []])
  )));
  const mutationRows = (mutationRegistry?.mutations || []).map(mutation => ({
    id: mutation.id,
    mutationId: mutation.mutationId,
    ruleId: mutation.ruleId,
    criticalFamilies: familyByRule.get(mutation.ruleId) || [],
    status: mutation.status,
    killed: mutation.status !== "CONFIRMED_DEFECT"
  }));
  const mutations = {
    total: mutationRows.length,
    killed: mutationRows.filter(row => row.killed).length,
    survived: mutationRows.filter(row => !row.killed).length,
    survivedCritical: mutationRows.filter(row => !row.killed && row.criticalFamilies.length).length,
    killRate: mutationRows.length ? rounded(mutationRows.filter(row => row.killed).length / mutationRows.length) : null,
    rows: mutationRows
  };
  const presentKinds = [...new Set([
    ...shards.map(item => item.kind),
    prerequisite?.kind,
    browser?.kind,
    pdf?.kind,
    ...phases.map(item => item.kind)
  ].filter(Boolean))];
  const artifactCompleteness = {
    expectedGeneratedShards: generated.expectedShards,
    presentGeneratedShards: generated.presentShards,
    missingGeneratedShards: generated.missingShardIndexes,
    mandatoryKinds: observabilityPolicy.mandatoryArtifactKinds,
    presentKinds,
    missingMandatoryKinds: (observabilityPolicy.mandatoryArtifactKinds || []).filter(kind => !presentKinds.includes(kind)),
    mandatoryPhases: observabilityPolicy.mandatoryPhaseIds || [],
    presentPhases: phases.map(phase => phase.phaseId),
    missingMandatoryPhases: (observabilityPolicy.mandatoryPhaseIds || []).filter(phaseId => !phases.some(phase => phase.phaseId === phaseId))
  };
  const distinctMandatoryKinds = (observabilityPolicy.mandatoryArtifactKinds || []).filter(kind => ![
    "econplanner-nightly-generated-matrix",
    "econplanner-nightly-phase"
  ].includes(kind));
  artifactCompleteness.expected = generated.expectedShards + artifactCompleteness.mandatoryPhases.length + distinctMandatoryKinds.length;
  artifactCompleteness.present = generated.presentShards + artifactCompleteness.presentPhases.length
    + distinctMandatoryKinds.filter(kind => presentKinds.includes(kind)).length;
  artifactCompleteness.missing = [
    ...generated.missingShardIndexes.map(index => `generated-profile-shard-${index}`),
    ...artifactCompleteness.missingMandatoryPhases,
    ...artifactCompleteness.missingMandatoryKinds.filter(kind => ![
      "econplanner-nightly-generated-matrix",
      "econplanner-nightly-phase"
    ].includes(kind))
  ];
  const aggregate = {
    schemaVersion: METRIC_SCHEMA_VERSION,
    kind: "econplanner-nightly-aggregate",
    generatedAt: new Date().toISOString(),
    dataClassification: "fictional-test-only",
    governance: {
      baselineSnapshotReview: baseline?.snapshotOwnerReview?.status || "NOT_RECORDED",
      ruleRegistryReview: observabilityPolicy?.ownerReview?.status || "NOT_RECORDED",
      ownerApprovalComplete: baseline?.snapshotOwnerReview?.status === "APPROVED"
        && observabilityPolicy?.ownerReview?.status === "APPROVED"
    },
    provenance: {
      ...runProvenance,
      seeds: generated.seeds,
      metricSchemaVersion: METRIC_SCHEMA_VERSION
    },
    artifactCompleteness,
    coverage: generated.coverage,
    noPlan: generated.noPlan,
    solver: generated.solver,
    strategies: generated.strategies,
    moveDestinations: generated.moveDestinations,
    productionDecisionEngine: generated.productionDecisionEngine,
    policyCompiler: generated.policyCompiler,
    validation: {
      oracle: generated.oracle,
      prerequisite,
      ruleCoverage: coverage,
      oracleQuality: {
        activeRules: policyRuleIds(oraclePolicy).filter(ruleId => !ruleId.startsWith("REVIEW-")).length,
        reviewRules: policyRuleIds(oraclePolicy).filter(ruleId => ruleId.startsWith("REVIEW-")).length,
        sources: sourceEvidence || sourceEvidenceSummary(oraclePolicy),
        mutations
      }
    },
    browser,
    pdf,
    workflow: {
      phases,
      notifications,
      wallTimeMs: workflowWallTime(runProvenance),
      computeTimeMs: generated.computeTimeMs + phases.reduce((sum, phase) => sum + number(phase.durationMs), 0)
    },
    comparison,
    performance: {
      regressions: performanceRegressions(approvedBaseline),
      calibration: performanceCalibration(
        approvedBaseline,
        comparison.previousSuccessful.compatible ? previous : null,
        runProvenance.workflowRunId
      )
    }
  };
  const effectiveSourceEvidence = aggregate.validation.oracleQuality.sources;
  aggregate.gates = evaluateGates({ generated, prerequisite, browser, pdf, phases, comparison, coverage, mutations, artifactCompleteness, sourceEvidence: effectiveSourceEvidence, governance: aggregate.governance, observabilityPolicy });
  aggregate.gateStatus = aggregate.gates.overall;
  return aggregate;
}

export function comparisonArtifact(aggregate) {
  return {
    schemaVersion: METRIC_SCHEMA_VERSION,
    kind: "econplanner-nightly-comparison",
    generatedAt: aggregate.generatedAt,
    provenance: aggregate.provenance,
    gateStatus: aggregate.gateStatus,
    comparison: aggregate.comparison,
    gates: aggregate.gates
  };
}

export function renderSummaryMarkdown(aggregate) {
  const profile = aggregate.coverage.profiles;
  const completion = aggregate.coverage.completion || {
    targetAvailability: "NOT_AVAILABLE",
    legacyValidationProxy: { availability: "NOT_AVAILABLE", profilesWithLegacyValidatedDisplayedPlan: 0 },
    primaryProductCoverage: { availability: "NOT_AVAILABLE" }
  };
  const legacyValidation = completion.legacyValidationProxy || {
    availability: "NOT_AVAILABLE",
    profilesWithLegacyValidatedDisplayedPlan: 0
  };
  const firstSolverSolution = aggregate.solver.firstSolverSolutionNodes || {
    measurementBasis: "NOT_AVAILABLE",
    p50: 0,
    p95: 0,
    maximum: 0
  };
  const timeToFirstComplete = aggregate.solver.timeToFirstCompletePlanMs || { availability: "NOT_AVAILABLE" };
  const incumbentPreservation = aggregate.solver.limitBehavior?.exactIncumbentPreservation || { availability: "NOT_AVAILABLE" };
  const lines = [
    "# EconPlanner nightly observability",
    "",
    `**Status:** ${aggregate.gateStatus}`,
    `**Provenance:** commit \`${aggregate.provenance.commitSha || "unavailable"}\`; origin/main \`${aggregate.provenance.originMainSha || "unavailable"}\`; run ${aggregate.provenance.workflowRunId ?? "local"}; attempt ${aggregate.provenance.workflowAttempt ?? "local"}; input attempts ${(aggregate.provenance.inputWorkflowAttempts || []).join(", ") || "local"}; worktree ${aggregate.provenance.worktreeStatus || "unknown"}.`,
    `Owner review: baseline ${aggregate.governance.baselineSnapshotReview}; rule registry ${aggregate.governance.ruleRegistryReview}.`,
    "",
    `Profiles: ${profile.tested} tested; ${profile.withPlans} with plans; ${profile.noPlans} no-plan; ${profile.failures} failures.`,
    `Legacy validated displayed-plan proxy: ${legacyValidation.profilesWithLegacyValidatedDisplayedPlan}/${profile.tested} profiles (${legacyValidation.availability}).`,
    `Primary COMPLETE + Decision Engine approved + snapshot/report-ready coverage: ${completion.primaryProductCoverage.availability}.`,
    `No-plan accountability: ${aggregate.noPlan.explained}/${aggregate.noPlan.total} explained.`,
    `No-plan taxonomy: ${Object.entries(aggregate.noPlan.categories || {}).map(([key, value]) => `${key}=${value}`).join(", ") || "none"}.`,
    `Displayed plans: ${profile.acceptedPlans}. Solver nodes: p50 ${aggregate.solver.acceptedPlanNodes.p50}, p95 ${aggregate.solver.acceptedPlanNodes.p95}, max ${aggregate.solver.acceptedPlanNodes.maximum}.`,
    `First solver solution nodes (${firstSolverSolution.measurementBasis}): p50 ${firstSolverSolution.p50}, p95 ${firstSolverSolution.p95}, max ${firstSolverSolution.maximum}.`,
    `Time to first complete plan: ${timeToFirstComplete.availability}; exact incumbent preservation: ${incumbentPreservation.availability}.`,
    `Workflow time: ${aggregate.workflow.wallTimeMs ?? "unavailable"} ms wall; ${rounded(aggregate.workflow.computeTimeMs)} ms summed compute.`,
    "",
    "## RED",
    "",
    ...(aggregate.gates.red.length ? aggregate.gates.red.map(item => `- ${item.code}${item.count === undefined ? "" : `: ${item.count}`}`) : ["- None"]),
    "",
    "## AMBER",
    "",
    ...(aggregate.gates.amber.length ? aggregate.gates.amber.map(item => `- ${item.code}`) : ["- None"]),
    "",
    "## Slowest profiles",
    "",
    ...aggregate.solver.slowestProfiles.slice(0, 5).map(item => `- ${item.profileId}: ${item.durationMs} ms`)
  ];
  return `${lines.join("\n")}\n`;
}

export { EXECUTION_VALUES, METRIC_SCHEMA_VERSION };
