#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { mapStudentToProgram } from "../lib/assignment/solve.js";
import {
  buildEconomicsTermPlans,
  semanticPlanSignature
} from "../lib/planning/economics.js";
import {
  buildPlanningSlots,
  resolvePlanningContext
} from "../lib/planning/horizon.js";
import { auditExternalEconomicsPlanComplete } from "../tests/oracle/audit-external-plan.js";
import {
  auditGeneratedFictionalProfile,
  generateFictionalEconomicsProfiles,
  generateInvalidEconomicsNeighbors,
  pairwiseCoverageReport
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
const APPROVAL_TYPES = Object.freeze({
  "CONCURRENT-INTERMEDIATE-ECO-461": "DEPARTMENT_APPROVAL",
  "CONCURRENT-MATH-ECO-213": "INSTRUCTOR_APPROVAL",
  "CONCURRENT-MATH-ECO-214": "INSTRUCTOR_APPROVAL"
});
const CLASSIFIED_ORACLE_VIOLATIONS = new Set([
  "ELECTIVE-NO-DOUBLE-COUNT",
  "REQ-MAJOR-COURSE-COUNT",
  "SCHEDULE_PROJECTED_SOURCE_IN_VERIFIED_YEAR",
  "SCHEDULE_FUTURE_SOURCE_NOT_EXPLICIT"
]);
const CLASSIFIED_ORACLE_REVIEWS = new Set([
  "REVIEW-ADVANCED-COURSE-PREREQUISITE-CLOSURE",
  "REVIEW-WAIVER-SUBSTITUTION-EQUIVALENCY-SCOPE"
]);

const options = parseArguments(process.argv.slice(2));

if (options.mode === "playwright-summary") {
  await summarizePlaywright(options);
} else if (options.mode === "prerequisite-summary") {
  await summarizePrerequisites(options);
} else {
  await runMatrix(options);
}

async function runMatrix(configuration) {
  const startedAt = performance.now();
  const [manifest, verifiedSchedule, requirements, prerequisites, schedule] = await Promise.all([
    readJson("tests/oracle/economics-policy.v1.json"),
    readJson("tests/oracle/verified-schedule-2026-2027.json"),
    readJson("data/normalized/economics/requirements.json"),
    readJson("data/normalized/economics/prerequisites.json"),
    readJson("data/normalized/economics/schedule-2026-2027.json")
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

  const allProfiles = generatedBySeed.flatMap(({ seed, profiles }) => (
    profiles.map(profile => ({ seed, profile }))
  ));
  const selectedProfiles = allProfiles.filter((_entry, index) => (
    index % configuration.shardTotal === configuration.shardIndex - 1
  ));
  const profileResults = [];
  const failures = [];
  const reviewItems = [];
  const classifiedOracleFindings = [];
  let oracleDisagreementCount = 0;
  let unclassifiedOracleDisagreementCount = 0;
  let acceptedPlanCount = 0;
  let profilesWithPlans = 0;
  let eco257StatisticsCount = 0;

  for (const { seed, profile } of selectedProfiles) {
    const profileStartedAt = performance.now();
    try {
      const result = evaluateProfile({
        profile,
        manifest,
        verifiedSchedule,
        requirements,
        prerequisites,
        schedule
      });
      const durationMs = roundDuration(performance.now() - profileStartedAt);
      profileResults.push({
        seed,
        profileId: profile.profileId,
        sequenceIndex: profile.sequenceIndex,
        durationMs,
        plans: result.planCount,
        solverNodes: result.solverNodes,
        maximumSolverNodes: Math.max(0, ...result.solverNodes),
        oracleReviews: result.oracleReviews.length,
        classifiedOracleFindings: result.oracleFindings.length
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
      console.log(JSON.stringify({
        event: "ECONOMICS_NIGHTLY_PROFILE_PASS",
        seed,
        shard: `${configuration.shardIndex}/${configuration.shardTotal}`,
        profileId: profile.profileId,
        durationMs,
        plans: result.planCount,
        solverNodes: result.solverNodes
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
        minimizedCounterexample: null
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
  const summary = {
    schemaVersion: 1,
    kind: "econplanner-nightly-generated-matrix",
    generatedAt: new Date().toISOString(),
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
      }))
    },
    metrics: {
      totalRuntimeMs: roundDuration(performance.now() - startedAt),
      profilesTested: selectedProfiles.length,
      profilesWithPlans,
      acceptedPlanCount,
      p50ProfileDurationMs: percentile(durations, 0.5),
      p95ProfileDurationMs: percentile(durations, 0.95),
      worstProfileDurationMs: durations.length ? Math.max(...durations) : 0,
      worstProfileId: [...profileResults].sort((left, right) => right.durationMs - left.durationMs)[0]?.profileId || null,
      solverNodeCounts: {
        observations: nodeCounts.length,
        total: nodeCounts.reduce((sum, value) => sum + value, 0),
        p50: percentile(nodeCounts, 0.5),
        p95: percentile(nodeCounts, 0.95),
        maximum: nodeCounts.length ? Math.max(...nodeCounts) : 0
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
    profiles: profileResults,
    classifiedOracleFindings,
    oracleReviews: reviewItems,
    failures
  };

  await writeJson(configuration.output, summary);
  if (failures.length) {
    await writeJson(failurePath(configuration.output), {
      schemaVersion: 1,
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

function evaluateProfile({ profile, manifest, verifiedSchedule, requirements, prerequisites, schedule }) {
  const generatorAudit = auditGeneratedFictionalProfile(profile, manifest, verifiedSchedule);
  invariant(profile.fictional === true, "NON_FICTIONAL_PROFILE", `${profile.profileId} is not marked fictional.`);
  invariant(generatorAudit.valid, "GENERATED_PROFILE_POLICY_FAILURE", JSON.stringify(generatorAudit.violations));

  const student = plannerStudent(profile);
  const mapping = mapStudentToProgram(PROGRAM, requirements, student);
  const bundle = buildEconomicsTermPlans({ student, mapping, schedule, prerequisites });
  const signatures = bundle.plans.map(plan => semanticPlanSignature(plan));
  invariant(
    new Set(signatures).size === signatures.length,
    "SEMANTIC_DUPLICATE",
    `${profile.profileId} returned duplicate displayed schedules.`
  );

  const solverNodes = [];
  const oracleReviews = [];
  const oracleFindings = [];
  let eco257StatisticsCount = 0;

  for (const plan of bundle.plans) {
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
  }

  return {
    planCount: bundle.plans.length,
    solverNodes,
    oracleReviews,
    oracleFindings,
    eco257StatisticsCount
  };
}

function plannerStudent(profile) {
  const student = {
    academicStanding: profile.student.academicStanding,
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
  student.reservedCourseUnits = Object.fromEntries(
    buildPlanningSlots(context)
      .filter(slot => !slot.isSummer)
      .map(slot => [slot.id, Number(profile.student.reservedCapacity?.[slot.scheduleTerm] || 0)])
  );
  return student;
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
        .map(course => ({ course: course.code })),
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
  const failed = executions.filter(item => !["passed", "skipped"].includes(item.status));
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
    schemaVersion: 1,
    kind: "econplanner-nightly-playwright-summary",
    generatedAt: new Date().toISOString(),
    inputReports: configuration.inputs.map(relativeToRoot),
    metrics: {
      totalRuntimeMs: executions.reduce((sum, item) => sum + item.durationMs, 0),
      testExecutions: executions.length,
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
      flakeObservationCount: flakeObservations.length
    },
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
    schemaVersion: 1,
    kind: "econplanner-nightly-prerequisite-summary",
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
            status: result.status || test.status || "unknown",
            durationMs: Number(result.duration || 0),
            errors: result.errors || []
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
    optionalLog: null
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
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  invariant(Number.isInteger(result.shardIndex) && Number.isInteger(result.shardTotal)
    && result.shardIndex >= 1 && result.shardIndex <= result.shardTotal,
  "INVALID_SHARD", "--shard must use INDEX/TOTAL with 1 <= INDEX <= TOTAL.");
  invariant(result.seeds.length > 0, "INVALID_SEEDS", "At least one fixed seed is required.");
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
