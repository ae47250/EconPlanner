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
import { resolveCatalogApplicability } from "../lib/catalog/applicability.js";
import { resolveInputResolution } from "../lib/catalog/input-resolution.js";
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
  ORDINARY_ON_TIME_COHORT_ID,
  auditGeneratedFictionalProfile,
  generateFictionalEconomicsProfiles,
  generateInvalidEconomicsNeighbors,
  loadOrdinaryOnTimeEconomicsProfiles,
  pairwiseCoverageReport,
  shrinkFictionalEconomicsProfile,
  withExplicitMayCommitment
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
const PROGRAM = Object.freeze({ id: "economics", name: "Economics" });
const METRIC_SCHEMA_VERSION = 2;
const STRATEGY_NAMES = Object.freeze({
  equal: "BALANCED",
  balanced: "BALANCED",
  "explore-first": "EXPLORE_FIRST",
  "one-year-early": "ONE_YEAR_EARLY"
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

  let generatedBySeed = [];
  let cohortDefinition = null;
  let allProfiles;
  if (configuration.cohort === ORDINARY_ON_TIME_COHORT_ID) {
    cohortDefinition = await loadOrdinaryOnTimeEconomicsProfiles({ manifest, verifiedSchedule });
    allProfiles = cohortDefinition.profiles.map(profile => ({ seed: profile.seed, profile }));
  } else {
    generatedBySeed = configuration.seeds.map(seed => {
      const generated = generateFictionalEconomicsProfiles({
        seed,
        manifest,
        verifiedSchedule,
        generatorVersion: configuration.generatorVersion
      });
      if (configuration.explicitMayCommitments) {
        generated.profiles = generated.profiles.map(profile => withExplicitMayCommitment(profile, 1));
        generated.coverage = pairwiseCoverageReport(generated.profiles);
      }
      const coverage = pairwiseCoverageReport(generated.profiles);
      invariant(
        coverage.missingPairs.length === 0,
        "PAIRWISE_COVERAGE_INCOMPLETE",
        `Seed ${seed} missed ${coverage.missingPairs.length} declared axis pairs.`
      );
      return { ...generated, coverage };
    });
    allProfiles = generatedBySeed.flatMap(({ seed, profiles }) => (
      profiles.map(profile => ({ seed, profile }))
    ));
  }
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
  const effectivePairwiseCoverage = configuration.cohort === "pairwise"
    ? effectivePairwiseCoverageReport(allEffectiveProfiles)
    : null;
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
    const cohortFields = profileCohortFields(profile, effectiveStudent, configuration);
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
      if (configuration.cohort === ORDINARY_ON_TIME_COHORT_ID) {
        invariant(
          result.inputResolution?.status === "COMPLETE" && !result.inputResolution?.planningMustRemainBlocked,
          "ORDINARY_INPUT_RESOLUTION_INCOMPLETE",
          `${profile.profileId} did not resolve as a complete ordinary student input.`
        );
      }
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
        ...cohortFields,
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
        decisionShadow: result.decisionShadow,
        allocationAlternatives: result.allocationAlternatives,
        tbcWitnessOutcomes: result.tbcWitnessOutcomes,
        catalogApplicability: result.catalogApplicability,
        catalogAnalysis: result.catalogAnalysis,
        evidenceFindings: result.evidenceFindings,
        ordinaryHanoverCourseEvidence: result.ordinaryHanoverCourseEvidence,
        inputResolution: result.inputResolution,
        fullEnrollmentEvidence: result.fullEnrollmentEvidence,
        studentNoticeCodes: result.studentNoticeCodes,
        advisorNotificationCodes: result.advisorNotificationCodes,
        advisorActionCount: result.advisorActionCount,
        publicationStatuses: result.publicationStatuses,
        planningProjectionPlanCount: result.planningProjectionPlanCount,
        acceleratedAssumptionPlanCount: result.acceleratedAssumptionPlanCount
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
        effectiveAxes,
        ...cohortFields,
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
  for (const seed of configuration.cohort === "pairwise" ? configuration.seeds : []) {
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
  const firstFinalValidatorNodes = strategyAttempts
    .map(attempt => attempt.firstFinalValidatorPlanNode)
    .filter(value => value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map(Number);
  const firstFinalValidatorTimes = strategyAttempts
    .map(attempt => attempt.timeToFirstFinalValidatorPlanMs)
    .filter(value => value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map(Number);
  const searchAttempts = profileResults.flatMap(result => result.solverDiagnostics?.searchAttempts || []);
  const orderingDecisions = searchAttempts.flatMap(attempt => (attempt.orderingTrace || []).map(decision => ({
    ...decision,
    rescue: Boolean(attempt.rescue)
  })));
  const deadEndsByRequirement = searchAttempts.reduce((counts, attempt) => {
    for (const [requirementId, count] of Object.entries(attempt.deadEndsByRequirement || {})) {
      counts[requirementId] = (counts[requirementId] || 0) + Number(count || 0);
    }
    return counts;
  }, {});
  const orderedDeadEnds = Object.entries(deadEndsByRequirement).sort((left, right) => (
    right[1] - left[1] || left[0].localeCompare(right[0])
  ));
  const planObservability = profileResults.flatMap(result => result.planObservability || []);
  const legacyFeasibilityStatuses = countBy(planObservability, plan => plan.legacyFeasibilityStatus);
  const strategyFits = countBy(planObservability, plan => `${plan.strategy}:${plan.strategyFit}`);
  const readinessStatuses = countBy(decisionShadowRecords, record => record.readinessStatus || "NOT_CLASSIFIED");
  const readyStatuses = new Set(["STUDENT_READY", "READY_WITH_CONDITIONS"]);
  const readinessByProfile = new Map(profileResults.map(result => [result.profileId, profileReadiness(result)]));
  const readyProfiles = profileResults.filter(result => readyStatuses.has(readinessByProfile.get(result.profileId)));
  const advisorActionProfiles = profileResults.filter(result => readinessByProfile.get(result.profileId) === "ADVISOR_ACTION_REQUIRED");
  const profileReadinessCounts = countBy(profileResults, result => readinessByProfile.get(result.profileId));
  const allocationCounts = profileResults.flatMap(result => Object.values(result.allocationAlternatives || {}).filter(Number.isFinite));
  const allocationPageLimitOutcomes = countBy(profileResults.flatMap(result => result.allocationAlternatives?.pageLimitOutcomes || []), value => value);
  const tbcWitnessOutcomes = countBy(profileResults.flatMap(result => result.tbcWitnessOutcomes || []), value => value);
  const catalogApplicabilityStatuses = countBy(profileResults, result => result.catalogApplicability?.status || "UNAVAILABLE");
  const studentNoticeCodes = countBy(profileResults.flatMap(result => result.studentNoticeCodes || []), value => value);
  const advisorNotificationCodes = countBy(profileResults.flatMap(result => result.advisorNotificationCodes || []), value => value);
  const evidenceFindingsByRuleId = countBy(profileResults.flatMap(result => result.evidenceFindings || []).flatMap(finding => (
    finding.ruleIds?.length ? finding.ruleIds : ["UNCLASSIFIED_REVIEW_RULE"]
  )), value => value);
  const nodeLimitProfiles = profileResults.filter(result => (
    result.solverDiagnostics?.strategyAttempts || []
  ).some(attempt => attempt.terminationReason === "NODE_LIMIT"));
  const nodeLimitProfilesWithLegacyValidatedDisplayedPlan = nodeLimitProfiles.filter(result => (
    result.planObservability || []
  ).some(plan => plan.legacyValidatedDisplayedPlan));
  const processUsage = process.resourceUsage();
  const ordinaryProductCoverage = summarizeOrdinaryProductCoverage(profileResults, failures, cohortDefinition);
  const selectionSeeds = [...new Set(allProfiles.map(({ seed }) => seed))];
  const summary = {
    schemaVersion: METRIC_SCHEMA_VERSION,
    kind: "econplanner-nightly-generated-matrix",
    generatedAt: new Date().toISOString(),
    dataClassification: "fictional-test-only",
    provenance: {
      ...runtimeProvenance(),
      generatorVersion: configuration.generatorVersion,
      cohortId: configuration.cohort === ORDINARY_ON_TIME_COHORT_ID
        ? ORDINARY_ON_TIME_COHORT_ID
        : configuration.explicitMayCommitments
          ? `economics-generator-v${configuration.generatorVersion}-explicit-may`
          : `economics-generator-v${configuration.generatorVersion}`,
      explicitMayCommitments: configuration.explicitMayCommitments,
      oraclePolicyVersion: manifest.policy?.version ?? null,
      scheduleVersion: schedule.schemaVersion ?? null
    },
    selection: {
      mode: configuration.cohort === ORDINARY_ON_TIME_COHORT_ID
        ? "frozen-ordinary-on-time-v1"
        : "fixed-seed-pairwise",
      seeds: selectionSeeds,
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
      duplicatePlannerInputs,
      historyCoverage: cohortDefinition?.historyCoverage || [],
      cohort: {
        id: configuration.cohort === ORDINARY_ON_TIME_COHORT_ID
          ? ORDINARY_ON_TIME_COHORT_ID
          : configuration.explicitMayCommitments
            ? `economics-generator-v${configuration.generatorVersion}-explicit-may`
            : `economics-generator-v${configuration.generatorVersion}`,
        category: configuration.cohort === ORDINARY_ON_TIME_COHORT_ID
          ? "ordinary-on-time"
          : "pairwise-stress",
        generatorVersion: configuration.generatorVersion,
        explicitMayCommitments: configuration.explicitMayCommitments
      }
    },
    metrics: {
      totalRuntimeMs: roundDuration(performance.now() - startedAt),
      profilesTested: selectedProfiles.length,
      profilesWithPlans,
      profilesWithoutPlans: selectedProfiles.length - profilesWithPlans,
      acceptedPlanCount,
      planCountDistribution: {
        zero: profileResults.filter(result => result.plans === 0).length,
        one: profileResults.filter(result => result.plans === 1).length,
        two: profileResults.filter(result => result.plans === 2).length,
        threePlus: profileResults.filter(result => result.plans >= 3).length
      },
      meanDistinctPlanCount: profileResults.length
        ? Math.round(profileResults.reduce((sum, result) => sum + result.plans, 0) / profileResults.length * 10000) / 10000
        : 0,
      medianDistinctPlanCount: percentile(profileResults.map(result => result.plans), 0.5),
      primaryPlanCoverage: {
        numerator: profilesWithPlans,
        denominator: selectedProfiles.length,
        percentage: selectedProfiles.length
          ? Math.round(profilesWithPlans / selectedProfiles.length * 1000000) / 10000
          : 0
      },
      ordinaryProductCoverage,
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
          availability: "MEASURED_FINAL_VALIDATOR",
          ...distributionSummary(firstFinalValidatorTimes)
        },
        nodesToFirstCompleteApprovedPlan: {
          availability: "MEASURED_FINAL_VALIDATOR",
          ...distributionSummary(firstFinalValidatorNodes)
        },
        finalValidCandidatesAfterFirst: strategyAttempts.reduce((sum, attempt) => sum + Number(attempt.finalValidCandidatesAfterFirst || 0), 0),
        normalSearch: {
          attempts: searchAttempts.filter(attempt => !attempt.rescue).length,
          nodes: distributionSummary(searchAttempts.filter(attempt => !attempt.rescue).map(attempt => attempt.nodesVisited)),
          durationMs: distributionSummary(searchAttempts.filter(attempt => !attempt.rescue).map(attempt => attempt.durationMs))
        },
        rescueSearch: {
          entries: strategyAttempts.filter(attempt => attempt.rescueTriggered).length,
          innerAttempts: searchAttempts.filter(attempt => attempt.rescue).length,
          successes: strategyAttempts.filter(attempt => attempt.rescueSucceeded).length,
          nodes: distributionSummary(searchAttempts.filter(attempt => attempt.rescue).map(attempt => attempt.nodesVisited)),
          durationMs: distributionSummary(searchAttempts.filter(attempt => attempt.rescue).map(attempt => attempt.durationMs))
        },
        dependencyAndFlexibility: {
          availability: "MEASURED_BOUNDED_TRACE",
          traceLimitPerSearchAttempt: 24,
          decisionsRecorded: orderingDecisions.length,
          legalPlacementCounts: distributionSummary(orderingDecisions.map(decision => decision.legalPlacementCount)),
          eligibleTermCounts: distributionSummary(orderingDecisions.map(decision => decision.eligibleTermCount)),
          eligibleSectionCounts: distributionSummary(orderingDecisions.map(decision => decision.eligibleSectionCount)),
          selectedOrderingDecisions: orderingDecisions.filter(decision => decision.selectedOrderingRank === 1).length,
          rescueMinimumDomainDecisions: orderingDecisions.filter(decision => decision.rescue && decision.selectedOrderingRank === 1).length,
          fixedTermAnchors: orderingDecisions.filter(decision => decision.fixedTerm).length,
          deadlineBoundAnchors: orderingDecisions.filter(decision => decision.deadlineBound).length,
          selectedRequirements: countBy(orderingDecisions, decision => decision.requirementId),
          rescueSelectionsByRequirement: countBy(orderingDecisions.filter(decision => decision.rescue), decision => decision.requirementId),
          sourceTypes: countBy(orderingDecisions.flatMap(decision => decision.sourceTypes || []), value => value),
          deadEndsByRequirement: Object.fromEntries(orderedDeadEnds),
          mostDeadEnds: orderedDeadEnds.length ? { requirementId: orderedDeadEnds[0][0], count: orderedDeadEnds[0][1] } : null,
          flexibleCourseMovement: {
            availability: "NOT_MEASURED",
            reasonCode: "BOUNDED_ORDERING_TRACE_DOES_NOT_INFER_A_COURSE_MOVE_WITHOUT_A_PAIRED_STATE_TRANSITION"
          }
        },
        limitBehavior: {
          nodeLimitProfiles: nodeLimitProfiles.length,
          nodeLimitProfilesWithLegacyValidatedDisplayedPlan: nodeLimitProfilesWithLegacyValidatedDisplayedPlan.length,
          exactIncumbentPreservation: {
            availability: "MEASURED",
            preservedProfiles: strategyAttempts.filter(attempt => attempt.incumbentPreservedAtLimit).length,
            incumbentSignatures: [...new Set(strategyAttempts.map(attempt => attempt.firstIncumbentSignature).filter(Boolean))].sort()
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
          evidenceStatuses: countBy(decisionShadowRecords, record => record.evidenceStatus),
          readinessStatuses,
          profilesByReadiness: {
            STUDENT_READY: profileReadinessCounts.STUDENT_READY || 0,
            READY_WITH_CONDITIONS: profileReadinessCounts.READY_WITH_CONDITIONS || 0,
            ADVISOR_ACTION_REQUIRED: profileReadinessCounts.ADVISOR_ACTION_REQUIRED || 0,
            NOT_READY: profileReadinessCounts.NOT_READY || 0
          }
        },
        legacyValidationProxy: {
          availability: "PROXY",
          measurementBasis: "LEGACY_DISPLAYED_PLAN_VALIDATION_AND_UNSCHEDULED_COUNT",
          profilesWithLegacyValidatedDisplayedPlan: profileResults.filter(result => result.legacyValidatedDisplayedPlan).length,
          displayedPlansValidatedAndScheduled: planObservability.filter(plan => plan.legacyValidatedDisplayedPlan).length,
          plansByLegacyFeasibilityStatus: legacyFeasibilityStatuses
        },
        primaryProductCoverage: {
          availability: "MEASURED_AUTHORITY",
          reasonCode: null,
          measurementBasis: "PRODUCTION_DECISION_ENGINE_READINESS",
          numerator: readyProfiles.length,
          denominator: selectedProfiles.length,
          denominatorAvailability: "MEASURED",
          percentage: selectedProfiles.length
            ? Math.round((readyProfiles.length / selectedProfiles.length) * 1000000) / 10000
            : 0
        },
        advisorActionRequiredProfiles: advisorActionProfiles.length,
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
      cp5a: {
        profilesWithMayPlannerCourse: profileResults.filter(result => (result.planObservability || []).some(plan => plan.mayPlacementCount > 0)).length,
        freshmenWithTwoDistinctMayTerms: profileResults.filter(result => result.axes?.standing === "freshman"
          && (result.planObservability || []).some(plan => plan.mayTermCount >= 2)).length,
        sophomoresWithTwoDistinctMayTerms: profileResults.filter(result => result.axes?.standing === "sophomore"
          && (result.planObservability || []).some(plan => plan.mayTermCount >= 2)).length,
        exactNamedMayPlacements: planObservability.reduce((sum, plan) => sum + plan.exactNamedMayPlacements, 0),
        ownerApprovedHistoricalNamedMayPlacements: planObservability.reduce((sum, plan) => sum + plan.historicalNamedMayPlacements, 0),
        catalogNamedMayPlacements: planObservability.reduce((sum, plan) => sum + plan.catalogNamedMayPlacements, 0),
        genericMayPlaceholders: planObservability.reduce((sum, plan) => sum + plan.genericMayPlaceholders, 0),
        unsupportedMayPlacements: planObservability.reduce((sum, plan) => sum + plan.unsupportedMayPlacements, 0),
        annualDistributionCounts: countBy(planObservability.flatMap(plan => plan.annualDistributions || []), value => (
          ["1/2/1", "2/1/1", "2/2/0"].includes(value) ? value : "other"
        )),
        sourceMix: planObservability.reduce((totals, plan) => {
          for (const [source, count] of Object.entries(plan.sourceMix || {})) {
            totals[source] = Number(totals[source] || 0) + Number(count || 0);
          }
          return totals;
        }, {}),
        veryLowHistoricalSelections: planObservability.reduce((sum, plan) => sum + plan.veryLowHistoricalSelections, 0),
        eco321Busn323PairedPlans: planObservability.filter(plan => plan.eco321Busn323Pair).length,
        prerequisiteNoticeCodes: countBy(planObservability.flatMap(plan => plan.prerequisiteNoticeCodes || []), value => value),
        degreeDesignationCodes: countBy(planObservability.flatMap(plan => plan.degreeDesignationCodes || []), value => value)
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
      cp4bA: {
        allocationAlternativeCounts: distributionSummary(allocationCounts),
        profilesWithMultipleValidAllocations: profileResults.filter(result => result.allocationAlternatives?.multipleValidAllocations).length,
        allocationPageLimitOutcomes,
        tbcWitnessOutcomes,
        impossiblePrecedenceBlocks: Number(tbcWitnessOutcomes.BLOCK || 0),
        catalogApplicabilityStatuses,
        evidenceFindingsByRuleId,
        searchIncompleteProfiles: profileResults.filter(result => result.noPlan?.reason === "SEARCH_INCOMPLETE").length
      },
      cp4bB: {
        catalogApplicabilityStatuses,
        exactDeclarationCatalogProfiles: profileResults.filter(result => result.catalogApplicability?.status === "EXACT_DECLARATION_CATALOG").length,
        latestFlexibleFallbackProfiles: profileResults.filter(result => result.catalogApplicability?.status === "LATEST_FLEXIBLE_FALLBACK").length,
        materialCatalogDifferenceProfiles: profileResults.filter(result => result.catalogApplicability?.materialDifferences?.length).length,
        canonicalCatalogNotices: profileResults.filter(result => result.catalogApplicability?.advisorNotice?.reasonCode === "LATEST_FLEXIBLE_MAJOR_RULES_APPLIED").length,
        inputResolutionStatuses: countBy(profileResults, result => result.inputResolution?.status || "UNCLASSIFIED"),
        recoverableWithOneAnswer: profileResults.filter(result => result.inputResolution?.planningMustRemainBlocked && result.inputResolution?.answerCount === 1).length,
        recoverableWithSeveralAnswers: profileResults.filter(result => result.inputResolution?.planningMustRemainBlocked && result.inputResolution?.answerCount > 1).length,
        conditionalPlanningEligible: profileResults.filter(result => result.inputResolution?.planningCanContinueConditionally).length,
        fullAffectedProfiles: profileResults.filter(result => result.fullEnrollmentEvidence?.length).length,
        fullAffectedPlans: new Set(profileResults.flatMap(result => (result.fullEnrollmentEvidence || []).map(row => `${result.profileId}|${row.planId}`))).size,
        equivalencyScopeFindings: Number(evidenceFindingsByRuleId["REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE"] || 0),
        equivalencyScopeAffectedProfiles: profileResults.filter(result => (result.evidenceFindings || []).some(finding => finding.ruleIds?.includes("REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE"))).length,
        ordinaryHanoverCourseEvidence: profileResults.reduce((sum, result) => sum + (result.ordinaryHanoverCourseEvidence?.length || 0), 0),
        profilesHelpedByPsy217: 0,
        profilesHelpedByBusn323: 0,
        profilesHelpedByComprehensiveEvaluationRemoval: 0,
        productionFullPolicy: "REVIEW_REQUIRED",
        followup: {
          designatedRequirementSetYear: "2025-2026",
          studentNoticeCodes,
          advisorNotificationCodes,
          advisorNotificationProfiles: profileResults.filter(result => result.advisorNotificationCodes?.length).length,
          substantiveAdvisorActionProfiles: profileResults.filter(result => result.advisorActionCount > 0).length,
          substantiveAdvisorActions: profileResults.reduce((sum, result) => sum + Number(result.advisorActionCount || 0), 0),
          sacPetitionNotificationProfiles: profileResults.filter(result => result.advisorNotificationCodes?.includes("FLEXIBLE_MAJOR_REQUIREMENTS_SAC_PETITION_NOTICE")).length,
          unknownIncomingYearNotificationProfiles: profileResults.filter(result => result.advisorNotificationCodes?.includes("FLEXIBLE_MAJOR_REQUIREMENTS_INCOMING_YEAR_UNKNOWN")).length,
          planningProjectionProfiles: profileResults.filter(result => result.planningProjectionPlanCount > 0).length,
          planningProjectionPlans: profileResults.reduce((sum, result) => sum + Number(result.planningProjectionPlanCount || 0), 0),
          acceleratedAssumptionProfiles: profileResults.filter(result => result.acceleratedAssumptionPlanCount > 0).length,
          acceleratedAssumptionPlans: profileResults.reduce((sum, result) => sum + Number(result.acceleratedAssumptionPlanCount || 0), 0)
        }
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
  if (configuration.writeCp4bAArtifacts) {
    invariant(isFrozenCp4Cohort(configuration, summary), "CP4B_A_ARTIFACT_SCOPE", "CP4b-A committed artifacts may be written only from the complete frozen 368-profile cohort.");
    await writeCp4bAArtifacts(summary);
  }
  if (configuration.writeCp4bBArtifacts) {
    invariant(isFrozenCp4Cohort(configuration, summary), "CP4B_B_ARTIFACT_SCOPE", "CP4b-B committed artifacts may be written only from the complete frozen 368-profile cohort.");
    await writeCp4bBArtifacts(summary);
  }
  if (configuration.writeCp4bBFollowupArtifacts) {
    invariant(isFrozenCp4Cohort(configuration, summary), "CP4B_B_FOLLOWUP_ARTIFACT_SCOPE", "CP4b-B follow-up artifacts may be written only from the complete frozen 368-profile cohort.");
    await writeCp4bBFollowupArtifacts(summary);
  }
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
      seeds: selectionSeeds,
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
    && configuration.generatorVersion === 3
    && configuration.explicitMayCommitments === false
    && summary.selection.totalProfilesAcrossAllShards === 368
    && configuration.seeds.length === DEFAULT_SEEDS.length
    && configuration.seeds.every((seed, index) => seed === DEFAULT_SEEDS[index]);
}

export function assertFrozenCp4AuthoritySummary(summary) {
  const evidenceStatuses = summary.metrics?.completion?.shadowDecision?.evidenceStatuses || {};
  invariant(summary.metrics?.profilesTested === 368, "CP4_FROZEN_PROFILE_COUNT", "CP4 frozen cohort must contain 368 profiles.");
  invariant(summary.metrics?.profilesWithPlans >= 186, "CP4_FROZEN_COVERAGE_REGRESSION", "CP4 frozen cohort coverage fell below 186 complete-plan profiles.");
  invariant(summary.metrics?.acceptedPlanCount >= 439, "CP4_FROZEN_PLAN_COUNT", "CP4 frozen cohort must retain at least the 439 previously displayed plans.");
  invariant(Object.values(evidenceStatuses).reduce((sum, value) => sum + Number(value || 0), 0) === summary.metrics?.acceptedPlanCount,
    "CP4B_A_EVIDENCE_ACCOUNTING", "Every displayed plan must retain exactly one evidence status after CP4b-A classification.");
  invariant(summary.metrics?.productionDecisionEngine?.unexpectedDisagreements === 0,
    "CP4_UNEXPECTED_ENGINE_DISAGREEMENT", "CP4 frozen cohort contains an unexpected Production Decision Engine disagreement.");
  invariant(summary.metrics?.oracleDisagreementCount === 0 && summary.metrics?.unclassifiedOracleDisagreementCount === 0,
    "CP4_ORACLE_DISAGREEMENT", "CP4 frozen cohort contains a Production Decision Engine versus Oracle disagreement.");
  const decisionRecords = (summary.profiles || []).flatMap(profile => profile.decisionShadow || []);
  invariant(decisionRecords.length === summary.metrics.acceptedPlanCount,
    "CP4_OBSERVABILITY_PLAN_COUNT", "Every displayed CP4 plan must have one authoritative observability record.");
  const observedEvidenceStatuses = countBy(decisionRecords, record => record.evidenceStatus);
  invariant([...new Set([...Object.keys(observedEvidenceStatuses), ...Object.keys(evidenceStatuses)])]
    .every(status => Number(observedEvidenceStatuses[status] || 0) === Number(evidenceStatuses[status] || 0)),
    "CP4_OBSERVABILITY_EVIDENCE_DRIFT", "Authoritative observability records do not match the CP4b-A evidence counts.");
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
  invariant(convergences.every(item => (
    item.profileId
    && item.keptLabel
    && item.convergedLabel
    && item.code === "PLANS_CONVERGED"
  )), "CP4_FROZEN_CONVERGENCE_DRIFT", "Every reported semantic convergence must retain its profile and plan identities.");
  return Object.freeze({
    profiles: 368,
    profilesWithPlans: summary.metrics.profilesWithPlans,
    displayedPlans: summary.metrics.acceptedPlanCount,
    evidenceStatuses,
    convergenceProfiles: [...new Set(convergences.map(item => item.profileId))].sort()
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
  const annualDistributions = [...new Set((plan?.terms || []).map(term => term.yearIndex))]
    .sort((left, right) => left - right)
    .map(yearIndex => {
      const yearTerms = (plan?.terms || []).filter(term => term.yearIndex === yearIndex);
      const count = key => yearTerms
        .filter(term => key === "May" ? ["Spring", "May"].includes(term.termKey) : term.termKey === key)
        .reduce((sum, term) => sum + (term.courses || []).length, 0);
      return `${count("Fall")}/${count("Winter")}/${count("May")}`;
    });
  const placements = (plan?.terms || []).flatMap(term => (
    (term.courses || []).map(course => ({ term, course }))
  ));
  const mayPlacements = placements.filter(({ term }) => ["Spring", "May"].includes(term.termKey));
  const sourceMix = countBy(placements, ({ course }) => course.source || "UNCLASSIFIED");
  const allocationAssignments = plan?.validation?.requirementAllocation?.assignments || [];
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
    readinessStatus: shadow?.readinessStatus || plan?.validation?.readinessStatus || null,
    planDisposition: shadow?.planDisposition || plan?.validation?.planDisposition || null,
    advisorActionRequired: Boolean(shadow?.advisorActionRequired ?? plan?.validation?.advisorActionRequired),
    advisorActionCount: Number(shadow?.advisorActionCount ?? plan?.validation?.advisorActions?.length ?? 0),
    allocationId: shadow?.allocationId || plan?.validation?.requirementAllocation?.allocationId || null,
    temporalWitnessStatus: shadow?.temporalWitnessStatus || plan?.validation?.temporalSemantics?.status || "NOT_APPLICABLE",
    catalogApplicabilityStatus: shadow?.catalogApplicabilityStatus || plan?.validation?.catalogApplicability?.status || null,
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
    annualDistributions,
    mayPlacementCount: mayPlacements.length,
    mayTermCount: new Set(mayPlacements.map(({ term }) => `${term.academicYear}:${term.termKey}`)).size,
    exactNamedMayPlacements: mayPlacements.filter(({ course }) => course.source === "verified-offering" && course.course !== "ECO elective").length,
    historicalNamedMayPlacements: mayPlacements.filter(({ course }) => course.source === "historical-pattern" && course.course !== "ECO elective").length,
    catalogNamedMayPlacements: mayPlacements.filter(({ course }) => course.source === "catalog-statement" && course.course !== "ECO elective").length,
    genericMayPlaceholders: mayPlacements.filter(({ course }) => course.course === "ECO elective" || course.source === "requirement-placeholder").length,
    unsupportedMayPlacements: mayPlacements.filter(({ course }) => ![
      "verified-offering", "historical-pattern", "catalog-statement", "projected-offering", "requirement-placeholder"
    ].includes(course.source)).length,
    sourceMix,
    veryLowHistoricalSelections: placements.filter(({ course }) => course.historicalPriority === "VERY_LOW").length,
    prerequisiteNoticeCodes: (plan?.prerequisiteNotices || []).map(notice => notice.code).sort(),
    degreeDesignationCodes: (plan?.degreeRequirementInformation?.items || []).map(item => item.code).sort(),
    eco321Busn323Pair: allocationAssignments.some(item => item.slotId === "finance" && item.code === "BUSN 323")
      && allocationAssignments.some(item => String(item.slotId).startsWith("eco-elective") && item.code === "ECO 321"),
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

function buildFullEnrollmentEvidence(plans, requirements, schedule, mapping) {
  const rows = [];
  const plansWithoutFull = new Set(plans.filter(plan => !(plan.validation?.reviewFindings || []).some(finding => (
    finding.reasonCode === "ENROLLMENT_FULL" || finding.offeringEvidence?.enrollmentState === "FULL"
  ))).map(plan => plan.id));
  for (const plan of plans) {
    const findings = (plan.validation?.reviewFindings || []).filter(finding => (
      finding.reasonCode === "ENROLLMENT_FULL" || finding.offeringEvidence?.enrollmentState === "FULL"
    ));
    for (const finding of findings) {
      const course = finding.subject?.course || finding.course || null;
      const placement = plan.terms.flatMap(term => (term.courses || []).map(item => ({term, item})))
        .find(item => !course || item.item.course === course);
      const termKey = placement?.term?.termKey || null;
      const section = placement?.item?.section || finding.offeringEvidence?.section || null;
      const sameTerm = Array.isArray(schedule.terms?.[termKey]) ? schedule.terms[termKey] : [];
      const otherSections = sameTerm.filter(item => item.course === course && item.section !== section);
      const usableOtherSections = otherSections.filter(item => item.availability?.status !== "closed");
      const otherTerms = Object.entries(schedule.terms || {}).flatMap(([candidateTerm, offerings]) => (
        candidateTerm === termKey ? [] : offerings.filter(item => item.course === course && item.availability?.status !== "closed")
          .map(item => ({termKey: candidateTerm, section: item.section, availability: item.availability?.status || "unknown"}))
      ));
      const requirementId = placement?.item?.requirementId || finding.subject?.requirementId || null;
      const requirement = requirements.requirementSlots?.find(slot => slot.id === requirementId);
      const alternativeRequirementOptions = (requirement?.options || []).filter(option => option !== course);
      const waitlistExists = [...otherSections, ...Object.values(schedule.terms || {}).flat()]
        .some(item => item.course === course && item.availability?.status === "waitlisted");
      const anotherVerifiedSectionExists = usableOtherSections.length > 0;
      const anotherValidTermExists = otherTerms.length > 0;
      const anotherValidRequirementOptionExists = alternativeRequirementOptions.length > 0;
      const alternativeRequirementAllocationExists = Boolean(mapping.strict?.allocationAlternatives?.length > 1
        || mapping.optimistic?.allocationAlternatives?.length > 1
        || mapping.projectedAfterInProgress?.strict?.allocationAlternatives?.length > 1
        || mapping.projectedAfterInProgress?.optimistic?.allocationAlternatives?.length > 1);
      const backupCompletePlanExists = plansWithoutFull.size > 0;
      const hasAlternative = waitlistExists || anotherVerifiedSectionExists || anotherValidTermExists
        || anotherValidRequirementOptionExists || alternativeRequirementAllocationExists || backupCompletePlanExists;
      rows.push({
        planId: plan.id,
        course,
        term: placement?.term?.term || null,
        termKey,
        section,
        productionPolicy: "FULL_REVIEW_REQUIRED",
        waitlistExists,
        anotherVerifiedSectionExists,
        otherSections: usableOtherSections.map(item => ({section: item.section, availability: item.availability?.status || "unknown"})),
        anotherValidTermExists,
        otherTerms,
        anotherValidRequirementOptionExists,
        alternativeRequirementOptions,
        alternativeRequirementAllocationExists,
        backupCompletePlanExists,
        noAlternative: !hasAlternative,
        ruleIds: finding.ruleIds || ["SCHEDULE-AVAILABILITY-BEHAVIOR"],
        sourceRefs: finding.sourceRefs || []
      });
    }
  }
  return rows.sort((left, right) => `${left.planId}|${left.course}|${left.term}|${left.section}`.localeCompare(`${right.planId}|${right.course}|${right.term}|${right.section}`));
}

async function evaluateProfile({ profile, manifest, verifiedSchedule, requirements, prerequisites, schedule, policyBundle, canonicalPolicy }) {
  const generatorAudit = auditGeneratedFictionalProfile(profile, manifest, verifiedSchedule);
  invariant(profile.fictional === true, "NON_FICTIONAL_PROFILE", `${profile.profileId} is not marked fictional.`);
  invariant(generatorAudit.valid, "GENERATED_PROFILE_POLICY_FAILURE", JSON.stringify(generatorAudit.violations));

  const student = plannerStudent(profile);
  const basePlanningContext = resolvePlanningContext(student);
  const catalogApplicability = resolveCatalogApplicability({
    majorDeclarationCatalogYear: basePlanningContext.submittedMajorDeclarationCatalogYear,
    entryCatalogYear: basePlanningContext.entryCatalogYear,
    currentCatalogYear: basePlanningContext.currentCatalogYear,
    availableCatalogYears: ["2023-2024", "2024-2025", "2025-2026"],
    sourceRefs: [`POLICY-RELEASE#${policyBundle.bundleVersion}`]
  });
  const planningContext = { ...basePlanningContext, catalogApplicability };
  const mapping = mapStudentToProgram(PROGRAM, requirements, student, { policyBundle, catalogApplicability });
  const planBundle = buildEconomicsTermPlans({
    student,
    mapping,
    schedule,
    prerequisites,
    collectDiagnostics: true,
    policyBundle,
    planningContext,
    catalogApplicability
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
      completionStatus: plan.validation.completionStatus,
      evidenceStatus: plan.validation.evidenceStatus,
      readinessStatus: plan.validation.readinessStatus,
      planDisposition: plan.validation.planDisposition,
      advisorActionRequired: plan.validation.advisorActionRequired,
      advisorActionCount: plan.validation.advisorActions?.length || 0,
      catalogApplicabilityStatus: plan.validation.catalogApplicability?.status || null,
      allocationId: plan.validation.requirementAllocation?.allocationId || null,
      temporalWitnessStatus: plan.validation.temporalSemantics?.status || "NOT_APPLICABLE",
      ...shadow
    });
  }

  const planObservability = planBundle.plans.map((plan, index) => characterizeDisplayedPlan(plan, decisionShadow[index]));
  const noPlan = planBundle.plans.length === 0 ? classifyNoPlan(planBundle) : null;
  const issueCode = planBundle.metricsDiagnostics?.invalidInput?.code === "INVALID_TRANSFER_CONTEXT"
    ? "INVALID_TRANSFER_PLANNING_INPUT"
    : planBundle.metricsDiagnostics?.invalidInput
      ? "INVALID_PLANNING_PACE"
      : null;
  const inputResolution = resolveInputResolution({student, planningContext, catalogApplicability, issueCode});
  const fullEnrollmentEvidence = buildFullEnrollmentEvidence(planBundle.plans, requirements, schedule, mapping);
  const ordinaryHanoverCourseEvidence = student.courses
    .filter(course => ["completed", "in_progress"].includes(course.status) && policyBundle.indexes?.coursesByCode?.[course.code])
    .map(course => ({
      course: course.code,
      status: course.status,
      canonicalPolicyIdentity: policyBundle.indexes.coursesByCode[course.code].canonicalId || course.code,
      evidence: "Canonical Hanover course identity in the active policy bundle"
    }))
    .sort((left, right) => left.course.localeCompare(right.course));
  const studentNoticeCodes = [...new Set(planBundle.plans.flatMap(plan => (
    (plan.studentNotices || []).map(notice => notice.code)
  )))].sort();
  const advisorNotificationCodes = [...new Set(planBundle.plans.flatMap(plan => (
    (plan.advisorNotifications || []).map(notice => notice.code)
  )))].sort();
  const advisorActionIds = new Set(planBundle.plans.flatMap(plan => (
    (plan.advisorActions || []).map(action => action.actionId || JSON.stringify(stableValue(action)))
  )));
  const publicationStatuses = countBy(planBundle.plans, plan => plan.publicationStatus || "UNCLASSIFIED");
  const planningProjectionPlanCount = planBundle.plans.filter(plan => plan.publicationStatus === "PLANNING_PROJECTION").length;
  const acceleratedAssumptionPlanCount = planBundle.plans.filter(plan => (
    plan.studentNotices?.some(notice => notice.code === "ACCELERATED_PLAN_SENIOR_STANDING_ASSUMED")
  )).length;

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
    decisionShadow,
    allocationAlternatives: {
      strict: mapping.strict?.allocationAlternatives?.length || 0,
      optimistic: mapping.optimistic?.allocationAlternatives?.length || 0,
      projectedStrict: mapping.projectedAfterInProgress?.strict?.allocationAlternatives?.length || 0,
      projectedOptimistic: mapping.projectedAfterInProgress?.optimistic?.allocationAlternatives?.length || 0,
      multipleValidAllocations: [mapping.strict, mapping.optimistic, mapping.projectedAfterInProgress?.strict, mapping.projectedAfterInProgress?.optimistic]
        .some(scenario => (scenario?.allocationAlternatives?.length || 0) > 1),
      pageLimitOutcomes: [mapping.strict, mapping.optimistic, mapping.projectedAfterInProgress?.strict, mapping.projectedAfterInProgress?.optimistic]
        .map(scenario => scenario?.allocationSearch?.terminationReason || "EXHAUSTED")
    },
    tbcWitnessOutcomes: planBundle.plans.map(plan => plan.validation?.temporalSemantics?.status || "NOT_APPLICABLE"),
    catalogApplicability,
    catalogAnalysis: {
      inferredEntryYear: basePlanningContext.entryCatalogYear,
      currentCatalogYear: basePlanningContext.currentCatalogYear,
      submittedMajorDeclarationCatalogYear: basePlanningContext.submittedMajorDeclarationCatalogYear,
      confirmedMajorDeclarationCatalogYear: basePlanningContext.majorDeclarationCatalogYear
    },
    evidenceFindings: decisionShadow.flatMap(record => record.reviewFindings || []),
    ordinaryHanoverCourseEvidence,
    inputResolution,
    fullEnrollmentEvidence,
    studentNoticeCodes,
    advisorNotificationCodes,
    advisorActionCount: advisorActionIds.size,
    publicationStatuses,
    planningProjectionPlanCount,
    acceleratedAssumptionPlanCount
  };
}

function plannerStudent(profile) {
  const student = {
    academicStanding: profile.student.academicStanding,
    planningPace: profile.student.planningPace || "standard",
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
  const context = resolvePlanningContext(student);
  const statuses = new Set((student.courses || []).map(course => course.status));
  const reservedValues = Object.values(student.reservedCourseUnits || {});
  return {
    standing: context.effectiveStanding ?? null,
    planningPace: context.planningPace ?? null,
    seniorStandingConfirmationState: declared.seniorStandingConfirmationState ?? null,
    planDate: student.planCreationDate ?? null,
    transferStatus: student.isTransferStudent ? "transfer" : "regular",
    graduationHorizon: context.remainingYears ?? null,
    courseStatus: statuses.has(declared.courseStatus) ? declared.courseStatus : null,
    completedPathway: (student.courses || []).length ? declared.completedPathway ?? null : null,
    reservedCapacity: reservedValues.length ? Math.max(...reservedValues) : null,
    availabilityState: null,
    approvalState: null,
    historyCategory: declared.historyCategory ?? null
  };
}

function profileCohortFields(profile, student, configuration) {
  const context = resolvePlanningContext(student);
  return {
    cohortCategory: configuration.cohort === ORDINARY_ON_TIME_COHORT_ID
      ? "ordinary-on-time"
      : "pairwise-stress",
    historyCategory: profile?.cohort?.historyCategory || profile?.axes?.historyCategory || null,
    declaredStanding: profile?.axes?.standing || profile?.student?.academicStanding || null,
    resolvedEffectiveStanding: context.effectiveStanding,
    effectiveRemainingYears: context.remainingYears,
    expectedGraduationYear: context.expectedGraduationYear
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
      ...(configuration.cohort === ORDINARY_ON_TIME_COHORT_ID
        ? ["--cohort", ORDINARY_ON_TIME_COHORT_ID]
        : []),
      "--seeds",
      String(seed),
      "--generator-version",
      String(configuration.generatorVersion),
      ...(configuration.explicitMayCommitments ? ["--explicit-may-commitments"] : []),
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
  if (profile?.generation?.shrinkable === false) return null;
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
    cohort: "pairwise",
    seeds: [...DEFAULT_SEEDS],
    shardIndex: 1,
    shardTotal: 1,
    output: path.join(ROOT, "test-results", "economics-nightly-matrix", "summary.json"),
    inputs: [],
    normalLog: null,
    optionalLog: null,
    profileId: null,
    profileFile: null,
    generatorVersion: ECONOMICS_GENERATOR_VERSION,
    explicitMayCommitments: false,
    writeCp4bAArtifacts: false,
    writeCp4bBArtifacts: false,
    writeCp4bBFollowupArtifacts: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--summarize-playwright") {
      result.mode = "playwright-summary";
    } else if (argument === "--summarize-prerequisites") {
      result.mode = "prerequisite-summary";
    } else if (argument === "--seeds") {
      result.seeds = parseSeeds(requiredValue(args, ++index, argument));
    } else if (argument === "--cohort") {
      result.cohort = requiredValue(args, ++index, argument);
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
    } else if (argument === "--generator-version") {
      result.generatorVersion = Number(requiredValue(args, ++index, argument));
    } else if (argument === "--explicit-may-commitments") {
      result.explicitMayCommitments = true;
    } else if (argument === "--write-cp4b-a-artifacts") {
      result.writeCp4bAArtifacts = true;
    } else if (argument === "--write-cp4b-b-artifacts") {
      result.writeCp4bBArtifacts = true;
    } else if (argument === "--write-cp4b-b-followup-artifacts") {
      result.writeCp4bBFollowupArtifacts = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  invariant(Number.isInteger(result.shardIndex) && Number.isInteger(result.shardTotal)
    && result.shardIndex >= 1 && result.shardIndex <= result.shardTotal,
  "INVALID_SHARD", "--shard must use INDEX/TOTAL with 1 <= INDEX <= TOTAL.");
  invariant(result.seeds.length > 0, "INVALID_SEEDS", "At least one fixed seed is required.");
  invariant(["pairwise", ORDINARY_ON_TIME_COHORT_ID].includes(result.cohort),
    "INVALID_COHORT", `--cohort must be pairwise or ${ORDINARY_ON_TIME_COHORT_ID}.`);
  invariant([3, 4].includes(result.generatorVersion), "INVALID_GENERATOR_VERSION", "--generator-version must be 3 or 4.");
  invariant(!(result.cohort === ORDINARY_ON_TIME_COHORT_ID && result.explicitMayCommitments),
    "ORDINARY_COHORT_MAY_STRESS", "The ordinary cohort cannot include explicit May commitments.");
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

function summarizeOrdinaryProductCoverage(profileResults, failures, cohortDefinition) {
  function coverage(rows, failedRows) {
    const denominator = rows.length + failedRows.length;
    const numerator = rows.filter(row => row.plans > 0).length;
    return {
      numerator,
      denominator,
      zeroPlanCount: rows.filter(row => row.plans === 0).length + failedRows.length,
      percentage: denominator ? Math.round(numerator / denominator * 1000000) / 10000 : null,
      planCountDistribution: {
        zero: rows.filter(row => row.plans === 0).length + failedRows.length,
        one: rows.filter(row => row.plans === 1).length,
        two: rows.filter(row => row.plans === 2).length,
        threePlus: rows.filter(row => row.plans >= 3).length
      }
    };
  }

  if (!cohortDefinition) {
    return {
      schemaVersion: 1,
      metricId: "ordinary-on-time-plan-coverage-v1",
      role: "PRIMARY_PRODUCT_KPI",
      availability: "NOT_APPLICABLE",
      reasonCode: "PAIRWISE_STRESS_COHORT",
      cohortId: null,
      measurementBasis: "FINAL_VALIDATOR_ACCEPTED_PLANS",
      overall: coverage([], []),
      byStanding: {},
      historyCoverage: []
    };
  }

  const ordinaryProfiles = profileResults.filter(row => row.cohortCategory === "ordinary-on-time");
  const ordinaryFailures = failures.filter(row => row.cohortCategory === "ordinary-on-time");
  const byStanding = Object.fromEntries(cohortDefinition.historyCoverage.map(design => [
    design.standing,
    {
      ...coverage(
        ordinaryProfiles.filter(row => row.resolvedEffectiveStanding === design.standing),
        ordinaryFailures.filter(row => row.resolvedEffectiveStanding === design.standing)
      ),
      normalRemainingYears: design.normalRemainingYears,
      historyCategories: design.historyCategories,
      justification: design.justification
    }
  ]));
  return {
    schemaVersion: 1,
    metricId: "ordinary-on-time-plan-coverage-v1",
    role: "PRIMARY_PRODUCT_KPI",
    availability: "MEASURED_AUTHORITY",
    reasonCode: null,
    cohortId: ORDINARY_ON_TIME_COHORT_ID,
    measurementBasis: "FINAL_VALIDATOR_ACCEPTED_PLANS",
    overall: coverage(ordinaryProfiles, ordinaryFailures),
    byStanding,
    historyCoverage: cohortDefinition.historyCoverage
  };
}

function buildDimensionSummary(profileResults) {
  function summarize(field) {
    const dimensions = new Map();
    for (const result of profileResults) {
      for (const [name, rawValue] of Object.entries(result[field] || {})) {
        const value = rawValue === null || rawValue === undefined ? "NOT_CONSUMED" : String(rawValue);
        const byValue = dimensions.get(name) || new Map();
        const current = byValue.get(value) || {
          profiles: 0,
          profilesWithPlans: 0,
          noPlans: 0,
          acceptedPlans: 0,
          planCountDistribution: { zero: 0, one: 0, two: 0, threePlus: 0 },
          planCounts: []
        };
        current.profiles += 1;
        current.profilesWithPlans += result.plans > 0 ? 1 : 0;
        current.noPlans += result.plans > 0 ? 0 : 1;
        current.acceptedPlans += result.plans;
        const planCountKey = result.plans === 0 ? "zero" : result.plans === 1 ? "one" : result.plans === 2 ? "two" : "threePlus";
        current.planCountDistribution[planCountKey] += 1;
        current.planCounts.push(result.plans);
        byValue.set(value, current);
        dimensions.set(name, byValue);
      }
    }
    return Object.fromEntries([...dimensions.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, byValue]) => [
      name,
      Object.fromEntries([...byValue.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([value, current]) => [
        value,
        {
          profiles: current.profiles,
          profilesWithPlans: current.profilesWithPlans,
          noPlans: current.noPlans,
          acceptedPlans: current.acceptedPlans,
          coveragePercentage: current.profiles ? Math.round(current.profilesWithPlans / current.profiles * 1000000) / 10000 : 0,
          planCountDistribution: current.planCountDistribution,
          meanDistinctPlanCount: current.profiles ? Math.round(current.acceptedPlans / current.profiles * 10000) / 10000 : 0,
          medianDistinctPlanCount: percentile(current.planCounts, 0.5)
        }
      ]))
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

function markdownCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
}

async function writeCp4bAArtifacts(summary) {
  const profiles = [...summary.profiles].sort((left, right) => left.profileId.localeCompare(right.profileId));
  const ledgerRows = profiles.flatMap(profile => (profile.decisionShadow || []).map((record, index) => {
    const signature = profile.planSignatures?.[index] || null;
    const controllingRuleIds = [...new Set([
      ...(record.reviewFindings || []).flatMap(finding => finding.ruleIds || []),
      ...(record.catalogApplicabilityStatus === "EXACT" ? [] : ["CATALOG-APPLICABILITY-DECLARATION-YEAR"])
    ])].sort();
    const sourceReferences = [...new Set([
      ...(record.reviewFindings || []).flatMap(finding => finding.sourceRefs || []),
      `POLICY-RELEASE#${record.policyBundleVersion}`
    ])].sort();
    return {
      profileId: profile.profileId,
      planId: record.planId,
      previous: {
        readinessStatus: "NOT_CLASSIFIED_CP4",
        evidenceStatus: record.evidenceStatus,
        completionStatus: record.completionStatus,
        semanticSignature: signature
      },
      current: {
        readinessStatus: record.readinessStatus,
        evidenceStatus: record.evidenceStatus,
        completionStatus: record.completionStatus,
        semanticSignature: signature
      },
      allocationId: record.allocationId,
      controllingRuleIds,
      sourceReferences,
      reason: "CP4b-A adds authoritative readiness, allocation, TBC-witness, evidence-fact, and catalog-applicability metadata without changing the displayed schedule.",
      changeClassification: "intended"
    };
  })).sort((left, right) => `${left.profileId}|${left.planId}`.localeCompare(`${right.profileId}|${right.planId}`));
  const ledger = {
    schemaVersion: 1,
    kind: "cp4b-a-change-ledger",
    comparisonBaseline: {
      commit: "594ba69a88ab3d2077afcd51c8752ebb957b348c",
      profiles: 368,
      profilesWithCompletePlan: 186,
      displayedPlans: 439,
      evidenceStatuses: { PRELIMINARY: 193, REVIEW_REQUIRED: 246 }
    },
    rows: ledgerRows
  };
  const ledgerMarkdown = [
    "# CP4b-A change ledger",
    "",
    "Corrected CP4 is the control. These rows record additive classification and evidence-contract changes; identical old/new semantic signatures mean the displayed schedule was preserved.",
    "",
    "| Profile | Plan | Old readiness | New readiness | Evidence | Completion | Allocation | Rules | Sources | Change | Reason |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...ledgerRows.map(row => `| ${markdownCell(row.profileId)} | ${markdownCell(row.planId)} | ${row.previous.readinessStatus} | ${row.current.readinessStatus} | ${row.current.evidenceStatus} | ${row.current.completionStatus} | ${markdownCell(row.allocationId)} | ${markdownCell(row.controllingRuleIds.join(", "))} | ${markdownCell(row.sourceReferences.join(", "))} | ${row.changeClassification} | ${markdownCell(row.reason)} |`),
    ""
  ].join("\n");

  const catalogRows = profiles.map(profile => {
    const applicability = profile.catalogApplicability || {};
    const candidates = applicability.candidateCatalogYears || [];
    const evaluated = applicability.evaluatedCatalogYears || [];
    return {
      profileId: profile.profileId,
      confirmedMajorDeclarationCatalogYear: profile.catalogAnalysis?.confirmedMajorDeclarationCatalogYear || null,
      inferredEntryYear: profile.catalogAnalysis?.inferredEntryYear || null,
      possibleGoverningDeclarationCatalogYears: candidates,
      catalogApplicabilityStatus: applicability.status || "UNAVAILABLE",
      materialOutcomeDifference: applicability.status === "EXACT" ? "NOT_INDICATED" : "UNKNOWN_UNTIL_AUTHORITATIVE_RELEASES_ARE_AVAILABLE",
      differingRuleFamilies: applicability.status === "EXACT" ? [] : ["REQUIREMENTS", "PREREQUISITES", "EQUIVALENCIES"],
      missingAuthoritativeSources: candidates.filter(year => !evaluated.includes(year)),
      fieldsNeededFromStudentOrAdvisor: applicability.status === "EXACT" ? [] : ["majorDeclarationCatalogYear"],
      cp4bBRecommendation: applicability.status === "EXACT"
        ? "Use the supplied declaration year and matching authoritative release."
        : "Obtain the declaration year, validate each candidate release and its sources, then activate only an owner-approved deterministic bundle."
    };
  });
  const catalogCounts = countBy(catalogRows, row => row.catalogApplicabilityStatus);
  const catalogArtifact = {
    schemaVersion: 1,
    kind: "cp4b-a-catalog-applicability-analysis",
    cohort: { id: "corrected-cp4-frozen-368", profiles: catalogRows.length },
    statuses: catalogCounts,
    intakeRecommendation: {
      field: "majorDeclarationCatalogYear",
      requiredOption: "I do not know",
      rationale: "Entry year is not authoritative evidence of the Economics major declaration catalog year."
    },
    cp4bBRecommendation: "Ingest and source-validate only the candidate historical releases identified here; compare material outcomes before owner-approved activation.",
    rows: catalogRows
  };
  const catalogMarkdown = [
    "# CP4b-A catalog applicability analysis",
    "",
    `Frozen profiles: ${catalogRows.length}. Statuses: ${Object.entries(catalogCounts).map(([key, value]) => `${key}=${value}`).join(", ")}.`,
    "",
    "Recommendation: add `majorDeclarationCatalogYear` with an explicit `I do not know` option in CP8. CP4b-B must ingest and validate only authoritative candidate releases; CP4b-A does not activate a historical catalog.",
    "",
    "| Profile | Confirmed declaration year | Inferred entry year | Candidate years | Status | Missing sources | Needed field | CP4b-B recommendation |",
    "|---|---|---|---|---|---|---|---|",
    ...catalogRows.map(row => `| ${markdownCell(row.profileId)} | ${markdownCell(row.confirmedMajorDeclarationCatalogYear || "not supplied")} | ${markdownCell(row.inferredEntryYear)} | ${markdownCell(row.possibleGoverningDeclarationCatalogYears.join(", "))} | ${row.catalogApplicabilityStatus} | ${markdownCell(row.missingAuthoritativeSources.join(", "))} | ${markdownCell(row.fieldsNeededFromStudentOrAdvisor.join(", "))} | ${markdownCell(row.cp4bBRecommendation)} |`),
    ""
  ].join("\n");

  await Promise.all([
    writeJson(path.join(ROOT, "data/review/cp4b-a-change-ledger.json"), ledger),
    writeFile(path.join(ROOT, "docs/architecture/cp4b-a-change-ledger.md"), ledgerMarkdown, "utf8"),
    writeJson(path.join(ROOT, "data/review/cp4b-a-catalog-applicability-analysis.json"), catalogArtifact),
    writeFile(path.join(ROOT, "docs/architecture/cp4b-a-catalog-applicability-analysis.md"), catalogMarkdown, "utf8")
  ]);
}

function profileReadiness(profile) {
  const statuses = new Set((profile.decisionShadow || []).map(record => record.readinessStatus));
  if (statuses.has("ADVISOR_ACTION_REQUIRED")) return "ADVISOR_ACTION_REQUIRED";
  if (statuses.has("READY_WITH_CONDITIONS")) return "READY_WITH_CONDITIONS";
  if (statuses.has("STUDENT_READY")) return "STUDENT_READY";
  return "NOT_READY";
}

function profileCompletion(profile) {
  return (profile.decisionShadow || []).some(record => record.completionStatus === "COMPLETE") ? "COMPLETE" : "NO_COMPLETE_PLAN";
}

function evidenceRuleCount(profile, ruleId) {
  return (profile.evidenceFindings || []).filter(finding => finding.ruleIds?.includes(ruleId)).length;
}

function noPlanBlockingRules(profile) {
  const rules = [
    ...(profile.planningGaps || []).map(gap => gap.code || gap.reason || gap.message),
    ...(profile.noPlan?.searchAttempts || []).map(attempt => attempt.failure),
    ...(profile.noPlan?.candidateOutcomes || []).map(outcome => outcome.reasonCode || outcome.status)
  ].filter(Boolean);
  return [...new Set(rules)].sort();
}

async function writeCp4bBArtifacts(summary) {
  const baseline = JSON.parse(await readFile(path.join(ROOT, "test-results/cp4b-a-final-frozen.json"), "utf8"));
  const baselineByProfile = new Map(baseline.profiles.map(profile => [profile.profileId, profile]));
  const profiles = [...summary.profiles].sort((left, right) => left.profileId.localeCompare(right.profileId));
  const reviewRuleId = "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE";
  const changeRows = profiles.map(profile => {
    const previous = baselineByProfile.get(profile.profileId);
    const oldReadiness = previous ? profileReadiness(previous) : "NOT_MEASURED";
    const newReadiness = profileReadiness(profile);
    const oldCompletion = previous ? profileCompletion(previous) : "NOT_MEASURED";
    const newCompletion = profileCompletion(profile);
    const oldSignatures = previous?.planSignatures || [];
    const newSignatures = profile.planSignatures || [];
    const oldFalseReviews = previous ? evidenceRuleCount(previous, reviewRuleId) : 0;
    const newFalseReviews = evidenceRuleCount(profile, reviewRuleId);
    const falseReviewsRemoved = Math.max(0, oldFalseReviews - newFalseReviews);
    const applicability = profile.catalogApplicability || {};
    const changeClassifications = [];
    if (oldReadiness !== newReadiness && ["STUDENT_READY", "READY_WITH_CONDITIONS"].includes(newReadiness)) changeClassifications.push(newReadiness === "STUDENT_READY" ? "ready-plan-gain" : "conditional-plan-gain");
    if (falseReviewsRemoved) changeClassifications.push("false-review-removal");
    if (previous?.catalogApplicability?.status !== applicability.status) changeClassifications.push("catalog-correction");
    if (profile.inputResolution?.status === "RESOLVED_WITH_AUTHORIZED_DEFAULT") changeClassifications.push("input-recovery");
    if (oldCompletion === "COMPLETE" && newCompletion !== "COMPLETE") changeClassifications.push("regression");
    return {
      profileId: profile.profileId,
      oldReadiness,
      newReadiness,
      oldCompletionStatus: oldCompletion,
      newCompletionStatus: newCompletion,
      oldPlanSignatures: oldSignatures,
      newPlanSignatures: newSignatures,
      submittedDeclarationYear: profile.catalogAnalysis?.submittedMajorDeclarationCatalogYear || null,
      originalCatalogYear: applicability.originalCatalogYear || null,
      candidateCatalogYears: applicability.candidateCatalogYears || [],
      evaluatedCatalogYears: applicability.evaluatedCatalogYears || [],
      appliedCatalogYear: applicability.appliedMajorCatalogYear || null,
      latestAvailableCatalogYear: applicability.latestAvailableCatalogYear || null,
      oldCatalogApplicabilityStatus: previous?.catalogApplicability?.status || "NOT_MEASURED",
      newCatalogApplicabilityStatus: applicability.status || "CATALOG_UNAVAILABLE",
      catalogDifferences: applicability.materialDifferences || [],
      controllingRuleIds: [...new Set([
        ...(applicability.ruleIds || []),
        ...(profile.evidenceFindings || []).flatMap(finding => finding.ruleIds || [])
      ])].sort(),
      sourceReferences: [...new Set([
        ...(applicability.sourceRefs || []),
        ...(profile.evidenceFindings || []).flatMap(finding => finding.sourceRefs || [])
      ])].sort(),
      advisorNotice: applicability.advisorNotice || null,
      oldEquivalencyScopeFindings: oldFalseReviews,
      newEquivalencyScopeFindings: newFalseReviews,
      falseEquivalencyReviewsRemoved: falseReviewsRemoved,
      ordinaryHanoverCourseEvidence: profile.ordinaryHanoverCourseEvidence || [],
      exactReasonForChange: falseReviewsRemoved
        ? "Ordinary completed or in-progress coursework has a canonical Hanover course identity; unresolved transfer/equivalency evidence remains review-dependent."
        : "The owner-approved latest-flexible catalog rule supplies a disclosed conditional planning basis without fabricating a declaration year.",
      changeClassifications: [...new Set(changeClassifications)].sort()
    };
  });
  const completeLosses = changeRows.filter(row => row.oldCompletionStatus === "COMPLETE" && row.newCompletionStatus !== "COMPLETE");
  invariant(!completeLosses.length, "CP4B_B_COMPLETE_INCUMBENT_LOSS", `Previously complete profiles lost all incumbents: ${completeLosses.map(row => row.profileId).join(", ")}`);
  const falseReviewsBefore = changeRows.reduce((sum, row) => sum + row.oldEquivalencyScopeFindings, 0);
  const falseReviewsAfter = changeRows.reduce((sum, row) => sum + row.newEquivalencyScopeFindings, 0);
  const catalogLedger = {
    schemaVersion: 1,
    kind: "cp4b-b-catalog-readiness-change-ledger",
    baseline: {artifact: "test-results/cp4b-a-final-frozen.json", commit: "fb5450fc52f979de26a0148543b679718830dfa6"},
    policyRuleId: "CATALOG-LATEST-FLEXIBLE-MAJOR-FALLBACK",
    advisorNoticeReasonCode: "LATEST_FLEXIBLE_MAJOR_RULES_APPLIED",
    counts: {
      profiles: changeRows.length,
      changedProfiles: changeRows.filter(row => row.changeClassifications.length).length,
      completeIncumbentLosses: completeLosses.length,
      falseEquivalencyReviewsBefore: falseReviewsBefore,
      falseEquivalencyReviewsAfter: falseReviewsAfter,
      falseEquivalencyReviewsRemoved: falseReviewsBefore - falseReviewsAfter,
      readinessBefore: countBy(changeRows, row => row.oldReadiness),
      readinessAfter: countBy(changeRows, row => row.newReadiness),
      catalogStatusBefore: countBy(changeRows, row => row.oldCatalogApplicabilityStatus),
      catalogStatusAfter: countBy(changeRows, row => row.newCatalogApplicabilityStatus),
      profilesHelpedByPsy217: 0,
      profilesHelpedByBusn323: 0,
      profilesHelpedByComprehensiveEvaluationRemoval: 0
    },
    rows: changeRows
  };
  const catalogMarkdown = [
    "# CP4b-B catalog and readiness change ledger",
    "",
    `Frozen profiles: ${changeRows.length}. Complete incumbent losses: ${completeLosses.length}. False equivalency-scope findings: ${falseReviewsBefore} before, ${falseReviewsAfter} after, ${falseReviewsBefore - falseReviewsAfter} removed.`,
    "",
    `Readiness before: ${Object.entries(catalogLedger.counts.readinessBefore).map(([key, value]) => `${key}=${value}`).join(", ")}.`,
    `Readiness after: ${Object.entries(catalogLedger.counts.readinessAfter).map(([key, value]) => `${key}=${value}`).join(", ")}.`,
    "",
    "The frozen cohort already planned under 2025-2026 requirements, so PSY 217, BUSN 323, and comprehensive-evaluation changes produce zero new complete schedules in this cohort; that zero is not described as achieving final coverage.",
    "",
    "| Profile | Old readiness | New readiness | Completion | Catalog status | Applied catalog | Differences | False reviews removed | Change |",
    "|---|---|---|---|---|---|---|---:|---|",
    ...changeRows.map(row => `| ${markdownCell(row.profileId)} | ${row.oldReadiness} | ${row.newReadiness} | ${row.oldCompletionStatus} -> ${row.newCompletionStatus} | ${row.newCatalogApplicabilityStatus} | ${markdownCell(row.appliedCatalogYear)} | ${markdownCell(row.catalogDifferences.map(item => item.code).join(", "))} | ${row.falseEquivalencyReviewsRemoved} | ${markdownCell(row.changeClassifications.join(", "))} |`),
    ""
  ].join("\n");

  const invalidRows = profiles.filter(profile => baselineByProfile.get(profile.profileId)?.noPlan?.reason === "INVALID_INPUT").map(profile => ({
    profileId: profile.profileId,
    previousCategory: "INVALID_INPUT",
    currentNoPlanCategory: profile.noPlan?.reason || null,
    ...profile.inputResolution,
    oneStudentAnswerCouldUnblock: profile.inputResolution?.answerCount === 1,
    severalAnswersNeeded: profile.inputResolution?.answerCount > 1,
    provisionalPlanPossible: Boolean(profile.inputResolution?.planningCanContinueConditionally),
    missingCatalogYearIsOnlyBlocker: Boolean(profile.inputResolution?.missingCatalogYearIsOnlyBlocker),
    rescuedByLatestFlexibleFallback: profile.noPlan?.reason !== "INVALID_INPUT" && profile.inputResolution?.latestFlexibleFallbackEligible
  }));
  invariant(invalidRows.length === 93, "CP4B_B_INVALID_INPUT_BASELINE", `Expected 93 invalid-input profiles, found ${invalidRows.length}.`);
  const invalidReport = {
    schemaVersion: 1,
    kind: "cp4b-b-invalid-input-recovery-report",
    counts: {
      baselineInvalidProfiles: invalidRows.length,
      trulyInvalidProfiles: invalidRows.filter(row => row.status === "TRULY_INVALID").length,
      recoverableWithOneAnswer: invalidRows.filter(row => row.oneStudentAnswerCouldUnblock).length,
      recoverableWithSeveralAnswers: invalidRows.filter(row => row.severalAnswersNeeded).length,
      eligibleForConditionalPlanning: invalidRows.filter(row => row.planningCanContinueConditionally).length,
      rescuedByLatestFlexibleFallback: invalidRows.filter(row => row.rescuedByLatestFlexibleFallback).length,
      remainBlocked: invalidRows.filter(row => row.planningMustRemainBlocked).length,
      blockingFields: countBy(invalidRows.flatMap(row => row.blockingFields || []), value => value)
    },
    rows: invalidRows
  };
  const invalidMarkdown = [
    "# CP4b-B invalid-input recovery report",
    "",
    `Baseline invalid profiles: ${invalidRows.length}. One-answer recoverable: ${invalidReport.counts.recoverableWithOneAnswer}. Several-answer recoverable: ${invalidReport.counts.recoverableWithSeveralAnswers}. Truly invalid: ${invalidReport.counts.trulyInvalidProfiles}. Remain blocked pending answers: ${invalidReport.counts.remainBlocked}.`,
    "",
    "| Profile | Classification | Blocking fields | Questions | Conditional planning | Advisor action | Blocked |",
    "|---|---|---|---|---|---|---|",
    ...invalidRows.map(row => `| ${markdownCell(row.profileId)} | ${row.status} | ${markdownCell((row.blockingFields || []).join(", "))} | ${markdownCell((row.questions || []).map(item => item.prompt).join("; "))} | ${row.planningCanContinueConditionally} | ${row.advisorActionRequired} | ${row.planningMustRemainBlocked} |`),
    ""
  ].join("\n");

  const fullRows = profiles.flatMap(profile => (profile.fullEnrollmentEvidence || []).map(row => ({profileId: profile.profileId, ...row})));
  const affectedFullProfiles = new Set(fullRows.map(row => row.profileId));
  const affectedFullPlans = new Set(fullRows.map(row => `${row.profileId}|${row.planId}`));
  const optionAEligibleProfiles = new Set(fullRows.filter(row => !row.noAlternative).map(row => row.profileId));
  const optionCBlockedProfiles = new Set(fullRows.filter(row => row.noAlternative).map(row => row.profileId));
  const currentReadiness = summary.metrics.completion.shadowDecision.profilesByReadiness;
  const readinessByProfile = new Map(profiles.map(profile => [profile.profileId, profileReadiness(profile)]));
  const optionAConvertedProfiles = new Set([...optionAEligibleProfiles].filter(profileId => (
    readinessByProfile.get(profileId) === "ADVISOR_ACTION_REQUIRED"
  )));
  const optionCNewlyBlockedProfiles = new Set([...optionCBlockedProfiles].filter(profileId => (
    readinessByProfile.get(profileId) !== "NOT_READY"
  )));
  const fullPacket = {
    schemaVersion: 1,
    kind: "cp4b-b-full-policy-decision-packet",
    productionPolicy: {ruleId: "SCHEDULE-AVAILABILITY-BEHAVIOR", FULL: "REVIEW_REQUIRED", changed: false},
    counts: {affectedProfiles: affectedFullProfiles.size, affectedPlans: affectedFullPlans.size, evidenceRows: fullRows.length},
    rows: fullRows,
    options: [
      {
        id: "A",
        policy: "FULL_READY_WITH_CONDITIONS_ONLY_WITH_IDENTIFIED_ALTERNATIVE",
        eligibleProfiles: optionAEligibleProfiles.size,
        projectedStudentReadyProfiles: currentReadiness.STUDENT_READY,
        projectedReadyWithConditionsProfiles: currentReadiness.READY_WITH_CONDITIONS + optionAConvertedProfiles.size,
        projectedAdvisorActionRequiredProfiles: currentReadiness.ADVISOR_ACTION_REQUIRED - optionAConvertedProfiles.size,
        projectedBlockedProfiles: currentReadiness.NOT_READY,
        academicRisks: ["A seat or backup pathway may still fail."],
        operationalRisks: ["Alternative evidence must remain current and plan-specific."],
        requiredEvidence: ["WAITLIST_OR_VERIFIED_SECTION_OR_VALID_TERM_OR_BACKUP_PATHWAY"]
      },
      {
        id: "B",
        policy: "FULL_ADVISOR_ACTION_REQUIRED_CURRENT_RULE",
        projectedStudentReadyProfiles: currentReadiness.STUDENT_READY,
        projectedReadyWithConditionsProfiles: currentReadiness.READY_WITH_CONDITIONS,
        projectedAdvisorActionRequiredProfiles: currentReadiness.ADVISOR_ACTION_REQUIRED,
        projectedBlockedProfiles: currentReadiness.NOT_READY,
        academicRisks: ["Advisor workload remains for full sections."],
        operationalRisks: ["Resolution occurs outside automatic planning."],
        requiredEvidence: ["ADVISOR_OR_DEPARTMENT_ENROLLMENT_RESOLUTION"]
      },
      {
        id: "C",
        policy: "FULL_BLOCK_ONLY_WHEN_DEFINITELY_UNAVAILABLE_WITH_NO_ALTERNATIVE",
        noAlternativeProfiles: optionCBlockedProfiles.size,
        projectedStudentReadyProfiles: currentReadiness.STUDENT_READY,
        projectedReadyWithConditionsProfiles: Math.max(0, currentReadiness.READY_WITH_CONDITIONS - [...optionCNewlyBlockedProfiles].filter(profileId => readinessByProfile.get(profileId) === "READY_WITH_CONDITIONS").length),
        projectedAdvisorActionRequiredProfiles: Math.max(0, currentReadiness.ADVISOR_ACTION_REQUIRED - [...optionCNewlyBlockedProfiles].filter(profileId => readinessByProfile.get(profileId) === "ADVISOR_ACTION_REQUIRED").length),
        projectedBlockedProfiles: currentReadiness.NOT_READY + optionCNewlyBlockedProfiles.size,
        academicRisks: ["Incomplete alternative evidence could incorrectly block a viable plan."],
        operationalRisks: ["Requires exhaustive section, term, option, allocation, and backup checks."],
        requiredEvidence: ["DEFINITE_UNAVAILABILITY", "EXHAUSTIVE_NO_ALTERNATIVE_EVIDENCE"]
      }
    ],
    recommendation: {
      option: "B",
      reason: "Keep the current review-required rule until the owner separately approves a new rule and the schedule provides complete alternative and waitlist evidence."
    }
  };
  for (const option of fullPacket.options) {
    const projectedTotal = option.projectedStudentReadyProfiles
      + option.projectedReadyWithConditionsProfiles
      + option.projectedAdvisorActionRequiredProfiles
      + option.projectedBlockedProfiles;
    invariant(
      projectedTotal === profiles.length,
      "CP4B_B_FULL_PROJECTION_TOTAL",
      `FULL option ${option.id} projects ${projectedTotal} profiles instead of ${profiles.length}.`
    );
  }
  const fullMarkdown = [
    "# CP4b-B FULL enrollment owner-decision packet",
    "",
    `Production remains FULL -> REVIEW_REQUIRED. Affected frozen profiles: ${affectedFullProfiles.size}; plans: ${affectedFullPlans.size}; evidence rows: ${fullRows.length}.`,
    "",
    "Recommendation: Option B, keep the current rule. No new FULL rule is activated in CP4b-B.",
    "",
    "| Profile | Plan | Course | Term | Section | Waitlist | Other section | Other term | Requirement option | Allocation | Backup plan | No alternative |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...fullRows.map(row => `| ${markdownCell(row.profileId)} | ${markdownCell(row.planId)} | ${markdownCell(row.course)} | ${markdownCell(row.term)} | ${markdownCell(row.section)} | ${row.waitlistExists} | ${row.anotherVerifiedSectionExists} | ${row.anotherValidTermExists} | ${row.anotherValidRequirementOptionExists} | ${row.alternativeRequirementAllocationExists} | ${row.backupCompletePlanExists} | ${row.noAlternative} |`),
    ""
  ].join("\n");

  const noPlanRows = profiles.filter(profile => profile.plans === 0).map(profile => {
    const reason = profile.noPlan?.reason || "UNEXPLAINED";
    const input = profile.inputResolution || {};
    const text = JSON.stringify({gaps: profile.planningGaps, outcomes: profile.candidateOutcomes});
    const mechanisms = {
      latestFlexibleCatalogPolicy: false,
      psy217: /PSY 217/.test(text),
      busn323: /BUSN 323/.test(text),
      comprehensiveEvaluationRemoval: false,
      falseEvidenceReviewRemoval: false,
      oneAdditionalStudentAnswer: input.answerCount === 1,
      severalAdditionalStudentAnswers: input.answerCount > 1,
      departmentApproval: /department|approval/i.test(text),
      instructorApproval: /instructor|concurrent math/i.test(text),
      alternativeRequirementAllocation: Boolean(profile.allocationAlternatives?.multipleValidAllocations),
      tbcOrdering: /TBC|precedence/i.test(text),
      futureFullRule: false,
      cp5SearchPortfolio: reason === "SEARCH_INCOMPLETE",
      noCurrentlyApprovedMechanism: ["COUNT_CAPACITY", "NO_COMPLETE_ASSIGNMENT"].includes(reason)
    };
    const rescueStatus = reason === "INVALID_INPUT"
      ? "POTENTIALLY_RESCUABLE_WITH_INPUT"
      : reason === "SEARCH_INCOMPLETE"
        ? "POTENTIALLY_RESCUABLE_BY_CP5"
        : reason === "POLICY_REVIEW_REQUIRED"
          ? "POLICY_REVIEW_REQUIRED"
          : profile.noPlan?.conclusion === "PROVEN_INFEASIBLE"
            ? "INFEASIBLE_PROVEN"
            : "CURRENTLY_NO_APPROVED_RESCUE";
    return {
      profileId: profile.profileId,
      currentNoPlanCategory: reason,
      currentConclusion: profile.noPlan?.conclusion || "UNKNOWN",
      exactBlockingRules: noPlanBlockingRules(profile),
      missingInputs: input.blockingFields || [],
      catalogIssue: profile.catalogApplicability?.status || null,
      allocationIssue: profile.noPlan?.reason === "NO_COMPLETE_ASSIGNMENT",
      prerequisiteIssue: /prerequisite/i.test(text),
      capacityIssue: reason === "COUNT_CAPACITY",
      scheduleIssue: /offering|schedule/i.test(text),
      tbcIssue: /TBC|precedence/i.test(text),
      searchLimitIssue: reason === "SEARCH_INCOMPLETE",
      approvalIssue: /approval/i.test(text),
      evidenceIssue: false,
      rescueMechanisms: mechanisms,
      rescueStatus
    };
  });
  invariant(noPlanRows.length === 182, "CP4B_B_NO_PLAN_BASELINE", `Expected 182 no-plan profiles, found ${noPlanRows.length}.`);
  const noPlanReasonCounts = countBy(noPlanRows, row => row.currentNoPlanCategory);
  invariant(noPlanReasonCounts.INVALID_INPUT === 93 && noPlanReasonCounts.COUNT_CAPACITY === 57
    && noPlanReasonCounts.NO_COMPLETE_ASSIGNMENT === 20 && noPlanReasonCounts.SEARCH_INCOMPLETE === 12,
  "CP4B_B_NO_PLAN_GROUP_DRIFT", `No-plan baseline groups changed: ${JSON.stringify(noPlanReasonCounts)}`);
  const rescueLedger = {
    schemaVersion: 1,
    kind: "cp4b-b-no-plan-rescue-ledger",
    counts: {profiles: noPlanRows.length, currentCategories: noPlanReasonCounts, rescueStatuses: countBy(noPlanRows, row => row.rescueStatus)},
    rows: noPlanRows
  };
  const rescueMarkdown = [
    "# CP4b-B no-plan rescue ledger",
    "",
    `No-plan profiles: ${noPlanRows.length}. Categories: ${Object.entries(noPlanReasonCounts).map(([key, value]) => `${key}=${value}`).join(", ")}.`,
    "",
    "Search-incomplete rows are explicitly potential CP5 rescues; none is labeled proven infeasible.",
    "",
    "| Profile | Category | Conclusion | Rescue status | Missing inputs | Blocking rules | CP5 | No approved mechanism |",
    "|---|---|---|---|---|---|---|---|",
    ...noPlanRows.map(row => `| ${markdownCell(row.profileId)} | ${row.currentNoPlanCategory} | ${row.currentConclusion} | ${row.rescueStatus} | ${markdownCell(row.missingInputs.join(", "))} | ${markdownCell(row.exactBlockingRules.join(", "))} | ${row.rescueMechanisms.cp5SearchPortfolio} | ${row.rescueMechanisms.noCurrentlyApprovedMechanism} |`),
    ""
  ].join("\n");

  await Promise.all([
    writeJson(path.join(ROOT, "data/review/cp4b-b-catalog-readiness-change-ledger.json"), catalogLedger),
    writeFile(path.join(ROOT, "docs/architecture/cp4b-b-catalog-readiness-change-ledger.md"), catalogMarkdown, "utf8"),
    writeJson(path.join(ROOT, "data/review/cp4b-b-invalid-input-recovery-report.json"), invalidReport),
    writeFile(path.join(ROOT, "docs/architecture/cp4b-b-invalid-input-recovery-report.md"), invalidMarkdown, "utf8"),
    writeJson(path.join(ROOT, "data/review/cp4b-b-full-policy-decision-packet.json"), fullPacket),
    writeFile(path.join(ROOT, "docs/architecture/cp4b-b-full-policy-decision-packet.md"), fullMarkdown, "utf8"),
    writeJson(path.join(ROOT, "data/review/cp4b-b-no-plan-rescue-ledger.json"), rescueLedger),
    writeFile(path.join(ROOT, "docs/architecture/cp4b-b-no-plan-rescue-ledger.md"), rescueMarkdown, "utf8")
  ]);
}

function followupOutcomeChanged(previous, current) {
  return Number(previous?.plans || 0) !== Number(current?.plans || 0)
    || profileCompletion(previous) !== profileCompletion(current)
    || profileReadiness(previous) !== profileReadiness(current)
    || (previous?.noPlan?.reason || null) !== (current?.noPlan?.reason || null)
    || JSON.stringify(previous?.planSignatures || []) !== JSON.stringify(current?.planSignatures || [])
    || previous?.catalogApplicability?.status !== current?.catalogApplicability?.status;
}

function followupAttribution(previous, current) {
  const seniorStanding = previous?.noPlan?.reason === "INVALID_INPUT"
    || current?.studentNoticeCodes?.includes("ACCELERATED_PLAN_SENIOR_STANDING_ASSUMED");
  const futureSchedules = Boolean(current?.planningProjectionPlanCount)
    && JSON.stringify(previous?.planSignatures || []) !== JSON.stringify(current?.planSignatures || []);
  const flexibleCatalog = previous?.catalogApplicability?.status !== current?.catalogApplicability?.status
    || current?.advisorNotificationCodes?.some(code => code.startsWith("FLEXIBLE_MAJOR_REQUIREMENTS_"));
  const mechanisms = [
    seniorStanding ? "SENIOR_STANDING" : null,
    futureSchedules ? "FUTURE_SCHEDULES" : null,
    flexibleCatalog ? "FLEXIBLE_CATALOG" : null
  ].filter(Boolean);
  const key = mechanisms.length
    ? mechanisms.join("+")
    : followupOutcomeChanged(previous, current) ? "UNRELATED_DRIFT" : "NO_OUTCOME_CHANGE";
  return {mechanisms, key};
}

function followupRow(previous, current) {
  const attribution = followupAttribution(previous, current);
  const oldCompletion = profileCompletion(previous);
  const newCompletion = profileCompletion(current);
  const oldReadiness = profileReadiness(previous);
  const newReadiness = profileReadiness(current);
  const oldStrategyConvergences = previous?.strategyConvergences || [];
  const newStrategyConvergences = current?.strategyConvergences || [];
  const convergenceChanged = JSON.stringify(oldStrategyConvergences) !== JSON.stringify(newStrategyConvergences);
  const classifications = [
    attribution.mechanisms.length ? "INTENDED_CORRECTION" : null,
    Number(previous?.plans || 0) === 0 && Number(current?.plans || 0) > 0 ? "COVERAGE_GAIN" : null,
    oldReadiness !== newReadiness ? "READINESS_CORRECTION" : null,
    oldCompletion === "COMPLETE" && newCompletion !== "COMPLETE" ? "REGRESSION" : null,
    attribution.mechanisms.length > 1 ? "OVERLAP" : null,
    convergenceChanged ? "DUPLICATE_CONVERGENCE_CHANGE" : null,
    attribution.key === "UNRELATED_DRIFT" ? "UNRELATED_DRIFT" : null
  ].filter(Boolean);
  const reasons = [
    attribution.mechanisms.includes("SENIOR_STANDING") ? "Removed the obsolete accelerated-plan senior-standing confirmation gate and recorded the final-year assumption." : null,
    attribution.mechanisms.includes("FUTURE_SCHEDULES") ? "Replaced ordinary unpublished-schedule TBC windows with exact-term planning projections that do not affect readiness." : null,
    attribution.mechanisms.includes("FLEXIBLE_CATALOG") ? "Applied the owner-designated 2025-2026 Economics requirement set and separated SAC administration from academic readiness." : null,
    convergenceChanged ? "Exact-term planning changed whether strategy schedules are semantically distinct; all retained plans remain independently validated." : null,
    attribution.key === "UNRELATED_DRIFT" ? "The outcome changed outside the three approved follow-up mechanisms and requires separate review." : null
  ].filter(Boolean);
  const applicability = current?.catalogApplicability || {};
  return {
    profileId: current.profileId,
    oldPlanCount: Number(previous?.plans || 0),
    newPlanCount: Number(current?.plans || 0),
    oldCompletionStatus: oldCompletion,
    newCompletionStatus: newCompletion,
    oldReadinessStatus: oldReadiness,
    newReadinessStatus: newReadiness,
    oldNoPlanReason: previous?.noPlan?.reason || null,
    newNoPlanReason: current?.noPlan?.reason || null,
    incomingCatalogYear: applicability.studentIncomingCatalogYear || applicability.incomingCatalogYear || null,
    appliedFlexibleRequirementSetYear: applicability.appliedMajorCatalogYear || null,
    materialCatalogDifference: Boolean(applicability.materialDifferences?.length),
    materialCatalogDifferenceCodes: (applicability.materialDifferences || []).map(item => item.code).filter(Boolean),
    sacNotice: current?.advisorNotificationCodes?.includes("FLEXIBLE_MAJOR_REQUIREMENTS_SAC_PETITION_NOTICE") || false,
    unknownIncomingYearNotice: current?.advisorNotificationCodes?.includes("FLEXIBLE_MAJOR_REQUIREMENTS_INCOMING_YEAR_UNKNOWN") || false,
    seniorStandingNotice: current?.studentNoticeCodes?.includes("ACCELERATED_PLAN_SENIOR_STANDING_ASSUMED") || false,
    futureProjectionNotice: current?.studentNoticeCodes?.includes("FUTURE_SCHEDULE_PROJECTION_NOTICE") || false,
    advisorNotificationCodes: current?.advisorNotificationCodes || [],
    substantiveAdvisorActionCount: Number(current?.advisorActionCount || 0),
    oldStrategyConvergences,
    newStrategyConvergences,
    controllingPolicyIds: [...new Set([
      ...(applicability.ruleIds || []),
      ...(current?.decisionShadow || []).flatMap(record => record.ruleIds || [])
    ])].sort(),
    attribution: attribution.key,
    exactReasonForChange: reasons.join(" ") || "No material outcome change.",
    classifications,
    oldPlanSignatures: previous?.planSignatures || [],
    newPlanSignatures: current?.planSignatures || []
  };
}

async function writeCp4bBFollowupArtifacts(summary) {
  const baselinePath = path.join(ROOT, "test-results/cp4b-b-followup-baseline.json");
  const heldoutPath = path.join(ROOT, "test-results/cp4b-b-followup-heldout.json");
  const [baseline, heldout] = await Promise.all([
    readJson(relativeToRoot(baselinePath)),
    readJson(relativeToRoot(heldoutPath))
  ]);
  invariant(baseline.metrics?.profilesTested === 368, "CP4B_B_FOLLOWUP_BASELINE_COUNT", "The saved CP4b-B follow-up baseline must contain 368 profiles.");
  invariant(heldout.metrics?.failureCount === 0, "CP4B_B_FOLLOWUP_HELDOUT_FAILURE", "The held-out cohort must pass before follow-up artifacts are written.");
  const previousById = new Map((baseline.profiles || []).map(profile => [profile.profileId, profile]));
  const currentProfiles = [...(summary.profiles || [])].sort((left, right) => left.profileId.localeCompare(right.profileId));
  const rows = currentProfiles.map(current => {
    const previous = previousById.get(current.profileId);
    invariant(previous, "CP4B_B_FOLLOWUP_PROFILE_MISSING", `Baseline profile ${current.profileId} is missing.`);
    return followupRow(previous, current);
  });
  const baselineInvalidIds = new Set((baseline.profiles || [])
    .filter(profile => profile.noPlan?.reason === "INVALID_INPUT")
    .map(profile => profile.profileId));
  invariant(baselineInvalidIds.size === 93, "CP4B_B_FOLLOWUP_INVALID_BASELINE", `Expected 93 baseline invalid-input profiles, found ${baselineInvalidIds.size}.`);
  const invalidRows = rows.filter(row => baselineInvalidIds.has(row.profileId));
  const completeLosses = rows.filter(row => row.oldCompletionStatus === "COMPLETE" && row.newCompletionStatus !== "COMPLETE");
  invariant(!completeLosses.length, "CP4B_B_FOLLOWUP_COMPLETE_LOSS", `Previously complete profiles lost all complete plans: ${completeLosses.map(row => row.profileId).join(", ")}`);
  const materialDifferenceRows = rows.filter(row => row.materialCatalogDifference);
  const materialMovedOutOfAdvisorAction = materialDifferenceRows.filter(row => (
    row.oldReadinessStatus === "ADVISOR_ACTION_REQUIRED" && row.newReadinessStatus !== "ADVISOR_ACTION_REQUIRED"
  ));
  const counts = {
    profiles: rows.length,
    changedProfiles: rows.filter((row, index) => followupOutcomeChanged(previousById.get(row.profileId), currentProfiles[index])).length,
    attribution: countBy(rows, row => row.attribution),
    classifications: countBy(rows.flatMap(row => row.classifications), value => value),
    plansBefore: baseline.metrics.acceptedPlanCount,
    plansAfter: summary.metrics.acceptedPlanCount,
    planChange: summary.metrics.acceptedPlanCount - baseline.metrics.acceptedPlanCount,
    completePlanProfilesBefore: baseline.metrics.profilesWithPlans,
    completePlanProfilesAfter: summary.metrics.profilesWithPlans,
    completePlanProfileGain: summary.metrics.profilesWithPlans - baseline.metrics.profilesWithPlans,
    completeIncumbentGains: rows.filter(row => row.oldCompletionStatus !== "COMPLETE" && row.newCompletionStatus === "COMPLETE").length,
    completeIncumbentLosses: completeLosses.length,
    readinessBefore: countBy(rows, row => row.oldReadinessStatus),
    readinessAfter: countBy(rows, row => row.newReadinessStatus),
    baselineInvalidProfiles: invalidRows.length,
    baselineInvalidNoLongerInvalid: invalidRows.filter(row => row.newNoPlanReason !== "INVALID_INPUT").length,
    baselineInvalidNowComplete: invalidRows.filter(row => row.newCompletionStatus === "COMPLETE").length,
    baselineInvalidStillWithoutPlanForOtherReason: invalidRows.filter(row => row.newCompletionStatus !== "COMPLETE" && row.newNoPlanReason !== "INVALID_INPUT").length,
    materialDifferenceProfiles: materialDifferenceRows.length,
    materialDifferenceProfilesMovedOutOfAdvisorAction: materialMovedOutOfAdvisorAction.length,
    sacNotificationProfiles: rows.filter(row => row.sacNotice).length,
    unknownIncomingYearNotificationProfiles: rows.filter(row => row.unknownIncomingYearNotice).length,
    substantiveAdvisorActionProfiles: rows.filter(row => row.substantiveAdvisorActionCount > 0).length,
    substantiveAdvisorActions: rows.reduce((sum, row) => sum + row.substantiveAdvisorActionCount, 0)
  };
  const ledger = {
    schemaVersion: 1,
    kind: "cp4b-b-followup-v1-catalog-readiness-change-ledger",
    baseline: {artifact: "test-results/cp4b-b-followup-baseline.json", commit: "dba222e8486778d0fed5adb0867c913437556758"},
    current: {artifact: "test-results/cp4b-b-followup-final-frozen.json", startingCommit: "dba222e8486778d0fed5adb0867c913437556758"},
    ownerDesignatedRequirementSet: "2025-2026",
    policyRuleId: "ECONOMICS-OWNER-DESIGNATED-MOST-FLEXIBLE-REQUIREMENTS",
    counts,
    rows
  };
  const ledgerMarkdown = [
    "# CP4b-B follow-up v1 catalog and readiness ledger",
    "",
    `Profiles: ${counts.profiles}. Complete-plan profiles: ${counts.completePlanProfilesBefore} -> ${counts.completePlanProfilesAfter}. Accepted plans: ${counts.plansBefore} -> ${counts.plansAfter}. Complete incumbent losses: ${counts.completeIncumbentLosses}.`,
    `Readiness before: ${Object.entries(counts.readinessBefore).map(([key, value]) => `${key}=${value}`).join(", ")}.`,
    `Readiness after: ${Object.entries(counts.readinessAfter).map(([key, value]) => `${key}=${value}`).join(", ")}.`,
    `Attribution: ${Object.entries(counts.attribution).map(([key, value]) => `${key}=${value}`).join(", ")}.`,
    "",
    "| Profile | Plans | Completion | Readiness | No-plan reason | Incoming | Applied | SAC | Senior notice | Projection notice | Actions | Attribution |",
    "|---|---:|---|---|---|---|---|---|---|---|---:|---|",
    ...rows.map(row => `| ${markdownCell(row.profileId)} | ${row.oldPlanCount} -> ${row.newPlanCount} | ${row.oldCompletionStatus} -> ${row.newCompletionStatus} | ${row.oldReadinessStatus} -> ${row.newReadinessStatus} | ${markdownCell(row.oldNoPlanReason)} -> ${markdownCell(row.newNoPlanReason)} | ${markdownCell(row.incomingCatalogYear)} | ${markdownCell(row.appliedFlexibleRequirementSetYear)} | ${row.sacNotice} | ${row.seniorStandingNotice} | ${row.futureProjectionNotice} | ${row.substantiveAdvisorActionCount} | ${row.attribution} |`),
    ""
  ].join("\n");

  const invalidReport = {
    schemaVersion: 1,
    kind: "cp4b-b-followup-v1-invalid-input-recovery",
    counts: {
      baselineInvalidProfiles: invalidRows.length,
      noLongerInvalid: counts.baselineInvalidNoLongerInvalid,
      nowComplete: counts.baselineInvalidNowComplete,
      remainWithoutPlanForAnotherReason: counts.baselineInvalidStillWithoutPlanForOtherReason,
      remainInvalid: invalidRows.filter(row => row.newNoPlanReason === "INVALID_INPUT").length
    },
    rows: invalidRows
  };
  const invalidMarkdown = [
    "# CP4b-B follow-up v1 invalid-input recovery",
    "",
    `The saved baseline contained ${invalidRows.length} profiles blocked by the projected-senior-standing confirmation gate. ${counts.baselineInvalidNoLongerInvalid} are no longer invalid; ${counts.baselineInvalidNowComplete} now receive complete plans; ${counts.baselineInvalidStillWithoutPlanForOtherReason} remain without a plan for another classified reason.`,
    "",
    "| Profile | Old reason | New reason | Plans | Completion | Senior notice |",
    "|---|---|---|---:|---|---|",
    ...invalidRows.map(row => `| ${markdownCell(row.profileId)} | ${markdownCell(row.oldNoPlanReason)} | ${markdownCell(row.newNoPlanReason)} | ${row.oldPlanCount} -> ${row.newPlanCount} | ${row.newCompletionStatus} | ${row.seniorStandingNotice} |`),
    ""
  ].join("\n");

  const oldNoPlanIds = new Set((baseline.profiles || []).filter(profile => profile.plans === 0).map(profile => profile.profileId));
  const rescueRows = rows.filter(row => oldNoPlanIds.has(row.profileId)).map(row => ({
    ...row,
    rescueStatus: row.newCompletionStatus === "COMPLETE"
      ? "RESCUED_WITH_COMPLETE_PLAN"
      : row.newNoPlanReason === "SEARCH_INCOMPLETE"
        ? "POTENTIAL_CP5_SEARCH_RESCUE_NOT_STARTED"
        : "NO_COMPLETE_PLAN_AFTER_APPROVED_FOLLOWUP"
  }));
  const rescueLedger = {
    schemaVersion: 1,
    kind: "cp4b-b-followup-v1-no-plan-rescue-ledger",
    counts: {
      baselineNoPlanProfiles: rescueRows.length,
      rescuedWithCompletePlan: rescueRows.filter(row => row.rescueStatus === "RESCUED_WITH_COMPLETE_PLAN").length,
      remainingNoPlanReasons: countBy(rescueRows.filter(row => row.newCompletionStatus !== "COMPLETE"), row => row.newNoPlanReason || "UNCLASSIFIED"),
      rescueStatuses: countBy(rescueRows, row => row.rescueStatus)
    },
    rows: rescueRows
  };
  const rescueMarkdown = [
    "# CP4b-B follow-up v1 no-plan rescue ledger",
    "",
    `Baseline no-plan profiles: ${rescueRows.length}. Rescued with complete plans: ${rescueLedger.counts.rescuedWithCompletePlan}. Remaining reasons: ${Object.entries(rescueLedger.counts.remainingNoPlanReasons).map(([key, value]) => `${key}=${value}`).join(", ")}.`,
    "",
    "| Profile | Old reason | New reason | Plans | Rescue status | Attribution |",
    "|---|---|---|---:|---|---|",
    ...rescueRows.map(row => `| ${markdownCell(row.profileId)} | ${markdownCell(row.oldNoPlanReason)} | ${markdownCell(row.newNoPlanReason)} | ${row.oldPlanCount} -> ${row.newPlanCount} | ${row.rescueStatus} | ${row.attribution} |`),
    ""
  ].join("\n");

  const fullChanged = baseline.metrics.cp4bB?.fullAffectedProfiles !== summary.metrics.cp4bB?.fullAffectedProfiles
    || baseline.metrics.cp4bB?.fullAffectedPlans !== summary.metrics.cp4bB?.fullAffectedPlans;
  const fullReconciliation = {
    schemaVersion: 1,
    kind: "cp4b-b-followup-v1-full-policy-reconciliation",
    policy: {ruleId: "SCHEDULE-AVAILABILITY-BEHAVIOR", fullDisposition: "REVIEW_REQUIRED", changed: false},
    reconciliationChanged: fullChanged,
    baseline: {
      affectedProfiles: baseline.metrics.cp4bB?.fullAffectedProfiles || 0,
      affectedPlans: baseline.metrics.cp4bB?.fullAffectedPlans || 0
    },
    current: {
      affectedProfiles: summary.metrics.cp4bB?.fullAffectedProfiles || 0,
      affectedPlans: summary.metrics.cp4bB?.fullAffectedPlans || 0
    },
    substantiveAdvisorActionProfiles: counts.substantiveAdvisorActionProfiles,
    sourcePacket: "data/review/cp4b-b-full-policy-decision-packet.json"
  };

  const verification = {
    schemaVersion: 1,
    kind: "cp4b-b-followup-v1-verification-summary",
    frozen: {
      selection: summary.selection,
      metrics: summary.metrics,
      failures: summary.failures.length,
      unclassifiedOracleDisagreements: summary.metrics.unclassifiedOracleDisagreementCount,
      unexpectedDecisionEngineDisagreements: summary.metrics.productionDecisionEngine.unexpectedDisagreements
    },
    heldout: {
      selection: heldout.selection,
      metrics: heldout.metrics,
      failures: heldout.failures.length,
      unclassifiedOracleDisagreements: heldout.metrics.unclassifiedOracleDisagreementCount,
      unexpectedDecisionEngineDisagreements: heldout.metrics.productionDecisionEngine.unexpectedDisagreements
    },
    performanceComparison: {
      baseline: {
        totalRuntimeMs: baseline.metrics.totalRuntimeMs,
        profileP50Ms: baseline.metrics.p50ProfileDurationMs,
        profileP95Ms: baseline.metrics.p95ProfileDurationMs,
        profileMaximumMs: baseline.metrics.worstProfileDurationMs,
        decisionEngine: baseline.metrics.productionDecisionEngine.latencyMs
      },
      current: {
        totalRuntimeMs: summary.metrics.totalRuntimeMs,
        profileP50Ms: summary.metrics.p50ProfileDurationMs,
        profileP95Ms: summary.metrics.p95ProfileDurationMs,
        profileMaximumMs: summary.metrics.worstProfileDurationMs,
        decisionEngine: summary.metrics.productionDecisionEngine.latencyMs
      }
    },
    policyCompilation: {
      source: "policy/rules/planning-flexibility.json",
      bundle: "data/compiled/policy/planning-flexibility/econ-planning-flexibility.2/bundle.json",
      digest: "data/compiled/policy/planning-flexibility/econ-planning-flexibility.2/bundle.sha256",
      compileReport: "data/compiled/policy/planning-flexibility/econ-planning-flexibility.2/compile-report.json"
    },
    reportAndPdfParity: {
      contractTests: ["tests/economics-report-parity.test.js", "tests/economics-report.test.js"],
      localPdfVerificationScript: "scripts/verify-economics-pdf.mjs",
      hostedPdfChecksRun: false,
      reason: "The established report verification boundary is local-only for this checkpoint."
    },
    architectureContracts: [
      "data/compiled/policy/planning-flexibility/econ-planning-flexibility.2/architecture-contract.md",
      "policy/rules/planning-flexibility.json"
    ],
    fullPolicyReconciliation: fullReconciliation,
    acceptance: {
      completeIncumbentLosses: counts.completeIncumbentLosses,
      baselineInvalidRemainingInvalid: invalidRows.filter(row => row.newNoPlanReason === "INVALID_INPUT").length,
      catalogSet: "2025-2026",
      catalog2026_2027CreatedOrActivated: false,
      fullPolicyChanged: false,
      legacyRetired: false,
      cp5Started: false
    }
  };
  const heldoutSummary = {
    schemaVersion: 1,
    kind: "cp4b-b-followup-v1-heldout-summary",
    selection: heldout.selection,
    metrics: heldout.metrics,
    noPlan: heldout.noPlan,
    artifactCompleteness: heldout.artifactCompleteness,
    failures: heldout.failures
  };

  await Promise.all([
    writeJson(path.join(ROOT, "data/review/cp4b-b-followup-v1-catalog-readiness-ledger.json"), ledger),
    writeFile(path.join(ROOT, "docs/architecture/cp4b-b-followup-v1-catalog-readiness-ledger.md"), ledgerMarkdown, "utf8"),
    writeJson(path.join(ROOT, "data/review/cp4b-b-followup-v1-invalid-input-recovery.json"), invalidReport),
    writeFile(path.join(ROOT, "docs/architecture/cp4b-b-followup-v1-invalid-input-recovery.md"), invalidMarkdown, "utf8"),
    writeJson(path.join(ROOT, "data/review/cp4b-b-followup-v1-no-plan-rescue-ledger.json"), rescueLedger),
    writeFile(path.join(ROOT, "docs/architecture/cp4b-b-followup-v1-no-plan-rescue-ledger.md"), rescueMarkdown, "utf8"),
    writeJson(path.join(ROOT, "data/review/cp4b-b-followup-v1-full-policy-reconciliation.json"), fullReconciliation),
    writeJson(path.join(ROOT, "data/review/cp4b-b-followup-v1-heldout-summary.json"), heldoutSummary),
    writeJson(path.join(ROOT, "data/review/cp4b-b-followup-v1-verification-summary.json"), verification)
  ]);
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
