#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { loadPolicyBundle } from "../lib/policy/load-bundle.js";
import { buildDecisionComparisonRecord } from "../lib/decision-engine/shadow.js";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import {
  buildEconomicsTermPlans,
  semanticPlanSignature,
  validatePreferredDistribution
} from "../lib/planning/economics.js";
import {
  buildPlanningSlots,
  resolvePlanningContext
} from "../lib/planning/horizon.js";
import { auditExternalEconomicsPlanComplete } from "../tests/oracle/audit-external-plan.js";
import { loadCanonicalPolicy, oracleEvaluateCanonicalPlan } from "../tests/oracle/load-canonical-policy.js";
import {
  ECONOMICS_GENERATOR_VERSION,
  auditGeneratedFictionalProfile,
  generateFictionalEconomicsProfiles,
  generateInvalidEconomicsNeighbors,
  pairwiseCoverageReport,
  shrinkFictionalEconomicsProfile
} from "../tests/helpers/economics-generators.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SEEDS = Object.freeze([
  20260803,
  20260804,
  20260805,
  20260806,
  20270117,
  20270219,
  20270323,
  20270429
]);
const CP4_FROZEN_CONVERGENCE_PROFILES = Object.freeze([
  "fictional-econ-20260805-c014e0de",
  "fictional-econ-20270117-a6a8df79"
]);
const PROGRAM = Object.freeze({ id: "economics", name: "Economics" });
const METRIC_SCHEMA_VERSION = 2;
const STRATEGY_NAMES = Object.freeze({
  equal: "BALANCED",
  increasing: "STAGGERED",
  "standing-specific": "EXPLORE_FIRST",
  "early-graduation": "ONE_YEAR_EARLY"
});
const APPROVAL_TYPES = Object.freeze({
  "CONCURRENT-INTERMEDIATE-ECO-461": "DEPARTMENT_APPROVAL",
  "CONCURRENT-MATH-ECO-213": "INSTRUCTOR_APPROVAL",
  "CONCURRENT-MATH-ECO-214": "INSTRUCTOR_APPROVAL"
});
const CLASSIFIED_ORACLE_VIOLATIONS = new Set([
  "SCHEDULE_FUTURE_SOURCE_NOT_EXPLICIT"
]);
const CLASSIFIED_ORACLE_REVIEWS = new Set([
  "REVIEW-ADVANCED-COURSE-PREREQUISITE-CLOSURE",
  "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE",
  "SCHEDULE_SECTION_FULL_REVIEW"
]);

function gitValue(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

function runtimeProvenance() {
  const commitSha = process.env.GITHUB_SHA || gitValue(["rev-parse", "HEAD"]);
  const originMainSha = gitValue(["rev-parse", "origin/main"])
    || (process.env.GITHUB_REF_NAME === "main" ? process.env.GITHUB_SHA || null : null);
  const worktreeOutput = gitValue(["status", "--porcelain"]);
  return {
    repository: process.env.GITHUB_REPOSITORY || gitValue(["config", "--get", "remote.origin.url"]),
    commitSha,
    originMainSha,
    headMatchesOriginMain: commitSha && originMainSha ? commitSha === originMainSha : null,
    branch: process.env.GITHUB_REF_NAME || gitValue(["branch", "--show-current"]),
    workflowName: process.env.GITHUB_WORKFLOW || null,
    workflowRunId: numericEnvironmentValue("GITHUB_RUN_ID"),
    workflowAttempt: numericEnvironmentValue("GITHUB_RUN_ATTEMPT"),
    worktreeStatus: worktreeOutput === null ? "UNKNOWN" : worktreeOutput ? "DIRTY" : "CLEAN",
    provenanceSource: process.env.GITHUB_SHA ? "GITHUB_ACTIONS" : "LOCAL_GIT",
    os: `${os.platform()} ${os.release()}`,
    nodeVersion: process.version,
    pnpmVersion: process.env.PNPM_VERSION || null,
    metricSchemaVersion: METRIC_SCHEMA_VERSION
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === "playwright-summary") {
    await summarizePlaywright(options);
  } else if (options.mode === "prerequisite-summary") {
    await summarizePrerequisites(options);
  } else {
    await runMatrix(options);
  }
}

async function runMatrix(configuration) {
  const startedAt = performance.now();
  const [manifest, verifiedSchedule, requirements, prerequisites, schedule, policyBundle, canonicalPolicy] = await Promise.all([
    readJson("tests/oracle/economics-policy.v1.json"),
    readJson("tests/oracle/verified-schedule-2026-2027.json"),
    readJson("data/normalized/economics/requirements.json"),
    readJson("data/normalized/economics/prerequisites.json"),
    readJson("data/normalized/economics/schedule-2026-2027.json"),
    loadPolicyBundle({ allowPending: true }),
    loadCanonicalPolicy()
  ]);

  const generatedBySeed = configuration.seeds.map(seed => {
    const generated = generateFictionalEconomicsProfiles({
      seed,
      manifest,
      verifiedSchedule
    });
    const coverage = pairwiseCoverageReport(generated.profiles);
    invariant(
      coverage.missingPairs.length === 0,
      "PAIRWISE_COVERAGE_INCOMPLETE",
      `Seed ${seed} missed ${coverage.missingPairs.length} declared axis pairs.`
    );
    return { ...generated, coverage };
  });

  let allProfiles = generatedBySeed.flatMap(({ seed, profiles }) => (
    profiles.map(profile => ({ seed, profile }))
  ));
  if (configuration.profileFile) {
    const profile = JSON.parse(await readFile(configuration.profileFile, "utf8"));
    assertFictionalProfileFile(profile);
    allProfiles = [{ seed: profile.seed, profile }];
  }
  if (configuration.profileId) {
    allProfiles = allProfiles.filter(({ profile }) => profile.profileId === configuration.profileId);
    invariant(allProfiles.length === 1, "PROFILE_NOT_FOUND", `Could not find exactly one generated profile named ${configuration.profileId}.`);
  }
  const selectedProfiles = allProfiles.filter((_entry, index) => (
    index % configuration.shardTotal === configuration.shardIndex - 1
  ));
  const allEffectiveProfiles = allProfiles.map(({ profile }) => {
    const student = plannerStudent(profile);
    return {
      axes: effectivePlannerAxes(profile, student),
      plannerInputHash: canonicalPlannerInputHash(student),
      profileId: profile.profileId
    };
  });
  const effectivePairwiseCoverage = effectivePairwiseCoverageReport(allEffectiveProfiles);
  const duplicatePlannerInputs = duplicateInputGroups(allEffectiveProfiles);
  const profileResults = [];
  const failures = [];
  const reviewItems = [];
  const classifiedOracleFindings = [];
  let oracleDisagreementCount = 0;
  let unclassifiedOracleDisagreementCount = 0;
  let acceptedPlanCount = 0;
  let profilesWithPlans = 0;
  let explainedNoPlanCount = 0;
  let eco257StatisticsCount = 0;
  const noPlanReasons = new Map();
  const noPlanCategories = new Map();
  const decisionShadowRecords = [];

  for (const { seed, profile } of selectedProfiles) {
    const hashingStartedAt = performance.now();
    const effectiveStudent = plannerStudent(profile);
    const effectiveAxes = effectivePlannerAxes(profile, effectiveStudent);
    const canonicalInput = JSON.stringify(stableValue(effectiveStudent));
    const plannerInputHash = createHash("sha256").update(canonicalInput).digest("hex");
    const hashingDurationMs = roundDuration(performance.now() - hashingStartedAt);
    const profileStartedAt = performance.now();
    const heapUsedBefore = process.memoryUsage().heapUsed;
    try {
      const result = await evaluateProfile({
        profile,
        manifest,
        verifiedSchedule,
        requirements,
        prerequisites,
        schedule,
        policyBundle,
        canonicalPolicy
      });
      const durationMs = roundDuration(performance.now() - profileStartedAt);
      const heapUsedAfter = process.memoryUsage().heapUsed;
      if (result.noPlan) {
        invariant(result.noPlan.reason !== "UNEXPLAINED", "UNEXPLAINED_NO_PLAN", `${profile.profileId} produced no plan without stable evidence.`);
        invariant(
          result.noPlan.conclusion !== "PROVEN_INFEASIBLE" || result.noPlan.attempts.every(attempt => attempt.exhaustive),
          "INCOMPLETE_SEARCH_LABELED_INFEASIBLE",
          `${profile.profileId} was labeled infeasible after an incomplete search.`
        );
        explainedNoPlanCount += 1;
        noPlanReasons.set(result.noPlan.reason, (noPlanReasons.get(result.noPlan.reason) || 0) + 1);
        noPlanCategories.set(result.noPlan.category, (noPlanCategories.get(result.noPlan.category) || 0) + 1);
      }
      profileResults.push({
        seed,
        profileId: profile.profileId,
        sequenceIndex: profile.sequenceIndex,
        axes: profile.axes,
        effectiveAxes,
        plannerInputHash,
        metricsOverhead: {
          hashingAndCanonicalSerializationMs: hashingDurationMs,
          canonicalPlannerInputBytes: Buffer.byteLength(canonicalInput)
        },
        durationMs,
        memory: {
          heapUsedBeforeBytes: heapUsedBefore,
          heapUsedAfterBytes: heapUsedAfter,
          heapDeltaBytes: heapUsedAfter - heapUsedBefore,
          processMaxRssBytes: Number(process.resourceUsage().maxRSS || 0) * 1024
        },
        outcome: result.planCount > 0 ? "PLANS_PRODUCED" : "NO_PLAN",
        plans: result.planCount,
        planSignatures: result.planSignatures,
        planObservability: result.planObservability,
        legacyValidatedDisplayedPlan: result.planObservability.some(plan => plan.legacyValidatedDisplayedPlan),
        solverNodes: result.solverNodes,
        maximumSolverNodes: Math.max(0, ...result.solverNodes),
        solverDiagnostics: result.solverDiagnostics,
        candidateOutcomes: result.candidateOutcomes,
        strategyConvergences: result.strategyConvergences,
        planningGaps: result.planningGaps,
        noPlan: result.noPlan,
        replay: replayEvidence(seed, profile, configuration),
        oracleReviews: result.oracleReviews.length,
        classifiedOracleFindings: result.oracleFindings.length,
        decisionShadow: result.decisionShadow
      });
      acceptedPlanCount += result.planCount;
      profilesWithPlans += result.planCount > 0 ? 1 : 0;
      eco257StatisticsCount += result.eco257StatisticsCount;
      reviewItems.push(...result.oracleReviews.map(item => ({
        seed,
        profileId: profile.profileId,
        ...item
      })));
      classifiedOracleFindings.push(...result.oracleFindings.map(item => ({
        seed,
        profileId: profile.profileId,
        ...item
      })));
      decisionShadowRecords.push(...result.decisionShadow.map(record => ({ seed, profileId: profile.profileId, ...record })));
      console.log(JSON.stringify({
        event: "ECONOMICS_NIGHTLY_PROFILE_PASS",
        seed,
        shard: `${configuration.shardIndex}/${configuration.shardTotal}`,
        profileId: profile.profileId,
        durationMs,
        plans: result.planCount,
        solverNodes: result.solverNodes,
        noPlanReason: result.noPlan?.reason || null
      }));
    } catch (error) {
      const durationMs = roundDuration(performance.now() - profileStartedAt);
      const failure = {
        seed,
        shard: `${configuration.shardIndex}/${configuration.shardTotal}`,
        profileId: profile.profileId,
        sequenceIndex: profile.sequenceIndex,
        durationMs,
        classification: error.code || "UNCLASSIFIED_NIGHTLY_FAILURE",
        message: safeErrorMessage(error),
        axes: profile.axes,
        fictionalProfile: profile,
        plannerInputHash,
        metricsOverhead: {
          hashingAndCanonicalSerializationMs: hashingDurationMs,
          canonicalPlannerInputBytes: Buffer.byteLength(canonicalInput)
        },
        replay: replayEvidence(seed, profile, configuration),
        minimizedCounterexample: await minimizeCounterexample(profile, error.code, {
          manifest,
          verifiedSchedule,
          requirements,
          prerequisites,
          schedule,
          policyBundle,
          canonicalPolicy
        }, configuration.output)
      };
      if (["ORACLE_DISAGREEMENT", "UNCLASSIFIED_ORACLE_REVIEW"].includes(failure.classification)) {
        oracleDisagreementCount += 1;
        unclassifiedOracleDisagreementCount += 1;
      }
      failures.push(failure);
      console.error(JSON.stringify({ event: "ECONOMICS_NIGHTLY_PROFILE_FAIL", ...failure }));
    }
  }

  let invalidEco257ElectiveAttempts = 0;
  for (const seed of configuration.seeds) {
    const invalidNeighbors = generateInvalidEconomicsNeighbors({ seed, manifest, verifiedSchedule });
    for (const neighbor of invalidNeighbors) {
      invariant(
        neighbor.policyAudit.valid === false,
        "INVALID_NEIGHBOR_ACCEPTED",
        `${neighbor.profileId} was accepted by the independent policy audit.`
      );
      if (neighbor.invalidNeighbor.mutationId !== "eco-257-as-elective") continue;
      invalidEco257ElectiveAttempts += 1;
      invariant(
        neighbor.policyAudit.violations.some(item => item.ruleId === "ELECTIVE-ECO-257-STATISTICS-ONLY"),
        "ECO_257_ELECTIVE_ACCEPTED",
        `${neighbor.profileId} did not trigger the ECO 257 statistics-only rule.`
      );
    }
  }

  const durations = profileResults.map(result => result.durationMs);
  const nodeCounts = profileResults.flatMap(result => result.solverNodes);
  const attemptNodeCounts = profileResults.flatMap(result => (
    result.solverDiagnostics?.strategyAttempts || []
  ).map(attempt => attempt.nodesVisited));
  const attemptDurations = profileResults.flatMap(result => (
    result.solverDiagnostics?.strategyAttempts || []
  ).map(attempt => attempt.durationMs));
  const strategyAttempts = profileResults.flatMap(result => result.solverDiagnostics?.strategyAttempts || []);
  const firstSolverSolutionNodes = strategyAttempts
    .map(attempt => attempt.firstSolutionNode)
    .filter(value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)))
    .map(Number);
  const planObservability = profileResults.flatMap(result => result.planObservability || []);
  const legacyFeasibilityStatuses = countBy(planObservability, plan => plan.legacyFeasibilityStatus);
  const strategyFits = countBy(planObservability, plan => `${plan.strategy}:${plan.strategyFit}`);
  const nodeLimitProfiles = profileResults.filter(result => (
    result.solverDiagnostics?.strategyAttempts || []
  ).some(attempt => attempt.terminationReason === "NODE_LIMIT"));
  const nodeLimitProfilesWithLegacyValidatedDisplayedPlan = nodeLimitProfiles.filter(result => (
    result.planObservability || []
  ).some(plan => plan.legacyValidatedDisplayedPlan));
  const processUsage = process.resourceUsage();
  const summary = {
    schemaVersion: METRIC_SCHEMA_VERSION,
    kind: "econplanner-nightly-generated-matrix",
    generatedAt: new Date().toISOString(),
    dataClassification: "fictional-test-only",
    provenance: {
      ...runtimeProvenance(),
      generatorVersion: ECONOMICS_GENERATOR_VERSION,
      oraclePolicyVersion: manifest.policy?.version ?? null,
      scheduleVersion: schedule.schemaVersion ?? null
    },
    selection: {
      mode: "fixed-seed-pairwise",
      seeds: configuration.seeds,
      shard: {
        index: configuration.shardIndex,
        total: configuration.shardTotal,
        label: `${configuration.shardIndex}/${configuration.shardTotal}`
      },
      totalProfilesAcrossAllShards: allProfiles.length,
      profilesTested: selectedProfiles.length,
      pairwiseRequiredPairsPerSeed: generatedBySeed.map(item => ({
        seed: item.seed,
        requiredPairs: item.coverage.requiredPairs,
        missingPairs: item.coverage.missingPairs.length
      })),
      effectivePairwiseCoverage,
      duplicatePlannerInputs
    },
    metrics: {
      totalRuntimeMs: roundDuration(performance.now() - startedAt),
      profilesTested: selectedProfiles.length,
      profilesWithPlans,
      profilesWithoutPlans: selectedProfiles.length - profilesWithPlans,
      acceptedPlanCount,
      p50ProfileDurationMs: percentile(durations, 0.5),
      p90ProfileDurationMs: percentile(durations, 0.9),
      p95ProfileDurationMs: percentile(durations, 0.95),
      p99ProfileDurationMs: percentile(durations, 0.99),
      worstProfileDurationMs: durations.length ? Math.max(...durations) : 0,
      worstProfileId: [...profileResults].sort((left, right) => right.durationMs - left.durationMs)[0]?.profileId || null,
      solverNodeCounts: {
        observations: nodeCounts.length,
        total: nodeCounts.reduce((sum, value) => sum + value, 0),
        p50: percentile(nodeCounts, 0.5),
        p90: percentile(nodeCounts, 0.9),
        p95: percentile(nodeCounts, 0.95),
        p99: percentile(nodeCounts, 0.99),
        maximum: nodeCounts.length ? Math.max(...nodeCounts) : 0
      },
      solverAttempts: {
        observations: attemptNodeCounts.length,
        nodes: distributionSummary(attemptNodeCounts),
        durationMs: distributionSummary(attemptDurations),
        nodeLimitHits: profileResults.reduce((count, result) => count + (
          result.solverDiagnostics?.strategyAttempts || []
        ).filter(attempt => attempt.terminationReason === "NODE_LIMIT").length, 0),
        solutionBudgetHits: profileResults.reduce((count, result) => count + (
          result.solverDiagnostics?.searchAttempts || []
        ).filter(attempt => attempt.solutionBudgetHit).length, 0),
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
        }
      },
      completion: {
        targetAvailability: decisionShadowRecords.length ? "MEASURED_AUTHORITY" : "NOT_MEASURED",
        targetReasonCode: decisionShadowRecords.length ? null : "NO_DISPLAYED_PLANS_EVALUATED_IN_SHADOW",
        shadowDecision: {
          authority: "PRODUCTION_DECISION_ENGINE",
          profilesWithCompletePlan: profileResults.filter(result => (result.decisionShadow || []).some(record => record.completionStatus === "COMPLETE")).length,
          displayedCompletePlans: decisionShadowRecords.filter(record => record.completionStatus === "COMPLETE").length,
          evidenceStatuses: countBy(decisionShadowRecords, record => record.evidenceStatus)
        },
        legacyValidationProxy: {
          availability: "PROXY",
          measurementBasis: "LEGACY_DISPLAYED_PLAN_VALIDATION_AND_UNSCHEDULED_COUNT",
          profilesWithLegacyValidatedDisplayedPlan: profileResults.filter(result => result.legacyValidatedDisplayedPlan).length,
          displayedPlansValidatedAndScheduled: planObservability.filter(plan => plan.legacyValidatedDisplayedPlan).length,
          plansByLegacyFeasibilityStatus: legacyFeasibilityStatuses
        },
        primaryProductCoverage: {
          availability: "NOT_MEASURED",
          reasonCode: "PRODUCTION_DECISION_ENGINE_SNAPSHOT_AND_REPORT_CONTRACT_NOT_IMPLEMENTED",
          numerator: null,
          denominator: selectedProfiles.length,
          denominatorAvailability: "MEASURED",
          percentage: null
        },
        perProfileReportReadiness: {
          availability: "NOT_MEASURED",
          reasonCode: "REPORT_AND_PDF_NOT_EXECUTED_FOR_EVERY_GENERATED_PROFILE",
          numerator: null,
          denominator: selectedProfiles.length
        }
      },
      strategies: {
        availability: "PROXY",
        measurementBasis: "CURRENT_VALIDATOR_DISTRIBUTION_RESULT",
        displayedPlanFits: strategyFits,
        convergences: profileResults.reduce((sum, result) => sum + (result.strategyConvergences || []).length, 0)
      },
      moveDestinations: {
        availability: "NOT_MEASURED",
        reasonCode: "SERVER_DERIVED_DESTINATIONS_NOT_IMPLEMENTED_UNTIL_CP6",
        requests: null,
        destinations: null,
        classified: null
      },
      productionDecisionEngine: {
        availability: "MEASURED_AUTHORITY",
        authority: "PRODUCTION_DECISION_ENGINE",
        decisions: decisionShadowRecords.length,
        unexpectedDisagreements: decisionShadowRecords.filter(record => record.unexpected).length,
        classifications: countBy(decisionShadowRecords, record => record.classification),
        latencyMs: distributionSummary(decisionShadowRecords.map(record => record.latencyMs)),
        bundleVersion: policyBundle.bundleVersion,
        bundleHash: policyBundle.contentHash
      },
      policyCompiler: {
        availability: "MEASURED_COMMITTED_RELEASE",
        compileTimeMs: null,
        conflicts: 0,
        bundleHash: policyBundle.contentHash
      },
      processMemory: {
        maxRssBytes: Number(processUsage.maxRSS || 0) * 1024,
        heapUsedBytes: process.memoryUsage().heapUsed
      },
      failureCount: failures.length,
      oracleDisagreementCount: oracleDisagreementCount + classifiedOracleFindings.length,
      classifiedOracleDisagreementCount: classifiedOracleFindings.length,
      unclassifiedOracleDisagreementCount,
      invalidEco257ElectiveAttempts,
      acceptedEco257StatisticsPlacements: eco257StatisticsCount,
      acceptedEco257ElectivePlacements: 0,
      oracleReviewCount: reviewItems.length
    },
    noPlan: {
      total: selectedProfiles.length - profilesWithPlans,
      explained: explainedNoPlanCount,
      unexplained: selectedProfiles.length - profilesWithPlans - explainedNoPlanCount,
      reasons: Object.fromEntries([...noPlanReasons].sort(([left], [right]) => left.localeCompare(right))),
      categories: Object.fromEntries([...noPlanCategories].sort(([left], [right]) => left.localeCompare(right))),
      productionFalseNegative: {
        availability: "NOT_MEASURED",
        reasonCode: "ORACLE_DOES_NOT_SEARCH_FOR_A_PLAN_WHEN_PRODUCTION_RETURNS_NO_PLAN",
        count: null
      }
    },
    dimensions: buildDimensionSummary(profileResults),
    highRiskCombinations: buildHighRiskCombinationSummary(profileResults),
    artifactCompleteness: {
      complete: profileResults.length + failures.length === selectedProfiles.length,
      expectedProfiles: selectedProfiles.length,
      recordedProfiles: profileResults.length + failures.length
    },
    profiles: profileResults,
    classifiedOracleFindings,
    oracleReviews: reviewItems,
    failures
  };

  if (isFrozenCp4Cohort(configuration, summary)) assertFrozenCp4AuthoritySummary(summary);

  await writeJson(configuration.output, summary);
  if (failures.length) {
    for (const failure of failures) {
      if (failure.minimizedCounterexample?.fictionalProfile && failure.minimizedCounterexample.profileFile) {
        await writeJson(path.resolve(ROOT, failure.minimizedCounterexample.profileFile), failure.minimizedCounterexample.fictionalProfile);
      }
    }
    await writeJson(failurePath(configuration.output), {
      schemaVersion: METRIC_SCHEMA_VERSION,
      kind: "econplanner-nightly-failure-evidence",
      shard: summary.selection.shard,
      seeds: configuration.seeds,
      failures
    });
    process.exitCode = 1;
  }

  console.log(JSON.stringify({
    event: "ECONOMICS_NIGHTLY_MATRIX_SUMMARY",
    output: relativeToRoot(configuration.output),
    ...summary.metrics
  }));
}

function isLegacyValidatedDisplayedPlan(plan) {
  return Boolean(plan?.validation?.valid && Array.isArray(plan?.unscheduled) && plan.unscheduled.length === 0);
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function isFrozenCp4Cohort(configuration, summary) {
  return configuration.shardIndex === 1
    && configuration.shardTotal === 1
    && summary.selection.totalProfilesAcrossAllShards === 368
    && configuration.seeds.length === DEFAULT_SEEDS.length
    && configuration.seeds.every((seed, index) => seed === DEFAULT_SEEDS[index]);
}

export function assertFrozenCp4AuthoritySummary(summary) {
  const evidenceStatuses = summary.metrics?.completion?.shadowDecision?.evidenceStatuses || {};
  invariant(summary.metrics?.profilesTested === 368, "CP4_FROZEN_PROFILE_COUNT", "CP4 frozen cohort must contain 368 profiles.");
  invariant(summary.metrics?.profilesWithPlans >= 186, "CP4_FROZEN_COVERAGE_REGRESSION", "CP4 frozen cohort coverage fell below 186 complete-plan profiles.");
  invariant(summary.metrics?.acceptedPlanCount === 439, "CP4_FROZEN_PLAN_COUNT", "CP4 frozen cohort must contain 439 displayed plans.");
  invariant(evidenceStatuses.PRELIMINARY === 193 && evidenceStatuses.REVIEW_REQUIRED === 246,
    "CP4_FROZEN_EVIDENCE_COUNTS", "CP4 frozen cohort evidence must contain 193 PRELIMINARY and 246 REVIEW_REQUIRED plans.");
  invariant(summary.metrics?.productionDecisionEngine?.unexpectedDisagreements === 0,
    "CP4_UNEXPECTED_ENGINE_DISAGREEMENT", "CP4 frozen cohort contains an unexpected Production Decision Engine disagreement.");
  invariant(summary.metrics?.oracleDisagreementCount === 0 && summary.metrics?.unclassifiedOracleDisagreementCount === 0,
    "CP4_ORACLE_DISAGREEMENT", "CP4 frozen cohort contains a Production Decision Engine versus Oracle disagreement.");
  const decisionRecords = (summary.profiles || []).flatMap(profile => profile.decisionShadow || []);
  invariant(decisionRecords.length === summary.metrics.acceptedPlanCount,
    "CP4_OBSERVABILITY_PLAN_COUNT", "Every displayed CP4 plan must have one authoritative observability record.");
  const observedEvidenceStatuses = countBy(decisionRecords, record => record.evidenceStatus);
  invariant(observedEvidenceStatuses.PRELIMINARY === 193 && observedEvidenceStatuses.REVIEW_REQUIRED === 246,
    "CP4_OBSERVABILITY_EVIDENCE_DRIFT", "Authoritative observability records do not match the frozen evidence counts.");
  invariant(!decisionRecords.some(record => (record.reasonCodes || []).includes("PLANNING_CONTEXT_REQUIRED")),
    "CP4_OBSERVABILITY_CONTEXT_OMITTED", "A valid generated plan was evaluated without its planning context.");
  const reviewFindings = decisionRecords.flatMap(record => record.reviewFindings || []);
  invariant(decisionRecords.filter(record => record.evidenceStatus === "REVIEW_REQUIRED")
    .every(record => record.reviewFindings?.length),
  "CP4_REVIEW_WITHOUT_FINDING", "Every REVIEW_REQUIRED plan must expose its controlling review finding.");
  invariant(reviewFindings.every(finding => finding.ruleIds?.length && finding.sourceRefs?.length),
    "CP4_UNTRACEABLE_REVIEW", "Every CP4 review-only finding must include a stable rule ID and source reference.");
  const convergences = (summary.profiles || []).flatMap(profile => (
    (profile.strategyConvergences || []).map(item => ({ profileId: profile.profileId, ...item }))
  ));
  invariant(convergences.length === 2
    && CP4_FROZEN_CONVERGENCE_PROFILES.every(profileId => convergences.some(item => (
      item.profileId === profileId
      && item.keptLabel === "Plan A"
      && item.convergedLabel === "Plan C"
      && item.code === "PLANS_CONVERGED"
    ))), "CP4_FROZEN_CONVERGENCE_DRIFT", "The two Explore-First semantic convergences must remain documented.");
  return Object.freeze({
    profiles: 368,
    profilesWithPlans: summary.metrics.profilesWithPlans,
    displayedPlans: 439,
    evidenceStatuses: { PRELIMINARY: 193, REVIEW_REQUIRED: 246 },
    convergenceProfiles: [...CP4_FROZEN_CONVERGENCE_PROFILES]
  });
}

export function characterizeDisplayedPlan(plan, shadow = null) {
  const distribution = plan?.validation?.distribution || validatePreferredDistribution(plan);
  const strategy = STRATEGY_NAMES[plan?.distribution?.strategy] || "UNKNOWN";
  const strategyFit = distribution?.applicable === false
    ? "NOT_APPLICABLE"
    : distribution?.exact
      ? "EXACT"
      : distribution?.valid
        ? "ACCEPTABLE"
        : "MISMATCH";
  return {
    planId: plan?.id || null,
    label: plan?.label || null,
    targetCompletionStatus: shadow?.completionStatus || null,
    targetCompletionAvailability: shadow ? "MEASURED_AUTHORITY" : "NOT_MEASURED",
    targetCompletionReasonCode: shadow ? null : "PRODUCTION_DECISION_ENGINE_COMPLETION_CONTRACT_NOT_IMPLEMENTED",
    legacyValidatedDisplayedPlan: isLegacyValidatedDisplayedPlan(plan),
    legacyValidationProxyAvailability: "PROXY",
    legacyValidationProxyBasis: "LEGACY_DISPLAYED_PLAN_VALIDATION_AND_UNSCHEDULED_COUNT",
    targetEvidenceStatus: shadow?.evidenceStatus || null,
    targetEvidenceAvailability: shadow ? "MEASURED_AUTHORITY" : "NOT_MEASURED",
    targetEvidenceReasonCode: shadow ? null : "PRODUCTION_DECISION_ENGINE_EVIDENCE_CONTRACT_NOT_IMPLEMENTED",
    legacyFeasibilityStatus: plan?.feasibilityStatus || null,
    strategy,
    strategyFit,
    strategyFitAvailability: "PROXY",
    strategyDeviation: distribution?.annualDistance !== null
      && distribution?.annualDistance !== undefined
      && distribution?.annualDistance !== ""
      && Number.isFinite(Number(distribution.annualDistance))
      ? Number(distribution.annualDistance)
      : null,
    deviationReasons: [...new Set([
      ...(Array.isArray(distribution?.warnings) ? distribution.warnings : []),
      ...(Array.isArray(distribution?.errors) ? distribution.errors : [])
    ])],
    productionDecisionEngine: {
      availability: shadow ? "MEASURED_AUTHORITY" : "NOT_MEASURED",
      reasonCode: shadow ? null : "PRODUCTION_DECISION_ENGINE_NOT_IMPLEMENTED_UNTIL_CP3",
      status: shadow?.engineStatus || null,
      classification: shadow?.classification || null,
      latencyMs: shadow?.latencyMs ?? null
    },
    validatedSnapshot: {
      availability: "NOT_MEASURED",
      reasonCode: "SIGNED_VALIDATED_PLAN_SNAPSHOT_NOT_IMPLEMENTED_UNTIL_CP6",
      issued: null
    },
    reportReadiness: {
      availability: "NOT_MEASURED",
      reasonCode: "REPORT_AND_PDF_NOT_EXECUTED_FOR_EVERY_GENERATED_PROFILE",
      ready: null
    }
  };
}

async function evaluateProfile({ profile, manifest, verifiedSchedule, requirements, prerequisites, schedule, policyBundle, canonicalPolicy }) {
  const generatorAudit = auditGeneratedFictionalProfile(profile, manifest, verifiedSchedule);
  invariant(profile.fictional === true, "NON_FICTIONAL_PROFILE", `${profile.profileId} is not marked fictional.`);
  invariant(generatorAudit.valid, "GENERATED_PROFILE_POLICY_FAILURE", JSON.stringify(generatorAudit.violations));

  const student = plannerStudent(profile);
  const mapping = mapStudentToProgram(PROGRAM, requirements, student);
  const planBundle = buildEconomicsTermPlans({
    student,
    mapping,
    schedule,
    prerequisites,
    collectDiagnostics: true,
    policyBundle
  });
  const signatures = planBundle.plans.map(plan => semanticPlanSignature(plan));
  invariant(
    new Set(signatures).size === signatures.length,
    "SEMANTIC_DUPLICATE",
    `${profile.profileId} returned duplicate displayed schedules.`
  );

  const solverNodes = [];
  const oracleReviews = [];
  const oracleFindings = [];
  let eco257StatisticsCount = 0;
  const decisionShadow = [];

  for (const plan of planBundle.plans) {
    invariant(plan.validation?.valid, "INVALID_DISPLAYED_PLAN", `${profile.profileId}/${plan.id} failed production validation.`);
    const search = plan.feasibility?.search || {};
    const nodesVisited = Number(search.nodesVisited || 0);
    const limit = Number(search.limit || 250000);
    invariant(nodesVisited <= limit, "SOLVER_LIMIT_EXCEEDED", `${profile.profileId}/${plan.id} visited ${nodesVisited} nodes with limit ${limit}.`);
    solverNodes.push(nodesVisited);

    for (const course of plan.terms.flatMap(term => term.courses || [])) {
      if (course.course !== "ECO 257") continue;
      invariant(
        course.requirementId === "statistics",
        "ECO_257_ELECTIVE_ACCEPTED",
        `${profile.profileId}/${plan.id} assigned ECO 257 to ${course.requirementId}.`
      );
      eco257StatisticsCount += 1;
    }

    const oracle = auditPlan(student, plan, manifest, verifiedSchedule);
    const unclassifiedViolations = oracle.violations.filter(item => !CLASSIFIED_ORACLE_VIOLATIONS.has(item.code));
    invariant(
      unclassifiedViolations.length === 0,
      "ORACLE_DISAGREEMENT",
      `${profile.profileId}/${plan.id}: ${JSON.stringify(unclassifiedViolations)}`
    );
    invariant(
      oracle.violations.every(item => item.sourceReference),
      "UNSOURCED_ORACLE_FINDING",
      `${profile.profileId}/${plan.id}: ${JSON.stringify(oracle.violations)}`
    );
    oracleFindings.push(...oracle.violations.map(item => ({
      planId: plan.id,
      code: item.code,
      sourceReference: item.sourceReference,
      classification: "KNOWN_CLASSIFIED_ORACLE_FINDING"
    })));
    const relevantReviews = oracle.reviewItems.filter(item => item.code !== "RULE_FAMILY_NOT_CHECKED");
    const unclassifiedReviews = relevantReviews.filter(item => !CLASSIFIED_ORACLE_REVIEWS.has(item.code));
    invariant(
      unclassifiedReviews.length === 0,
      "UNCLASSIFIED_ORACLE_REVIEW",
      `${profile.profileId}/${plan.id}: ${JSON.stringify(unclassifiedReviews)}`
    );
    invariant(
      relevantReviews.every(item => item.sourceReference),
      "UNSOURCED_ORACLE_REVIEW",
      `${profile.profileId}/${plan.id}: ${JSON.stringify(relevantReviews)}`
    );
    oracleReviews.push(...relevantReviews.map(item => ({
      planId: plan.id,
      code: item.code,
      sourceReference: item.sourceReference,
      classification: "KNOWN_POLICY_REVIEW"
    })));
    const canonicalOracle = oracleEvaluateCanonicalPlan(canonicalPolicy, student, plan);
    invariant(
      plan.validation.policyBundleHash === policyBundle.contentHash,
      "POLICY_BUNDLE_MISMATCH",
      `${profile.profileId}/${plan.id} was not validated with the requested policy bundle.`
    );
    const shadow = buildDecisionComparisonRecord({
      student,
      plan,
      productionValidation: plan.validation,
      engine: plan.validation.policyDecision,
      oracle: canonicalOracle,
      source: "nightly-generated-profile",
      mode: "AUTHORITATIVE_REUSED",
      latencyMs: plan.validation.policyDecisionLatencyMs,
      scheduleReleaseId: policyBundle.releaseRefs?.schedule || null
    });
    invariant(!shadow.unexpected, "UNEXPECTED_DECISION_SHADOW_DISAGREEMENT", `${profile.profileId}/${plan.id}: ${shadow.classification}`);
    decisionShadow.push({
      planId: plan.id,
      completionStatus: shadow.engineAcademicallyValid ? "COMPLETE" : "PARTIAL",
      evidenceStatus: shadow.engineStatus === "ALLOW" ? "VERIFIED" : shadow.engineStatus,
      ...shadow
    });
  }

  const planObservability = planBundle.plans.map((plan, index) => characterizeDisplayedPlan(plan, decisionShadow[index]));
  const noPlan = planBundle.plans.length === 0 ? classifyNoPlan(planBundle) : null;

  return {
    planCount: planBundle.plans.length,
    planSignatures: signatures,
    planObservability,
    solverNodes,
    solverDiagnostics: planBundle.metricsDiagnostics || { strategyAttempts: [], searchAttempts: [] },
    candidateOutcomes: planBundle.candidateOutcomes || [],
    strategyConvergences: planBundle.convergences || [],
    planningGaps: planBundle.planningGaps || [],
    noPlan,
    oracleReviews,
    oracleFindings,
    eco257StatisticsCount,
    decisionShadow
  };
}

function plannerStudent(profile) {
  const student = {
    academicStanding: profile.student.academicStanding,
    planningPace: profile.student.planningPace || "standard",
    projectedSeniorStandingConfirmation: profile.student.projectedSeniorStandingConfirmation || null,
    planCreationDate: profile.student.planDate,
    isTransferStudent: profile.student.isTransferStudent,
    ...(profile.student.isTransferStudent ? {
      transferExpectedGraduationYear: profile.student.transferExpectedGraduationYear,
      transferEntryAcademicYear: profile.student.transferEntryAcademicYear
    } : {}),
    courses: profile.student.courses.map(course => ({
      code: course.submittedCourse || course.course,
      status: course.status,
      source: course.source,
      units: course.units
    }))
  };
  const context = resolvePlanningContext(student);
  const inProgressAcademicYearStart = context.isSummer
    ? context.startYear - 1
    : context.startYear;
  const inProgressTermKey = context.isSummer
    ? "Summer"
    : context.startTerm === "Spring"
      ? "Spring/May"
      : context.startTerm;
  student.courses = student.courses.map(course => (
    course.status === "in_progress"
      ? {
          ...course,
          academicYear: `${inProgressAcademicYearStart}/${inProgressAcademicYearStart + 1}`,
          termKey: inProgressTermKey
        }
      : course
  ));
  student.reservedCourseUnits = Object.fromEntries(
    buildPlanningSlots(context)
      .filter(slot => !slot.isSummer)
      .map(slot => [slot.id, Number(profile.student.reservedCapacity?.[slot.scheduleTerm] || 0)])
  );
  return student;
}

function effectivePlannerAxes(profile, student) {
  const declared = profile.axes || {};
  const statuses = new Set((student.courses || []).map(course => course.status));
  const reservedValues = Object.values(student.reservedCourseUnits || {});
  const planningContext = resolvePlanningContext(student);
  const seniorStandingConfirmationState = !planningContext.requiresProjectedSeniorStandingConfirmation
    ? "not_required"
    : planningContext.projectedSeniorStandingConfirmation
      ? "confirmed"
      : student.projectedSeniorStandingConfirmation
        ? "stale"
        : "missing";
  return {
    standing: student.academicStanding ?? null,
    planningPace: student.isTransferStudent ? null : student.planningPace ?? null,
    seniorStandingConfirmationState,
    planDate: student.planCreationDate ?? null,
    transferStatus: student.isTransferStudent ? "transfer" : "regular",
    graduationHorizon: student.isTransferStudent ? declared.graduationHorizon ?? null : null,
    courseStatus: statuses.has(declared.courseStatus) ? declared.courseStatus : null,
    completedPathway: (student.courses || []).length ? declared.completedPathway ?? null : null,
    reservedCapacity: reservedValues.length ? Math.max(...reservedValues) : null,
    availabilityState: null,
    approvalState: null
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function assertFictionalProfileFile(profile) {
  invariant(profile?.fictional === true, "NON_FICTIONAL_PROFILE_FILE", "Replay profile files must be explicitly fictional.");
  const forbiddenKeys = /^(email|student_?id|real_?name|phone|address|transcript|date_?of_?birth)$/iu;
  let piiFinding = null;
  function visit(value, key = "profile") {
    if (piiFinding) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${key}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") {
      if (typeof value === "string" && (/@/u.test(value) || /\b\d{3}[-.) ]+\d{3}[- ]+\d{4}\b/u.test(value))) piiFinding = key;
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      if (forbiddenKeys.test(childKey)) {
        piiFinding = `${key}.${childKey}`;
        return;
      }
      visit(childValue, `${key}.${childKey}`);
    }
  }
  visit(profile);
  invariant(!piiFinding, "PROFILE_FILE_PII", `Replay profile files must not contain personal-data field ${piiFinding}.`);
  const displayName = profile.student?.displayName;
  invariant(!displayName || /^Fictional\b/u.test(displayName), "PROFILE_FILE_PII", "Replay display names must begin with Fictional.");
}

function canonicalPlannerInputHash(student) {
  const canonical = JSON.stringify(stableValue(student));
  return createHash("sha256").update(canonical).digest("hex");
}

function effectivePairwiseCoverageReport(profiles) {
  const axisNames = [...new Set(profiles.flatMap(profile => Object.keys(profile.axes || {})))].sort();
  const values = Object.fromEntries(axisNames.map(name => [
    name,
    [...new Set(profiles.map(profile => profile.axes?.[name]).filter(value => value !== null && value !== undefined))]
      .sort((left, right) => String(left).localeCompare(String(right)))
  ]));
  const covered = new Set();
  for (const profile of profiles) {
    for (let leftIndex = 0; leftIndex < axisNames.length; leftIndex += 1) {
      const leftName = axisNames[leftIndex];
      const leftValue = profile.axes?.[leftName];
      if (leftValue === null || leftValue === undefined) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < axisNames.length; rightIndex += 1) {
        const rightName = axisNames[rightIndex];
        const rightValue = profile.axes?.[rightName];
        if (rightValue === null || rightValue === undefined) continue;
        covered.add(JSON.stringify([leftName, leftValue, rightName, rightValue]));
      }
    }
  }
  const required = [];
  for (let leftIndex = 0; leftIndex < axisNames.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < axisNames.length; rightIndex += 1) {
      const leftName = axisNames[leftIndex];
      const rightName = axisNames[rightIndex];
      for (const leftValue of values[leftName]) {
        for (const rightValue of values[rightName]) {
          required.push([leftName, leftValue, rightName, rightValue]);
        }
      }
    }
  }
  const missingPairs = required.filter(pair => !covered.has(JSON.stringify(pair)));
  return {
    axes: Object.fromEntries(axisNames.map(name => [name, {
      values: values[name],
      consumed: values[name].length > 0
    }])),
    requiredPairs: required.length,
    coveredPairs: required.length - missingPairs.length,
    missingPairs
  };
}

function duplicateInputGroups(profiles) {
  const groups = new Map();
  for (const profile of profiles) {
    const entries = groups.get(profile.plannerInputHash) || [];
    entries.push(profile.profileId);
    groups.set(profile.plannerInputHash, entries);
  }
  return [...groups.entries()]
    .filter(([, profileIds]) => profileIds.length > 1)
    .map(([plannerInputHash, profileIds]) => ({ plannerInputHash, profileIds: [...profileIds].sort() }))
    .sort((left, right) => left.plannerInputHash.localeCompare(right.plannerInputHash));
}

export function noPlanCategory(reason, conclusion = "UNKNOWN") {
  if (reason === "INVALID_INPUT") return "INPUT_BLOCKED";
  if (reason === "SEARCH_INCOMPLETE") return "SEARCH_INCOMPLETE";
  if (reason === "POLICY_REVIEW_REQUIRED") return "POLICY_REVIEW_REQUIRED";
  if (reason === "MISSING_OFFERING") return "SCHEDULE_BLOCKED";
  if (conclusion === "PROVEN_INFEASIBLE" && [
    "COUNT_CAPACITY",
    "EMPTY_DOMAIN",
    "NO_COMPLETE_ASSIGNMENT"
  ].includes(reason)) return "INFEASIBLE_PROVEN";
  if (reason === "PRODUCTION_FALSE_NEGATIVE") return "PRODUCTION_FALSE_NEGATIVE";
  return "OTHER";
}

function classifiedNoPlan(conclusion, reason, evidence, additional = {}) {
  return {
    conclusion,
    category: noPlanCategory(reason, conclusion),
    reason,
    ...additional,
    ...evidence
  };
}

function classifyNoPlan(bundle) {
  const diagnostics = bundle.metricsDiagnostics || {};
  const attempts = diagnostics.strategyAttempts || [];
  const searchAttempts = diagnostics.searchAttempts || [];
  const evidence = {
    attempts,
    searchAttempts,
    candidateOutcomes: bundle.candidateOutcomes || [],
    planningGaps: bundle.planningGaps || []
  };
  if (diagnostics.invalidInput) {
    return classifiedNoPlan("UNKNOWN", "INVALID_INPUT", evidence);
  }
  if (!attempts.length) {
    return classifiedNoPlan("UNKNOWN", "UNEXPLAINED", evidence);
  }
  const incomplete = attempts.filter(attempt => !attempt.exhaustive && !attempt.solutionFound);
  if (incomplete.length) {
    return classifiedNoPlan("UNKNOWN", "SEARCH_INCOMPLETE", evidence);
  }
  if ((bundle.planningGaps || []).some(gap => /REVIEW|APPROVAL|POLICY/iu.test(`${gap.code || ""} ${gap.reason || ""} ${gap.message || ""}`))) {
    return classifiedNoPlan("UNKNOWN", "POLICY_REVIEW_REQUIRED", evidence);
  }
  const allCountCapacity = searchAttempts.length > 0
    && searchAttempts.every(attempt => attempt.failure === "COUNT_CAPACITY");
  if (allCountCapacity) {
    return classifiedNoPlan("PROVEN_INFEASIBLE", "COUNT_CAPACITY", evidence);
  }
  const missingOffering = (bundle.planningGaps || []).some(gap => (
    /missing offering|no (?:verified )?offering|not offered/iu.test(`${gap.code || ""} ${gap.reason || ""} ${gap.message || ""}`)
  ));
  if (missingOffering) {
    return classifiedNoPlan("UNKNOWN", "MISSING_OFFERING", evidence);
  }
  const emptyDomains = [...new Set(searchAttempts.flatMap(attempt => attempt.emptyDomains || []))];
  if (emptyDomains.length) {
    return classifiedNoPlan("PROVEN_INFEASIBLE", "EMPTY_DOMAIN", evidence, { emptyDomains });
  }
  if (attempts.every(attempt => attempt.exhaustive)) {
    return classifiedNoPlan("PROVEN_INFEASIBLE", "NO_COMPLETE_ASSIGNMENT", evidence);
  }
  return classifiedNoPlan("UNKNOWN", "OTHER_CLASSIFIED", evidence, { classificationId: "NO_RETAINED_VALID_PLAN" });
}

function replayEvidence(seed, profile, configuration) {
  const output = `test-results/replay/${safeText(profile.profileId, 160)}.json`;
  return {
    seed,
    profileId: profile.profileId,
    command: [
      "node",
      "scripts/run-economics-nightly-matrix.mjs",
      "--seeds",
      String(seed),
      "--profile-id",
      profile.profileId,
      "--shard",
      "1/1",
      "--output",
      output
    ],
    sourceMode: configuration.profileFile ? "profile-file" : "generated-profile"
  };
}

async function minimizeCounterexample(profile, classification, inputs, output) {
  if (!classification) return null;
  for (const candidate of shrinkFictionalEconomicsProfile(profile, inputs)) {
    try {
      await evaluateProfile({ profile: candidate, ...inputs });
    } catch (error) {
      if ((error.code || "UNCLASSIFIED_NIGHTLY_FAILURE") === classification) {
        const profileFile = relativeToRoot(path.join(
          path.dirname(output),
          `${safeText(candidate.profileId, 120)}.minimized.json`
        ));
        return {
          seed: candidate.seed,
          profileId: candidate.profileId,
          axes: candidate.axes,
          fictionalProfile: candidate,
          profileFile,
          replay: {
            command: [
              "node",
              "scripts/run-economics-nightly-matrix.mjs",
              "--profile-file",
              profileFile,
              "--shard",
              "1/1",
              "--output",
              `test-results/replay/${safeText(candidate.profileId, 120)}.json`
            ]
          }
        };
      }
    }
  }
  return null;
}

function auditPlan(student, plan, policy, verifiedSchedule) {
  const activeCourses = student.courses.filter(course => ["completed", "in_progress"].includes(course.status));
  return auditExternalEconomicsPlanComplete({
    student: {
      academicStanding: student.academicStanding,
      completedCourses: activeCourses.map(course => ({
        course: course.code,
        ...(course.status === "in_progress" ? { projectedCompletion: true } : {})
      })),
      inProgressCourses: activeCourses
        .filter(course => course.status === "in_progress")
        .map(course => ({
          course: course.code,
          academicYear: course.academicYear,
          termKey: course.termKey
        })),
      reservedCourseUnits: student.reservedCourseUnits
    },
    expectedContext: plan.planningContext,
    plan: {
      id: plan.id,
      terms: plan.terms.map(term => ({
        ...term,
        courses: term.courses.map(course => oracleCourse(course, term, plan, policy))
      })),
      requirementClaims: transferClaims(student)
    },
    policy,
    verifiedSchedule
  });
}

function transferClaims(student) {
  return student.courses
    .filter(course => ["transfer", "uncertain"].includes(course.status))
    .map(course => ({
      kind: "equivalency",
      targetRuleId: transferRequirementRule(course.code),
      reviewRuleId: "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE",
      course: course.code
    }));
}

function transferRequirementRule(code) {
  const canonical = code === "PHI 234" ? "ECO 234" : code;
  if (["ECO 257", "MAT 217", "PSY 217"].includes(canonical)) return "REQ-STATISTICS";
  if (["MAT 113", "MAT 121"].includes(canonical)) return "REQ-COGNATE";
  if (["ECO 321", "BUSN 323"].includes(canonical)) return "REQ-FINANCE";
  if (["ECO 113", "ECO 114", "ECO 213", "ECO 214", "ECO 461"].includes(canonical)) {
    return `REQ-${canonical.replace(" ", "-")}`;
  }
  return canonical.startsWith("ECO ") ? "REQ-ECO-ELECTIVES" : null;
}

function oracleCourse(course, term, plan, policy) {
  const stale = (plan.feasibility?.enrollmentConditions || []).some(condition => (
    condition.type === "stale_availability"
    && condition.course === course.course
    && condition.term === term.term
  ));
  const value = {
    ...course,
    canonicalCrossListIdentity: [course.course, ...(course.crossListedAs || [])],
    availability: { ...course.availability, ...(stale ? { freshness: "stale" } : {}) },
    provenance: {
      verificationDate: course.provenance?.humanVerifiedOn
        ?? course.provenance?.verifiedOn
        ?? course.provenance?.screenshotRetrievedOn
        ?? null,
      sourceReference: course.provenance?.sourceFiles?.[0] ?? null
    },
    ...(course.course === "ECO 461" && course.residency === "hanover"
      ? { institution: "Hanover College" }
      : {}),
    ...(Array.isArray(course.approvalRequired)
      ? { approvalRequired: course.approvalRequired.map(approval => oracleApproval(approval, policy)) }
      : {})
  };
  if (!value.section) delete value.section;
  if (!value.institution) delete value.institution;
  return value;
}

function oracleApproval(approval, policy) {
  const ruleId = approvalRuleId(approval);
  const rules = [...(policy.concurrencyRules || []), ...(policy.permissionRules || [])];
  const rule = rules.find(item => item.ruleId === ruleId);
  return {
    ruleId,
    type: APPROVAL_TYPES[ruleId],
    authority: approval.authority,
    course: approval.course,
    prerequisite: approval.prerequisite ?? null,
    term: approval.term,
    reason: approval.reason,
    sourceRef: rule?.sourceRefs?.[0] || null
  };
}

function approvalRuleId(approval) {
  if (approval.code === "CONCURRENT_INTERMEDIATE_DEPARTMENT_APPROVAL") {
    return "CONCURRENT-INTERMEDIATE-ECO-461";
  }
  if (approval.code === "CONCURRENT_MATH_INSTRUCTOR_APPROVAL") {
    return approval.course === "ECO 213"
      ? "CONCURRENT-MATH-ECO-213"
      : "CONCURRENT-MATH-ECO-214";
  }
  return approval.ruleId || null;
}

async function summarizePlaywright(configuration) {
  const reports = await Promise.all(configuration.inputs.map(async input => ({
    input,
    report: JSON.parse(await readFile(input, "utf8"))
  })));
  const executions = reports.flatMap(({ input, report }, reportIndex) => (
    collectPlaywrightExecutions(report.suites || [], [], { input, reportIndex })
  ));
  const attachmentRecords = (await Promise.all(executions.flatMap(item => (
    item.attachments.map(attachment => readPlaywrightAttachment(item.input, attachment))
  )))).filter(Boolean);
  const observations = attachmentRecords.filter(item => item.kind === "econplanner-browser-test-observation");
  const parity = attachmentRecords.filter(item => item.kind === "econplanner-api-ui-parity");
  const axeResults = attachmentRecords.filter(item => Array.isArray(item.violations));
  const failed = executions.filter(item => !["passed", "skipped"].includes(item.status));
  const baselineComparableExecutions = executions.filter(item => !/econ-planner-parity\.spec\.js$/u.test(item.file || ""));
  const errorText = item => item.errors.map(error => error.message || error.value || String(error)).join("\n");
  const titleMatches = (item, pattern) => pattern.test(item.title) || pattern.test(errorText(item));
  const metric = pattern => failed.filter(item => titleMatches(item, pattern)).length;
  const mixedByTitle = new Map();
  for (const item of executions) {
    const statuses = mixedByTitle.get(item.title) || new Set();
    statuses.add(item.status);
    mixedByTitle.set(item.title, statuses);
  }
  const flakeObservations = [...mixedByTitle.entries()]
    .filter(([, statuses]) => statuses.size > 1)
    .map(([title, statuses]) => ({ title, statuses: [...statuses].sort() }));
  const summary = {
    schemaVersion: METRIC_SCHEMA_VERSION,
    kind: "econplanner-nightly-browser",
    generatedAt: new Date().toISOString(),
    inputReports: configuration.inputs.map(relativeToRoot),
    metrics: {
      totalRuntimeMs: executions.reduce((sum, item) => sum + item.durationMs, 0),
      testExecutions: executions.length,
      baselineComparableTestExecutions: baselineComparableExecutions.length,
      passed: executions.filter(item => item.status === "passed").length,
      failed: failed.length,
      skipped: executions.filter(item => item.status === "skipped").length,
      duplicatePlanEditRequestCount: metric(/plan-edit|edit lock|simultaneous edit/iu),
      duplicatePdfRequestCount: metric(/PDF download.*single-flight|simultaneous Download|PDF lock/iu),
      duplicateDownloadCount: metric(/PDF download.*single-flight|simultaneous Download/iu),
      focusRestorationFailureCount: metric(/focus|failure.*recover|recovery/iu),
      malformedResponseAcceptanceCount: metric(/malformed/iu),
      accessibilityViolationCount: metric(/accessibility|axe|contrast|keyboard|tab-panel/iu),
      mobileOverflowFailureCount: metric(/overflow|inside every target viewport/iu),
      domDetachmentFailureCount: metric(/detached|not attached|element.*attachment/iu),
      mat113DetachmentFailureCount: failed.filter(item => (
        /MAT 113/iu.test(errorText(item)) && /detached|not attached|element.*attachment/iu.test(errorText(item))
      )).length,
      flakeObservationCount: flakeObservations.length,
      retryCount: executions.reduce((sum, item) => sum + Number(item.retry || 0), 0),
      consoleErrorCount: observations.reduce((sum, item) => sum + (item.consoleErrors?.length || 0), 0),
      pageErrorCount: observations.reduce((sum, item) => sum + (item.pageErrors?.length || 0), 0),
      networkErrorCount: observations.reduce((sum, item) => sum + (item.networkErrors?.length || 0), 0),
      apiRequestCount: observations.reduce((sum, item) => sum + Number(item.requestCounts?.api || 0), 0),
      pdfRequestCount: observations.reduce((sum, item) => sum + Number(item.requestCounts?.pdf || 0), 0),
      successfulDuplicateRequestCount: observations.reduce((sum, item) => sum + (
        item.successfulDuplicateRequests || []
      ).reduce((count, request) => count + Math.max(0, Number(request.count || 0) - 1), 0), 0),
      axeFindingCount: axeResults.reduce((sum, item) => sum + item.violations.length, 0),
      moderateOrMinorAccessibilityFindings: axeResults.reduce((sum, item) => sum + item.violations.filter(violation => (
        ["minor", "moderate"].includes(violation.impact)
      )).length, 0),
      seriousOrCriticalAccessibilityFindings: axeResults.reduce((sum, item) => sum + item.violations.filter(violation => (
        ["serious", "critical"].includes(violation.impact)
      )).length, 0),
      materialParityMismatchCount: parity.reduce((sum, item) => sum
        + Number(item.materialMissingCount || 0)
        + Number(item.materialExtraCount || 0), 0)
    },
    observations,
    parity,
    accessibility: axeResults.map(item => ({
      violations: item.violations.map(violation => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes?.length || 0 }))
    })),
    flakeObservations,
    failures: failed.map(item => ({
      title: item.title,
      status: item.status,
      durationMs: item.durationMs,
      input: relativeToRoot(item.input),
      firstError: safeText(errorText(item), 4000)
    }))
  };
  await writeJson(configuration.output, summary);
  console.log(JSON.stringify({
    event: "ECONOMICS_NIGHTLY_PLAYWRIGHT_SUMMARY",
    output: relativeToRoot(configuration.output),
    ...summary.metrics
  }));
}

async function summarizePrerequisites(configuration) {
  const [normalLog, optionalLog, fixture] = await Promise.all([
    readTextFile(configuration.normalLog),
    readTextFile(configuration.optionalLog),
    readJson("tests/fixtures/economics-prerequisite-cases.v1.json")
  ]);
  const normal = prerequisiteReportFromLog(normalLog, "pull-request");
  const optional = prerequisiteReportFromLog(optionalLog, "nightly-only");
  invariant(normal.cases === 336, "NORMAL_PREREQUISITE_COUNT", `Expected 336 normal prerequisite cases, found ${normal.cases}.`);
  invariant(optional.cases === 293, "OPTIONAL_PREREQUISITE_COUNT", `Expected 293 optional prerequisite cases, found ${optional.cases}.`);
  invariant(
    !Object.hasOwn(optional.disagreementClasses || {}, "PRODUCTION_APPROVAL_METADATA_GAP"),
    "APPROVAL_IDENTITY_FAILURE",
    "The optional matrix reported an accepted wrong approval identity."
  );
  const summary = {
    schemaVersion: METRIC_SCHEMA_VERSION,
    kind: "econplanner-nightly-prerequisites",
    generatedAt: new Date().toISOString(),
    metrics: {
      normalPrerequisiteCasesExecuted: normal.cases,
      optionalPrerequisiteCasesExecuted: optional.cases,
      totalPrerequisiteCasesExecuted: normal.cases + optional.cases,
      normalProductionDisagreements: normal.productionDisagreements,
      optionalProductionDisagreements: optional.productionDisagreements,
      approvalIdentityFailures: 0,
      reviewOnlyOutcomes: fixture.reviewOnlyCases?.length || 0,
      unexpectedDisagreements: 0
    },
    normal,
    optional,
    enforcement: {
      wrongApprovalAuthority: "rejected",
      wrongApprovalCourse: "rejected",
      wrongApprovalTerm: "rejected",
      source: "Both matrix commands must pass; the workflow also runs the 24-case mutation registry, which fails if an approval identity is accepted."
    }
  };
  await writeJson(configuration.output, summary);
  console.log(JSON.stringify({
    event: "ECONOMICS_NIGHTLY_PREREQUISITE_SUMMARY",
    output: relativeToRoot(configuration.output),
    ...summary.metrics
  }));
}

function prerequisiteReportFromLog(log, expectedSuite) {
  const report = extractJsonBlocks(log).find(item => item?.suite === expectedSuite);
  invariant(report, "MISSING_PREREQUISITE_REPORT", `Could not find the ${expectedSuite} prerequisite summary in its test log.`);
  invariant(Number.isInteger(report.cases), "INVALID_PREREQUISITE_REPORT", `${expectedSuite} prerequisite report has no integer case count.`);
  return report;
}

function extractJsonBlocks(text) {
  const blocks = [];
  let start = null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && start !== null) {
        try {
          blocks.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          // Non-JSON braces in TAP diagnostics are not a prerequisite report.
        }
        start = null;
      }
    }
  }
  return blocks;
}

function collectPlaywrightExecutions(suites, parents, source) {
  const output = [];
  for (const suite of suites) {
    const suiteParents = suite.title ? [...parents, suite.title] : parents;
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        for (const result of test.results || []) {
          output.push({
            ...source,
            title: [...suiteParents, spec.title, test.projectName].filter(Boolean).join(" > "),
            file: spec.file || null,
            status: result.status || test.status || "unknown",
            durationMs: Number(result.duration || 0),
            retry: Number(result.retry || 0),
            errors: result.errors || [],
            attachments: result.attachments || []
          });
        }
      }
    }
    output.push(...collectPlaywrightExecutions(suite.suites || [], suiteParents, source));
  }
  return output;
}

function parseArguments(args) {
  const result = {
    mode: "matrix",
    seeds: [...DEFAULT_SEEDS],
    shardIndex: 1,
    shardTotal: 1,
    output: path.join(ROOT, "test-results", "economics-nightly-matrix", "summary.json"),
    inputs: [],
    normalLog: null,
    optionalLog: null,
    profileId: null,
    profileFile: null
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--summarize-playwright") {
      result.mode = "playwright-summary";
    } else if (argument === "--summarize-prerequisites") {
      result.mode = "prerequisite-summary";
    } else if (argument === "--seeds") {
      result.seeds = parseSeeds(requiredValue(args, ++index, argument));
    } else if (argument === "--shard") {
      const [shardIndex, shardTotal] = requiredValue(args, ++index, argument).split("/").map(Number);
      result.shardIndex = shardIndex;
      result.shardTotal = shardTotal;
    } else if (argument === "--output") {
      result.output = resolveSafeOutput(requiredValue(args, ++index, argument));
    } else if (argument === "--input") {
      result.inputs.push(path.resolve(ROOT, requiredValue(args, ++index, argument)));
    } else if (argument === "--normal-log") {
      result.normalLog = path.resolve(ROOT, requiredValue(args, ++index, argument));
    } else if (argument === "--optional-log") {
      result.optionalLog = path.resolve(ROOT, requiredValue(args, ++index, argument));
    } else if (argument === "--profile-id") {
      result.profileId = requiredValue(args, ++index, argument);
    } else if (argument === "--profile-file") {
      result.profileFile = resolveSafeProfileInput(requiredValue(args, ++index, argument));
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  invariant(Number.isInteger(result.shardIndex) && Number.isInteger(result.shardTotal)
    && result.shardIndex >= 1 && result.shardIndex <= result.shardTotal,
  "INVALID_SHARD", "--shard must use INDEX/TOTAL with 1 <= INDEX <= TOTAL.");
  invariant(result.seeds.length > 0, "INVALID_SEEDS", "At least one fixed seed is required.");
  invariant(!(result.profileId && result.profileFile), "AMBIGUOUS_PROFILE_REPLAY", "Choose --profile-id or --profile-file, not both.");
  if (result.mode === "playwright-summary") {
    invariant(result.inputs.length > 0, "MISSING_PLAYWRIGHT_INPUT", "At least one --input report is required.");
  }
  if (result.mode === "prerequisite-summary") {
    invariant(result.normalLog, "MISSING_NORMAL_PREREQUISITE_LOG", "--normal-log is required.");
    invariant(result.optionalLog, "MISSING_OPTIONAL_PREREQUISITE_LOG", "--optional-log is required.");
  }
  return result;
}

function parseSeeds(value) {
  const seeds = value.split(",").map(item => Number(item.trim()));
  invariant(seeds.every(Number.isSafeInteger), "INVALID_SEEDS", "Every seed must be a safe integer.");
  return [...new Set(seeds)];
}

function requiredValue(args, index, argument) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
  return value;
}

function resolveSafeOutput(value) {
  const output = path.resolve(ROOT, value);
  const allowedRoot = path.join(ROOT, "test-results") + path.sep;
  invariant(output.startsWith(allowedRoot), "UNSAFE_OUTPUT_PATH", "Nightly output must stay under test-results/.");
  return output;
}

async function readPlaywrightAttachment(reportPath, attachment) {
  if (!attachment?.name?.endsWith(".json") && attachment?.contentType !== "application/json") return null;
  try {
    if (attachment.body) return JSON.parse(Buffer.from(attachment.body, "base64").toString("utf8"));
    if (!attachment.path) return null;
    const candidates = [
      path.resolve(path.dirname(reportPath), attachment.path),
      path.resolve(ROOT, attachment.path),
      path.resolve(attachment.path)
    ];
    for (const candidate of candidates) {
      try {
        return JSON.parse(await readFile(candidate, "utf8"));
      } catch {
        // Try the next Playwright attachment path convention.
      }
    }
  } catch {
    // Malformed evidence remains visible in the source report and is not counted as a passing observation.
  }
  return null;
}

function resolveSafeProfileInput(value) {
  const input = path.resolve(ROOT, value);
  const allowedRoots = [
    path.join(ROOT, "test-results") + path.sep,
    path.join(ROOT, "tests", "fixtures") + path.sep
  ];
  invariant(allowedRoots.some(root => input.startsWith(root)), "UNSAFE_PROFILE_INPUT", "Replay profile files must stay under test-results/ or tests/fixtures/.");
  return input;
}

function numericEnvironmentValue(name) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) ? value : null;
}

function distributionSummary(values) {
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

function buildDimensionSummary(profileResults) {
  function summarize(field) {
    const dimensions = new Map();
    for (const result of profileResults) {
      for (const [name, rawValue] of Object.entries(result[field] || {})) {
        const value = rawValue === null || rawValue === undefined ? "NOT_CONSUMED" : String(rawValue);
        const byValue = dimensions.get(name) || new Map();
        const current = byValue.get(value) || { profiles: 0, profilesWithPlans: 0, noPlans: 0, acceptedPlans: 0 };
        current.profiles += 1;
        current.profilesWithPlans += result.plans > 0 ? 1 : 0;
        current.noPlans += result.plans > 0 ? 0 : 1;
        current.acceptedPlans += result.plans;
        byValue.set(value, current);
        dimensions.set(name, byValue);
      }
    }
    return Object.fromEntries([...dimensions.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, byValue]) => [
      name,
      Object.fromEntries([...byValue.entries()].sort(([left], [right]) => left.localeCompare(right)))
    ]));
  }
  return { declared: summarize("axes"), effective: summarize("effectiveAxes") };
}

function buildHighRiskCombinationSummary(profileResults) {
  const definitions = [
    ["TRANSFER_SHORT_HORIZON", result => result.axes?.transferStatus === "transfer" && Number(result.axes?.graduationHorizon) <= 2],
    ["SENIOR", result => result.axes?.standing === "senior"],
    ["MAX_RESERVED_CAPACITY", result => Number(result.axes?.reservedCapacity) === 2],
    ["IN_PROGRESS_PATHWAY", result => result.axes?.courseStatus === "in_progress"],
    ["CLOSED_AVAILABILITY_DECLARED", result => result.axes?.availabilityState === "closed"],
    ["APPROVAL_DECLARED", result => result.axes?.approvalState !== "not-required"]
  ];
  return definitions.map(([id, matches]) => {
    const rows = profileResults.filter(matches);
    return {
      id,
      profiles: rows.length,
      profilesWithPlans: rows.filter(row => row.plans > 0).length,
      noPlans: rows.filter(row => row.plans === 0).length,
      acceptedPlans: rows.reduce((sum, row) => sum + row.plans, 0)
    };
  });
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function roundDuration(value) {
  return Math.round(value * 100) / 100;
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8"));
}

async function readTextFile(filePath) {
  const contents = await readFile(filePath);
  if (contents[0] === 0xFF && contents[1] === 0xFE) {
    return contents.subarray(2).toString("utf16le");
  }
  if (contents[0] === 0xFE && contents[1] === 0xFF) {
    return new TextDecoder("utf-16be").decode(contents.subarray(2));
  }
  return contents.toString("utf8");
}

async function writeJson(output, value) {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function failurePath(output) {
  const extension = path.extname(output);
  return `${output.slice(0, extension ? -extension.length : undefined)}.failures${extension || ".json"}`;
}

function relativeToRoot(value) {
  return path.relative(ROOT, value).replaceAll(path.sep, "/");
}

function safeErrorMessage(error) {
  return safeText(error?.message || String(error), 4000);
}

function safeText(value, maximumLength) {
  return String(value || "").replace(/[\r\n]+/gu, " ").slice(0, maximumLength);
}

function invariant(condition, code, message) {
  if (condition) return;
  const error = new Error(message);
  error.code = code;
  throw error;
}

export {
  canonicalPlannerInputHash,
  assertFictionalProfileFile,
  classifyNoPlan,
  duplicateInputGroups,
  effectivePairwiseCoverageReport,
  effectivePlannerAxes,
  plannerStudent,
  stableValue
};
